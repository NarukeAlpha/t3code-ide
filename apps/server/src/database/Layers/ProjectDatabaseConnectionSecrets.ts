import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import {
  ProjectDatabaseConnectionSecrets,
  type ProjectDatabaseConnectionSecretsShape,
} from "../Services/ProjectDatabaseConnectionSecrets.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getSecretName(projectId: string, connectionId: string) {
  const encoded = Buffer.from(`${projectId}:${connectionId}`).toString("base64url");
  return `database-connection-${encoded}`;
}

const makeProjectDatabaseConnectionSecrets = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const getPassword: ProjectDatabaseConnectionSecretsShape["getPassword"] = (input) =>
    secretStore
      .get(getSecretName(input.projectId, input.connectionId))
      .pipe(Effect.map((secret) => (secret === null ? null : textDecoder.decode(secret))));

  const setPassword: ProjectDatabaseConnectionSecretsShape["setPassword"] = (input) =>
    secretStore.set(
      getSecretName(input.projectId, input.connectionId),
      textEncoder.encode(input.password),
    );

  const removePassword: ProjectDatabaseConnectionSecretsShape["removePassword"] = (input) =>
    secretStore.remove(getSecretName(input.projectId, input.connectionId));

  return {
    getPassword,
    setPassword,
    removePassword,
  } satisfies ProjectDatabaseConnectionSecretsShape;
});

export const ProjectDatabaseConnectionSecretsLive = Layer.effect(
  ProjectDatabaseConnectionSecrets,
  makeProjectDatabaseConnectionSecrets,
);
