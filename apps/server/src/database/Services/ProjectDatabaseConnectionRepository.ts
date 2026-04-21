import { DatabaseConnectionId, ProjectId, SavedDatabaseConnection } from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type ProjectDatabaseConnectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ProjectDatabaseConnectionLookup = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type ProjectDatabaseConnectionLookup = typeof ProjectDatabaseConnectionLookup.Type;

export const ProjectDatabaseConnectionsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectDatabaseConnectionsByProjectInput =
  typeof ProjectDatabaseConnectionsByProjectInput.Type;

export interface ProjectDatabaseConnectionRepositoryShape {
  readonly upsert: (
    connection: SavedDatabaseConnection & { readonly projectId: ProjectId },
  ) => Effect.Effect<void, ProjectDatabaseConnectionRepositoryError>;
  readonly listByProjectId: (
    input: ProjectDatabaseConnectionsByProjectInput,
  ) => Effect.Effect<
    ReadonlyArray<SavedDatabaseConnection>,
    ProjectDatabaseConnectionRepositoryError
  >;
  readonly getById: (
    input: ProjectDatabaseConnectionLookup,
  ) => Effect.Effect<
    Option.Option<SavedDatabaseConnection>,
    ProjectDatabaseConnectionRepositoryError
  >;
  readonly deleteById: (
    input: ProjectDatabaseConnectionLookup,
  ) => Effect.Effect<void, ProjectDatabaseConnectionRepositoryError>;
}

export class ProjectDatabaseConnectionRepository extends Context.Service<
  ProjectDatabaseConnectionRepository,
  ProjectDatabaseConnectionRepositoryShape
>()("t3/database/Services/ProjectDatabaseConnectionRepository") {}
