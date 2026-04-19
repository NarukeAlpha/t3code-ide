import { Effect, Exit, FileSystem, Layer, Path, Ref } from "effect";

import {
  type DetectedProjectScript,
  type ListDetectedProjectScriptsResult,
  type ProjectPackageManager,
  type ProjectDetectedScriptWarning,
  ProjectDetectedScriptsError,
} from "@t3tools/contracts";

import {
  ProjectDetectedScriptCatalog,
  type ProjectDetectedScriptCatalogShape,
} from "../Services/ProjectDetectedScriptCatalog.ts";

const LOCKFILE_CANDIDATES: ReadonlyArray<{
  readonly fileName: string;
  readonly packageManager: ProjectPackageManager;
}> = [
  { fileName: "bun.lockb", packageManager: "bun" },
  { fileName: "bun.lock", packageManager: "bun" },
  { fileName: "pnpm-lock.yaml", packageManager: "pnpm" },
  { fileName: "yarn.lock", packageManager: "yarn" },
  { fileName: "package-lock.json", packageManager: "npm" },
  { fileName: "npm-shrinkwrap.json", packageManager: "npm" },
];

const STATIC_MARKER_FILES = [
  "package.json",
  "build.zig",
  "gradlew",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  ".cargo/config.toml",
] as const;

const DOTNET_EXTENSION_PRIORITY: Readonly<Record<string, number>> = {
  ".sln": 0,
  ".csproj": 1,
};

interface CachedDetectedScripts {
  readonly signature: string;
  readonly result: ListDetectedProjectScriptsResult;
}

interface PackageJsonDetection {
  readonly scripts: ReadonlyArray<DetectedProjectScript>;
  readonly warnings: ReadonlyArray<ProjectDetectedScriptWarning>;
}

interface StaticDetectedScriptDefinition {
  readonly displayName: string;
  readonly command: string;
}

function stringifySignatureValue(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) =>
    typeof currentValue === "bigint" ? `bigint:${currentValue.toString()}` : currentValue,
  );
}

function normalizePackageManager(value: string | undefined): ProjectPackageManager | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("bun")) return "bun";
  if (normalized.startsWith("pnpm")) return "pnpm";
  if (normalized.startsWith("yarn")) return "yarn";
  if (normalized.startsWith("npm")) return "npm";
  return null;
}

function commandForPackageManager(
  packageManager: ProjectPackageManager,
  scriptName: string,
): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn run ${scriptName}`;
    case "npm":
    default:
      return `npm run ${scriptName}`;
  }
}

function toDetectedScript(input: {
  readonly id: string;
  readonly source: DetectedProjectScript["source"];
  readonly displayName: string;
  readonly badgeLabel: string;
  readonly detail: string;
  readonly command: string;
  readonly originPath: string;
}): DetectedProjectScript {
  return {
    id: input.id,
    source: input.source,
    displayName: input.displayName,
    badgeLabel: input.badgeLabel,
    detail: input.detail,
    command: input.command,
    originPath: input.originPath,
  };
}

function toDetectedScriptsError(message: string, cause?: unknown): ProjectDetectedScriptsError {
  return new ProjectDetectedScriptsError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toStaticDetectedScriptId(
  source: Exclude<DetectedProjectScript["source"], "package_json">,
  displayName: string,
): string {
  return `${source}:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function toStaticDetectedScripts(input: {
  readonly source: Exclude<DetectedProjectScript["source"], "package_json">;
  readonly badgeLabel: string;
  readonly detail: string;
  readonly originPath: string;
  readonly definitions: ReadonlyArray<StaticDetectedScriptDefinition>;
}): ReadonlyArray<DetectedProjectScript> {
  return input.definitions.map((definition) =>
    toDetectedScript({
      id: toStaticDetectedScriptId(input.source, definition.displayName),
      source: input.source,
      displayName: definition.displayName,
      badgeLabel: input.badgeLabel,
      detail: input.detail,
      command: definition.command,
      originPath: input.originPath,
    }),
  );
}

