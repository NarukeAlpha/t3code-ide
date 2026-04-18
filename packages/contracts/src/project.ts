import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_DETECTED_SCRIPTS_MAX_COUNT = 256;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectPackageManager = Schema.Literals(["bun", "pnpm", "yarn", "npm"]);
export type ProjectPackageManager = typeof ProjectPackageManager.Type;

export const DetectedProjectScriptSource = Schema.Literals([
  "package_json",
  "zig",
  "gradle",
  "go",
  "rust",
  "dotnet",
]);
export type DetectedProjectScriptSource = typeof DetectedProjectScriptSource.Type;

export const DetectedProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: DetectedProjectScriptSource,
  displayName: TrimmedNonEmptyString,
  badgeLabel: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  originPath: TrimmedNonEmptyString,
});
export type DetectedProjectScript = typeof DetectedProjectScript.Type;

export const ProjectDetectedScriptWarning = Schema.Struct({
  message: TrimmedNonEmptyString,
});
export type ProjectDetectedScriptWarning = typeof ProjectDetectedScriptWarning.Type;

export const ListDetectedProjectScriptsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ListDetectedProjectScriptsInput = typeof ListDetectedProjectScriptsInput.Type;

export const ListDetectedProjectScriptsResult = Schema.Struct({
  scripts: Schema.Array(DetectedProjectScript).check(
    Schema.isMaxLength(PROJECT_DETECTED_SCRIPTS_MAX_COUNT),
  ),
  warnings: Schema.Array(ProjectDetectedScriptWarning),
});
export type ListDetectedProjectScriptsResult = typeof ListDetectedProjectScriptsResult.Type;

export class ProjectDetectedScriptsError extends Schema.TaggedErrorClass<ProjectDetectedScriptsError>()(
  "ProjectDetectedScriptsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
