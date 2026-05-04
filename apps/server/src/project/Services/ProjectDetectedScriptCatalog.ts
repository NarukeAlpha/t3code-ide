import type {
  ListDetectedProjectScriptsInput,
  ListDetectedProjectScriptsResult,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class ProjectDetectedScriptCatalogError extends Schema.TaggedErrorClass<ProjectDetectedScriptCatalogError>()(
  "ProjectDetectedScriptCatalogError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ProjectDetectedScriptCatalogShape {
  readonly list: (
    input: ListDetectedProjectScriptsInput,
  ) => Effect.Effect<ListDetectedProjectScriptsResult, ProjectDetectedScriptCatalogError>;
}

export class ProjectDetectedScriptCatalog extends Context.Service<
  ProjectDetectedScriptCatalog,
  ProjectDetectedScriptCatalogShape
>()("t3/project/ProjectDetectedScriptCatalog") {}