export const makeProjectDetectedScriptCatalog = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheRef = yield* Ref.make(new Map<string, CachedDetectedScripts>());

  const safeStat = (targetPath: string) =>
    fileSystem.stat(targetPath).pipe(Effect.catch(() => Effect.succeed(null)));

  const safeReadDirectory = (targetPath: string) =>
    fileSystem
      .readDirectory(targetPath, { recursive: false })
      .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const readDotnetRootEntryNames = (cwd: string) =>
    safeReadDirectory(cwd).pipe(
      Effect.map((entries) =>
        entries
          .filter((name) => {
            const extension = path.extname(name).toLowerCase();
            return extension in DOTNET_EXTENSION_PRIORITY;
          })
          .sort((left, right) => {
            const leftPriority = DOTNET_EXTENSION_PRIORITY[path.extname(left).toLowerCase()] ?? 99;
            const rightPriority =
              DOTNET_EXTENSION_PRIORITY[path.extname(right).toLowerCase()] ?? 99;
            if (leftPriority !== rightPriority) {
              return leftPriority - rightPriority;
            }
            return left.localeCompare(right);
          }),
      ),
    );

  const readStatsSignature = Effect.fn("ProjectDetectedScriptCatalog.readStatsSignature")(
    function* (cwd: string): Effect.fn.Return<{
      readonly signature: string;
      readonly detectedPackageManager: ProjectPackageManager | null;
      readonly dotnetRootEntries: ReadonlyArray<string>;
    }> {
      const signatureParts = [`cwd:${cwd}`];
      const cwdStat = yield* safeStat(cwd);
      if (cwdStat) {
        signatureParts.push(`cwd.stat:${stringifySignatureValue(cwdStat)}`);
      }

      let detectedPackageManager: ProjectPackageManager | null = null;

      for (const markerFile of STATIC_MARKER_FILES) {
        const markerPath = path.join(cwd, markerFile);
        const stats = yield* safeStat(markerPath);
        if (!stats || stats.type !== "File") {
          continue;
        }
        signatureParts.push(`${markerFile}:${stringifySignatureValue(stats)}`);
      }

      for (const candidate of LOCKFILE_CANDIDATES) {
        const candidatePath = path.join(cwd, candidate.fileName);
        const stats = yield* safeStat(candidatePath);
        if (!stats || stats.type !== "File") {
          continue;
        }
        detectedPackageManager ??= candidate.packageManager;
      }

      const dotnetRootEntries = yield* readDotnetRootEntryNames(cwd);
      for (const entryName of dotnetRootEntries) {
        const entryPath = path.join(cwd, entryName);
        const stats = yield* safeStat(entryPath);
        if (!stats || stats.type !== "File") {
          continue;
        }
        signatureParts.push(`dotnet:${entryName}:${stringifySignatureValue(stats)}`);
      }

      return {
        signature: signatureParts.join("|"),
        detectedPackageManager,
        dotnetRootEntries,
      } as const;
    },
  );

  const detectPackageJsonScripts = Effect.fn(
    "ProjectDetectedScriptCatalog.detectPackageJsonScripts",
  )(function* (
    cwd: string,
    detectedPackageManager: ProjectPackageManager | null,
  ): Effect.fn.Return<PackageJsonDetection, ProjectDetectedScriptsError> {
    const manifestPath = path.join(cwd, "package.json");
    const manifestStats = yield* safeStat(manifestPath);
    if (!manifestStats || manifestStats.type !== "File") {
      return {
        scripts: [],
        warnings: [],
      } satisfies PackageJsonDetection;
    }

    const rawManifest = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(
        Effect.mapError((cause) =>
          toDetectedScriptsError(`Failed to read ${manifestPath}.`, cause),
        ),
      );

    const parsedManifestResult = yield* Effect.exit(
      Effect.try({
        try: () => JSON.parse(rawManifest) as unknown,
        catch: (cause) => toDetectedScriptsError(`Failed to parse ${manifestPath}.`, cause),
      }),
    );

    if (Exit.isFailure(parsedManifestResult)) {
      return {
        scripts: [],
        warnings: [
          {
            message:
              "package.json could not be parsed. JavaScript package scripts are unavailable.",
          },
        ],
      } satisfies PackageJsonDetection;
    }

    const parsedManifest = parsedManifestResult.value;
    const manifestRecord =
      parsedManifest && typeof parsedManifest === "object"
        ? (parsedManifest as Record<string, unknown>)
        : null;
    const configuredPackageManager =
      typeof manifestRecord?.packageManager === "string"
        ? normalizePackageManager(manifestRecord.packageManager)
        : null;
    const packageManager = configuredPackageManager ?? detectedPackageManager ?? "npm";

    const warnings: ProjectDetectedScriptWarning[] = [];
    const rawScripts =
      manifestRecord?.scripts && typeof manifestRecord.scripts === "object"
        ? (manifestRecord.scripts as Record<string, unknown>)
        : null;

    if (manifestRecord?.scripts !== undefined && rawScripts === null) {
      warnings.push({
        message:
          "package.json has an invalid scripts section. Only string-valued scripts can be used.",
      });
    }

    const scripts: DetectedProjectScript[] = [];
    if (rawScripts) {
      for (const [scriptName, scriptCommand] of Object.entries(rawScripts)) {
        if (typeof scriptCommand !== "string") {
          warnings.push({
            message: `Skipping "${scriptName}" because its script definition is not a string.`,
          });
          continue;
        }

        const trimmedName = scriptName.trim();
        const trimmedCommand = scriptCommand.trim();
        if (trimmedName.length === 0 || trimmedCommand.length === 0) {
          continue;
        }

        scripts.push(
          toDetectedScript({
            id: `package_json:${trimmedName}`,
            source: "package_json",
            displayName: trimmedName,
            badgeLabel: "package.json",
            detail: `${packageManager} · ${trimmedCommand}`,
            command: commandForPackageManager(packageManager, trimmedName),
            originPath: manifestPath,
          }),
        );
      }
    }

    return {
      scripts,
      warnings,
    } satisfies PackageJsonDetection;
  });

  const detectStaticScripts = Effect.fn("ProjectDetectedScriptCatalog.detectStaticScripts")(
    function* (
      cwd: string,
      dotnetRootEntries: ReadonlyArray<string>,
    ): Effect.fn.Return<ReadonlyArray<DetectedProjectScript>> {
      const zigOriginPath = path.join(cwd, "build.zig");
      const zigStats = yield* safeStat(zigOriginPath);

      const gradleWrapperPath = path.join(cwd, "gradlew");
      const gradleKtsPath = path.join(cwd, "build.gradle.kts");
      const gradleGroovyPath = path.join(cwd, "build.gradle");
      const [gradleWrapperStats, gradleKtsStats, gradleGroovyStats] = yield* Effect.all([
        safeStat(gradleWrapperPath),
        safeStat(gradleKtsPath),
        safeStat(gradleGroovyPath),
      ]);

      const goOriginPath = path.join(cwd, "go.mod");
      const goStats = yield* safeStat(goOriginPath);

      const cargoManifestPath = path.join(cwd, "Cargo.toml");
      const cargoConfigPath = path.join(cwd, ".cargo", "config.toml");
      const [cargoManifestStats, cargoConfigStats] = yield* Effect.all([
        safeStat(cargoManifestPath),
        safeStat(cargoConfigPath),
      ]);

      const scripts: DetectedProjectScript[] = [];

      if (zigStats?.type === "File") {
        scripts.push(
          ...toStaticDetectedScripts({
            source: "zig",
            badgeLabel: "Zig",
            detail: path.basename(zigOriginPath),
            originPath: zigOriginPath,
            definitions: [{ displayName: "Build", command: "zig build" }],
          }),
        );
      }

      const gradleExecutable = gradleWrapperStats?.type === "File" ? "./gradlew" : "gradle";
      const gradleOriginPath =
        gradleKtsStats?.type === "File"
          ? gradleKtsPath
          : gradleGroovyStats?.type === "File"
            ? gradleGroovyPath
            : gradleWrapperStats?.type === "File"
              ? gradleWrapperPath
              : null;

      if (gradleOriginPath) {
        scripts.push(
          ...toStaticDetectedScripts({
            source: "gradle",
            badgeLabel: "Gradle",
            detail: path.basename(gradleOriginPath),
            originPath: gradleOriginPath,
            definitions: [
              { displayName: "Build", command: `${gradleExecutable} build` },
              { displayName: "Test", command: `${gradleExecutable} test` },
            ],
          }),
        );
      }

      if (goStats?.type === "File") {
        scripts.push(
          ...toStaticDetectedScripts({
            source: "go",
            badgeLabel: "Go",
            detail: path.basename(goOriginPath),
            originPath: goOriginPath,
            definitions: [
              { displayName: "Build", command: "go build" },
              { displayName: "Run", command: "go run ." },
              { displayName: "Test", command: "go test" },
            ],
          }),
        );
      }

      const cargoOriginPath =
        cargoManifestStats?.type === "File"
          ? cargoManifestPath
          : cargoConfigStats?.type === "File"
            ? cargoConfigPath
            : null;

      if (cargoOriginPath) {
        scripts.push(
          ...toStaticDetectedScripts({
            source: "rust",
            badgeLabel: "Rust",
            detail: path.relative(cwd, cargoOriginPath),
            originPath: cargoOriginPath,
            definitions: [
              { displayName: "Build", command: "cargo build" },
              { displayName: "Test", command: "cargo test" },
            ],
          }),
        );
      }

      const dotnetOriginName = dotnetRootEntries[0];
      if (dotnetOriginName) {
        const dotnetOriginPath = path.join(cwd, dotnetOriginName);
        scripts.push(
          ...toStaticDetectedScripts({
            source: "dotnet",
            badgeLabel: ".NET",
            detail: dotnetOriginName,
            originPath: dotnetOriginPath,
            definitions: [
              { displayName: "Build", command: "dotnet build" },
              { displayName: "Test", command: "dotnet test" },
              { displayName: "MSBuild", command: "dotnet msbuild" },
            ],
          }),
        );
      }

      return scripts;
    },
  );

  const list: ProjectDetectedScriptCatalogShape["list"] = Effect.fn(
    "ProjectDetectedScriptCatalog.list",
  )(function* (input): Effect.fn.Return<
    ListDetectedProjectScriptsResult,
    ProjectDetectedScriptsError
  > {
    const { signature, detectedPackageManager, dotnetRootEntries } = yield* readStatsSignature(
      input.cwd,
    );
    const cached = yield* Ref.get(cacheRef);
    const cacheHit = cached.get(input.cwd);
    if (cacheHit?.signature === signature) {
      return cacheHit.result;
    }

    const packageJsonDetection = yield* detectPackageJsonScripts(input.cwd, detectedPackageManager);
    const staticScripts = yield* detectStaticScripts(input.cwd, dotnetRootEntries);

    const result = {
      scripts: [...packageJsonDetection.scripts, ...staticScripts],
      warnings: [...packageJsonDetection.warnings],
    } satisfies ListDetectedProjectScriptsResult;

    yield* Ref.update(cacheRef, (current) =>
      new Map(current).set(input.cwd, { signature, result }),
    );
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
