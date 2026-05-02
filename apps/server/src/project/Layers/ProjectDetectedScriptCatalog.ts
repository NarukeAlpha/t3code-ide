import fsPromises from "node:fs/promises";

import type {
  DetectedProjectScript,
  DetectedProjectScriptSource,
  ListDetectedProjectScriptsResult,
} from "@t3tools/contracts";
import { Effect, Layer, Path } from "effect";

import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  ProjectDetectedScriptCatalog,
  ProjectDetectedScriptCatalogError,
  type ProjectDetectedScriptCatalogShape,
} from "../Services/ProjectDetectedScriptCatalog.ts";

const DETECTOR_CACHE_MAX_KEYS = 16;
const PACKAGE_MANAGER_LOCKFILES = [
  ["bun", ["bun.lock", "bun.lockb"]],
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
] as const;
const ROOT_MARKER_FILES = [
  "package.json",
  "build.zig",
  "gradlew",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  ...PACKAGE_MANAGER_LOCKFILES.flatMap(([, lockfiles]) => lockfiles),
] as const;

type SupportedPackageManager = (typeof PACKAGE_MANAGER_LOCKFILES)[number][0];

interface CacheEntry {
  readonly signature: string;
  readonly result: ListDetectedProjectScriptsResult;
}

interface RootScan {
  readonly rootEntryNames: ReadonlySet<string>;
  readonly dotnetMarkers: readonly string[];
  readonly signature: string;
  readonly cargoConfigExists: boolean;
}

