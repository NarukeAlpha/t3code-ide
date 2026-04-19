import { Context } from "effect";
import type { Effect } from "effect";

import type {
  ListDetectedProjectScriptsInput,
  ListDetectedProjectScriptsResult,
  ProjectDetectedScriptsError,
} from "@t3tools/contracts";

export interface ProjectDetectedScriptCatalogShape {
  readonly list: (
    input: ListDetectedProjectScriptsInput,
  ) => Effect.Effect<ListDetectedProjectScriptsResult, ProjectDetectedScriptsError>;
}

export class ProjectDetectedScriptCatalog extends Context.Service<
  ProjectDetectedScriptCatalog,
  ProjectDetectedScriptCatalogShape
>()("t3/project/Services/ProjectDetectedScriptCatalog") {}
