import { DatabaseConnectionId, ProjectId } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { SecretStoreError } from "../../auth/Services/ServerSecretStore.ts";

export const ProjectDatabaseSharedSecretLookup = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type ProjectDatabaseSharedSecretLookup = typeof ProjectDatabaseSharedSecretLookup.Type;

export interface ProjectDatabaseConnectionSharedSecretsShape {
  readonly getSharedSecret: (
    input: ProjectDatabaseSharedSecretLookup,
  ) => Effect.Effect<string | null, SecretStoreError>;
  readonly setSharedSecret: (
    input: ProjectDatabaseSharedSecretLookup & { readonly sharedSecret: string },
  ) => Effect.Effect<void, SecretStoreError>;
  readonly removeSharedSecret: (
    input: ProjectDatabaseSharedSecretLookup,
  ) => Effect.Effect<void, SecretStoreError>;
}

export class ProjectDatabaseConnectionSharedSecrets extends Context.Service<
  ProjectDatabaseConnectionSharedSecrets,
  ProjectDatabaseConnectionSharedSecretsShape
>()("t3/database/Services/ProjectDatabaseConnectionSharedSecrets") {}
