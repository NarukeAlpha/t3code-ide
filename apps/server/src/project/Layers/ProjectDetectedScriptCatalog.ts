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

interface CachedDetectedScripts {
  readonly signature: string;
  readonly result: ListDetectedProjectScriptsResult;
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
  readonly packageManager: ProjectPackageManager;
  readonly scriptName: string;
  readonly scriptCommand: string;
  readonly manifestPath: string;
}): DetectedProjectScript {
  return {
    id: `package_json:${input.scriptName}`,
    source: "package_json",
    packageManager: input.packageManager,
    scriptName: input.scriptName,
    displayName: input.scriptName,
    command: commandForPackageManager(input.packageManager, input.scriptName),
    scriptCommand: input.scriptCommand.trim(),
    manifestPath: input.manifestPath,
  };
}

function toDetectedScriptsError(message: string, cause?: unknown): ProjectDetectedScriptsError {
  return new ProjectDetectedScriptsError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const makeProjectDetectedScriptCatalog = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheRef = yield* Ref.make(new Map<string, CachedDetectedScripts>());

  const safeStat = (targetPath: string) =>
    fileSystem.stat(targetPath).pipe(Effect.catch(() => Effect.succeed(null)));

  const readStatsSignature = Effect.fn("ProjectDetectedScriptCatalog.readStatsSignature")(
    function* (
      cwd: string,
      manifestPath: string,
    ): Effect.fn.Return<{
      readonly signature: string;
      readonly detectedPackageManager: ProjectPackageManager | null;
    }> {
      const signatureParts = [`package.json:${manifestPath}`];
      const manifestStat = yield* safeStat(manifestPath);
      if (manifestStat) {
        signatureParts.push(`package.json.stat:${JSON.stringify(manifestStat)}`);
      }
      let detectedPackageManager: ProjectPackageManager | null = null;

      for (const candidate of LOCKFILE_CANDIDATES) {
        const candidatePath = path.join(cwd, candidate.fileName);
        const stats = yield* safeStat(candidatePath);
        if (!stats || stats.type !== "File") {
          continue;
        }
        signatureParts.push(`${candidate.fileName}:${JSON.stringify(stats)}`);
        detectedPackageManager ??= candidate.packageManager;
      }

      return {
        signature: signatureParts.join("|"),
        detectedPackageManager,
      } as const;
    },
  );

  const list: ProjectDetectedScriptCatalogShape["list"] = Effect.fn(
    "ProjectDetectedScriptCatalog.list",
  )(function* (input): Effect.fn.Return<
    ListDetectedProjectScriptsResult,
    ProjectDetectedScriptsError
  > {
    const manifestPath = path.join(input.cwd, "package.json");
    const manifestStats = yield* safeStat(manifestPath);
    if (!manifestStats || manifestStats.type !== "File") {
      return {
        scripts: [],
        warnings: [],
      } satisfies ListDetectedProjectScriptsResult;
    }

    const { signature, detectedPackageManager } = yield* readStatsSignature(
      input.cwd,
      manifestPath,
    );
    const cached = yield* Ref.get(cacheRef);
    const cacheHit = cached.get(manifestPath);
    if (cacheHit?.signature === signature) {
      return cacheHit.result;
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
      const result = {
        scripts: [],
        warnings: [
          { message: "package.json could not be parsed. Package scripts are unavailable." },
        ],
      } satisfies ListDetectedProjectScriptsResult;
      yield* Ref.update(cacheRef, (current) =>
        new Map(current).set(manifestPath, { signature, result }),
      );
      return result;
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
            packageManager,
            scriptName: trimmedName,
            scriptCommand: trimmedCommand,
            manifestPath,
          }),
        );
      }
    }

    const result = {
      scripts,
      warnings,
    } satisfies ListDetectedProjectScriptsResult;
    yield* Ref.update(cacheRef, (current) =>
      new Map(current).set(manifestPath, { signature, result }),
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
