import { DatabaseConnectionId, ProjectId } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { SecretStoreError } from "../../auth/Services/ServerSecretStore.ts";

export const ProjectDatabaseSecretLookup = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type ProjectDatabaseSecretLookup = typeof ProjectDatabaseSecretLookup.Type;

export interface ProjectDatabaseConnectionSecretsShape {
  readonly getPassword: (
    input: ProjectDatabaseSecretLookup,
  ) => Effect.Effect<string | null, SecretStoreError>;
  readonly setPassword: (
    input: ProjectDatabaseSecretLookup & { readonly password: string },
  ) => Effect.Effect<void, SecretStoreError>;
  readonly removePassword: (
    input: ProjectDatabaseSecretLookup,
  ) => Effect.Effect<void, SecretStoreError>;
}

export class ProjectDatabaseConnectionSecrets extends Context.Service<
  ProjectDatabaseConnectionSecrets,
  ProjectDatabaseConnectionSecretsShape
>()("t3/database/Services/ProjectDatabaseConnectionSecrets") {}
