import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import {
  ProjectDatabaseConnectionSharedSecrets,
  type ProjectDatabaseConnectionSharedSecretsShape,
} from "../Services/ProjectDatabaseConnectionSharedSecrets.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getSecretName(projectId: string, connectionId: string) {
  const encoded = Buffer.from(`${projectId}:${connectionId}`).toString("base64url");
  return `database-convex-shared-secret-${encoded}`;
}

const makeProjectDatabaseConnectionSharedSecrets = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const getSharedSecret: ProjectDatabaseConnectionSharedSecretsShape["getSharedSecret"] = (input) =>
    secretStore
      .get(getSecretName(input.projectId, input.connectionId))
      .pipe(Effect.map((secret) => (secret === null ? null : textDecoder.decode(secret))));

  const setSharedSecret: ProjectDatabaseConnectionSharedSecretsShape["setSharedSecret"] = (input) =>
    secretStore.set(
      getSecretName(input.projectId, input.connectionId),
      textEncoder.encode(input.sharedSecret),
    );

  const removeSharedSecret: ProjectDatabaseConnectionSharedSecretsShape["removeSharedSecret"] = (
    input,
  ) => secretStore.remove(getSecretName(input.projectId, input.connectionId));

  return {
    getSharedSecret,
    setSharedSecret,
    removeSharedSecret,
  } satisfies ProjectDatabaseConnectionSharedSecretsShape;
});

export const ProjectDatabaseConnectionSharedSecretsLive = Layer.effect(
  ProjectDatabaseConnectionSharedSecrets,
  makeProjectDatabaseConnectionSharedSecrets,
);