interface PackageJsonDetection {
  readonly scripts: DetectedProjectScript[];
  readonly warnings: string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function readMarkerStatSnapshot(filePath: string): Promise<{
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly mtimeMs: number;
} | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    return {
      type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtimeMs: Number(stat.mtimeMs),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function buildDetectedScript(input: {
  readonly source: DetectedProjectScriptSource;
  readonly displayName: string;
  readonly badgeLabel: string;
  readonly detail: string;
  readonly command: string;
  readonly originPath: string;
  readonly idSuffix: string;
}): DetectedProjectScript {
  return {
    id: `${input.source}:${input.idSuffix}`,
    source: input.source,
    displayName: input.displayName,
    badgeLabel: input.badgeLabel,
    detail: input.detail,
    command: input.command,
    originPath: input.originPath,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolvePackageManagerFromField(value: unknown): SupportedPackageManager | null {
  if (typeof value !== "string") {
    return null;
  }

  const [rawName] = value.trim().split("@");
  if (rawName === "bun" || rawName === "pnpm" || rawName === "yarn" || rawName === "npm") {
    return rawName;
  }
  return null;
}

function resolvePackageManager(
  packageJson: Record<string, unknown>,
  rootEntryNames: ReadonlySet<string>,
): SupportedPackageManager {
  const fromField = resolvePackageManagerFromField(packageJson.packageManager);
  if (fromField) {
    return fromField;
  }

  for (const [manager, lockfiles] of PACKAGE_MANAGER_LOCKFILES) {
    if (lockfiles.some((lockfile) => rootEntryNames.has(lockfile))) {
      return manager;
    }
  }

  return "npm";
}

function packageJsonHasDependency(
  packageJson: Record<string, unknown>,
  dependencyName: string,
): boolean {
  for (const fieldName of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const fieldValue = asRecord(packageJson[fieldName]);
    if (fieldValue && typeof fieldValue[dependencyName] === "string") {
      return true;
    }
  }
  return false;
}

function resolvePackageScriptBadgeLabel(packageJson: Record<string, unknown>): "js" | "ts" {
  if (
    packageJsonHasDependency(packageJson, "typescript") ||
    typeof packageJson.types === "string" ||
    packageJson.typesVersions !== undefined
  ) {
    return "ts";
  }
  return "js";
}

async function scanRoot(cwd: string, path: Path.Path): Promise<RootScan> {
  const rootEntries = await fsPromises.readdir(cwd, { withFileTypes: true });
  const rootFileNames = rootEntries
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  const rootEntryNames = new Set(rootFileNames);
  const dotnetMarkers = rootFileNames.filter(
    (entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"),
  );

  const markerSnapshots = await Promise.all([
    ...ROOT_MARKER_FILES.map(async (name) => {
      const snapshot = await readMarkerStatSnapshot(path.join(cwd, name));
      return snapshot ? Object.assign({ name }, snapshot) : null;
    }),
    ...dotnetMarkers.map(async (name) => {
      const snapshot = await readMarkerStatSnapshot(path.join(cwd, name));
      return snapshot ? Object.assign({ name }, snapshot) : null;
    }),
  ]);
  const cargoConfigSnapshot = await readMarkerStatSnapshot(path.join(cwd, ".cargo", "config.toml"));

  return {
    rootEntryNames,
    dotnetMarkers,
    cargoConfigExists: cargoConfigSnapshot !== null,
    signature: JSON.stringify({
      markers: markerSnapshots.filter((entry) => entry !== null),
      cargoConfig: cargoConfigSnapshot,
    }),
  };
}

async function detectPackageJsonScripts(input: {
  readonly cwd: string;
  readonly path: Path.Path;
  readonly rootEntryNames: ReadonlySet<string>;
}): Promise<PackageJsonDetection> {
  if (!input.rootEntryNames.has("package.json")) {
    return {
      scripts: [],
      warnings: [],
    };
  }

  const packageJsonPath = input.path.join(input.cwd, "package.json");
  let parsedPackageJson: unknown;
  try {
    parsedPackageJson = JSON.parse(await fsPromises.readFile(packageJsonPath, "utf8"));
  } catch {
    return {
      scripts: [],
      warnings: ['Could not parse "package.json".'],
    };
  }

  const packageJson = asRecord(parsedPackageJson);
  if (!packageJson) {
    return {
      scripts: [],
      warnings: ['"package.json" must contain an object.'],
    };
  }

  const packageManager = resolvePackageManager(packageJson, input.rootEntryNames);
  const badgeLabel = resolvePackageScriptBadgeLabel(packageJson);
  const scriptsValue = packageJson.scripts;
  const scriptsRecord = asRecord(scriptsValue);
  if (!scriptsValue) {
    return {
      scripts: [],
      warnings: [],
    };
  }
  if (!scriptsRecord) {
    return {
      scripts: [],
      warnings: ['"package.json" has an invalid "scripts" shape.'],
    };
  }

  const scripts: DetectedProjectScript[] = [];
  const warnings: string[] = [];
  for (const [scriptName, scriptCommand] of Object.entries(scriptsRecord)) {
    if (typeof scriptCommand !== "string") {
      warnings.push(`Skipped non-string package.json script "${scriptName}".`);
      continue;
    }
    const trimmedCommand = scriptCommand.trim();
    if (trimmedCommand.length === 0) {
      warnings.push(`Skipped empty package.json script "${scriptName}".`);
      continue;
    }
    scripts.push(
      buildDetectedScript({
        source: "package_json",
        displayName: scriptName,
        badgeLabel,
        detail: `${packageManager} · ${trimmedCommand}`,
        command: `${packageManager} run ${scriptName}`,
        originPath: "package.json",
        idSuffix: scriptName,
      }),
    );
  }

  return {
    scripts,
    warnings,
  };
}

function detectZigScripts(rootEntryNames: ReadonlySet<string>): DetectedProjectScript[] {
  if (!rootEntryNames.has("build.zig")) {
    return [];
  }
  return [
    buildDetectedScript({
      source: "zig",
      displayName: "Build",
      badgeLabel: "Zig",
      detail: "Zig · build.zig",
      command: "zig build",
      originPath: "build.zig",
      idSuffix: "build",
    }),
  ];
}

function detectGradleScripts(rootEntryNames: ReadonlySet<string>): DetectedProjectScript[] {
  const hasWrapper = rootEntryNames.has("gradlew");
  const buildFile = rootEntryNames.has("build.gradle.kts")
    ? "build.gradle.kts"
    : rootEntryNames.has("build.gradle")
      ? "build.gradle"
      : hasWrapper
        ? "gradlew"
        : null;
  if (!hasWrapper && buildFile === null) {
    return [];
  }
  const commandPrefix = hasWrapper ? "./gradlew" : "gradle";
  const originPath = buildFile ?? "gradlew";
  return [
    buildDetectedScript({
      source: "gradle",
      displayName: "Build",
      badgeLabel: "Gradle",
      detail: `Gradle · ${originPath}`,
      command: `${commandPrefix} build`,
      originPath,
      idSuffix: "build",
    }),
    buildDetectedScript({
      source: "gradle",
      displayName: "Test",
      badgeLabel: "Gradle",
      detail: `Gradle · ${originPath}`,
      command: `${commandPrefix} test`,
      originPath,
      idSuffix: "test",
    }),
  ];
}

function detectGoScripts(rootEntryNames: ReadonlySet<string>): DetectedProjectScript[] {
  if (!rootEntryNames.has("go.mod")) {
    return [];
  }
  return [
    buildDetectedScript({
      source: "go",
      displayName: "Build",
      badgeLabel: "Go",
      detail: "Go · go.mod",
      command: "go build",
      originPath: "go.mod",
      idSuffix: "build",
    }),
    buildDetectedScript({
      source: "go",
      displayName: "Run",
      badgeLabel: "Go",
      detail: "Go · go.mod",
      command: "go run .",
      originPath: "go.mod",
      idSuffix: "run",
    }),
    buildDetectedScript({
      source: "go",
      displayName: "Test",
      badgeLabel: "Go",
      detail: "Go · go.mod",
      command: "go test",
      originPath: "go.mod",
      idSuffix: "test",
    }),
  ];
}

function detectRustScripts(input: {
  readonly rootEntryNames: ReadonlySet<string>;
  readonly cargoConfigExists: boolean;
}): DetectedProjectScript[] {
  const originPath = input.rootEntryNames.has("Cargo.toml")
    ? "Cargo.toml"
    : input.cargoConfigExists
      ? ".cargo/config.toml"
      : null;
  if (!originPath) {
    return [];
  }
  return [
    buildDetectedScript({
      source: "rust",
      displayName: "Build",
      badgeLabel: "Rust",
      detail: `Rust · ${originPath}`,
      command: "cargo build",
      originPath,
      idSuffix: "build",
    }),
    buildDetectedScript({
      source: "rust",
      displayName: "Test",
      badgeLabel: "Rust",
      detail: `Rust · ${originPath}`,
      command: "cargo test",
      originPath,
      idSuffix: "test",
    }),
  ];
}

function detectDotnetScripts(dotnetMarkers: readonly string[]): DetectedProjectScript[] {
  const originPath = dotnetMarkers[0] ?? null;
  if (!originPath) {
    return [];
  }
  return [
    buildDetectedScript({
      source: "dotnet",
      displayName: "Build",
      badgeLabel: ".NET",
      detail: `.NET · ${originPath}`,
      command: "dotnet build",
      originPath,
      idSuffix: "build",
    }),
    buildDetectedScript({
      source: "dotnet",
      displayName: "Test",
      badgeLabel: ".NET",
      detail: `.NET · ${originPath}`,
      command: "dotnet test",
      originPath,
      idSuffix: "test",
    }),
    buildDetectedScript({
      source: "dotnet",
      displayName: "MSBuild",
      badgeLabel: ".NET",
      detail: `.NET · ${originPath}`,
      command: "dotnet msbuild",
      originPath,
      idSuffix: "msbuild",
    }),
  ];
}

const makeProjectDetectedScriptCatalog = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const cache = new Map<string, CacheEntry>();

  const setCachedResult = (cwd: string, entry: CacheEntry) => {
    cache.delete(cwd);
    cache.set(cwd, entry);
    while (cache.size > DETECTOR_CACHE_MAX_KEYS) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  const list: ProjectDetectedScriptCatalogShape["list"] = (input) =>
    Effect.gen(function* () {
      const normalizedCwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectDetectedScriptCatalogError({
              cwd: input.cwd,
              operation: "projectDetectedScriptCatalog.normalizeWorkspaceRoot",
              detail: cause.message,
              cause,
            }),
        ),
      );

      const rootScan = yield* Effect.tryPromise({
        try: () => scanRoot(normalizedCwd, path),
        catch: (cause) =>
          new ProjectDetectedScriptCatalogError({
            cwd: normalizedCwd,
            operation: "projectDetectedScriptCatalog.scanRoot",
            detail: "Failed to scan project root for detected actions.",
            cause,
          }),
      });

      const cached = cache.get(normalizedCwd);
      if (cached && cached.signature === rootScan.signature) {
        return cached.result;
      }

      const packageJsonDetection = yield* Effect.tryPromise({
        try: () =>
          detectPackageJsonScripts({
            cwd: normalizedCwd,
            path,
            rootEntryNames: rootScan.rootEntryNames,
          }),
        catch: (cause) =>
          new ProjectDetectedScriptCatalogError({
            cwd: normalizedCwd,
            operation: "projectDetectedScriptCatalog.detectPackageJsonScripts",
            detail: "Failed to inspect package.json scripts.",
            cause,
          }),
      });

      const result = {
        scripts: [
          ...packageJsonDetection.scripts,
          ...detectZigScripts(rootScan.rootEntryNames),
          ...detectGradleScripts(rootScan.rootEntryNames),
          ...detectGoScripts(rootScan.rootEntryNames),
          ...detectRustScripts({
            rootEntryNames: rootScan.rootEntryNames,
            cargoConfigExists: rootScan.cargoConfigExists,
          }),
          ...detectDotnetScripts(rootScan.dotnetMarkers),
        ],
        warnings: packageJsonDetection.warnings,
      } satisfies ListDetectedProjectScriptsResult;

      setCachedResult(normalizedCwd, {
        signature: rootScan.signature,
        result,
      });

      return result;
    });

  return {
    list,
  } satisfies ProjectDetectedScriptCatalogShape;
});

export const ProjectDetectedScriptCatalogLive = Layer.effect(
  ProjectDetectedScriptCatalog,
  makeProjectDetectedScriptCatalog,
);
