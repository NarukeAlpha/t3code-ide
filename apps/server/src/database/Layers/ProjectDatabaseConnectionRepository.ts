import {
  DatabaseConnectionId,
  DatabaseConnectionLabel,
  DatabaseConvexGatewayBaseUrl,
  DatabaseConvexSchemaFilePath,
  DatabaseConvexSyncTarget,
  DatabaseEngine,
  DatabaseHost,
  DatabasePort,
  DatabaseDatabaseName,
  DatabaseSqliteFilePath,
  DatabaseUsername,
  IsoDateTime,
  ProjectId,
  SavedDatabaseConnection,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectDatabaseConnectionLookup,
  ProjectDatabaseConnectionRepository,
  type ProjectDatabaseConnectionRepositoryError,
  type ProjectDatabaseConnectionRepositoryShape,
  ProjectDatabaseConnectionsByProjectInput,
} from "../Services/ProjectDatabaseConnectionRepository.ts";

const ProjectDatabaseConnectionConfigRow = Schema.fromJsonString(Schema.Unknown);

const ProjectDatabaseConnectionDbRow = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
  engine: DatabaseEngine,
  label: DatabaseConnectionLabel,
  config: ProjectDatabaseConnectionConfigRow,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ProjectDatabaseConnectionWriteRow = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
  engine: DatabaseEngine,
  label: DatabaseConnectionLabel,
  config: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const SqliteConfig = Schema.Struct({
  filePath: DatabaseSqliteFilePath,
});

const NetworkConfig = Schema.Struct({
  host: DatabaseHost,
  port: DatabasePort,
  database: DatabaseDatabaseName,
  user: DatabaseUsername,
  ssl: Schema.Boolean,
});

const ConvexConfig = Schema.Struct({
  gatewayBaseUrl: DatabaseConvexGatewayBaseUrl,
  schemaFilePath: DatabaseConvexSchemaFilePath,
  syncTarget: Schema.optional(DatabaseConvexSyncTarget),
});

const decodeSavedDatabaseConnection = Schema.decodeUnknownEffect(SavedDatabaseConnection);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectDatabaseConnectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function serializeConnectionConfig(connection: SavedDatabaseConnection): string {
  switch (connection.engine) {
    case "sqlite":
      return JSON.stringify({
        filePath: connection.filePath,
      });
    case "mysql":
    case "postgres":
      return JSON.stringify({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        ssl: connection.ssl,
      });
    case "convex":
      return JSON.stringify({
        gatewayBaseUrl: connection.gatewayBaseUrl,
        schemaFilePath: connection.schemaFilePath,
        syncTarget: connection.syncTarget,
      });
  }
}

function decodeConnectionRow(row: typeof ProjectDatabaseConnectionDbRow.Type) {
  switch (row.engine) {
    case "sqlite":
      return Schema.decodeUnknownEffect(SqliteConfig)(row.config).pipe(
        Effect.flatMap((config) =>
          decodeSavedDatabaseConnection({
            id: row.connectionId,
            engine: row.engine,
            label: row.label,
            filePath: config.filePath,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        ),
      );
    case "mysql":
    case "postgres":
      return Schema.decodeUnknownEffect(NetworkConfig)(row.config).pipe(
        Effect.flatMap((config) =>
          decodeSavedDatabaseConnection({
            id: row.connectionId,
            engine: row.engine,
            label: row.label,
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            ssl: config.ssl,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        ),
      );
    case "convex":
      return Schema.decodeUnknownEffect(ConvexConfig)(row.config).pipe(
        Effect.flatMap((config) =>
          decodeSavedDatabaseConnection({
            id: row.connectionId,
            engine: row.engine,
            label: row.label,
            gatewayBaseUrl: config.gatewayBaseUrl,
            schemaFilePath: config.schemaFilePath,
            syncTarget: config.syncTarget ?? "dev",
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        ),
      );
  }
}

const makeProjectDatabaseConnectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertConnectionRow = SqlSchema.void({
    Request: ProjectDatabaseConnectionWriteRow,
    execute: (row) => sql`
      INSERT INTO project_database_connections (
        project_id,
        connection_id,
        engine,
        label,
        config_json,
        created_at,
        updated_at
      )
      VALUES (
        ${row.projectId},
        ${row.connectionId},
        ${row.engine},
        ${row.label},
        ${row.config},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (project_id, connection_id)
      DO UPDATE SET
        engine = excluded.engine,
        label = excluded.label,
        config_json = excluded.config_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listConnectionRowsByProject = SqlSchema.findAll({
    Request: ProjectDatabaseConnectionsByProjectInput,
    Result: ProjectDatabaseConnectionDbRow,
    execute: ({ projectId }) => sql`
      SELECT
        project_id AS "projectId",
        connection_id AS "connectionId",
        engine,
        label,
        config_json AS "config",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM project_database_connections
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC, connection_id ASC
    `,
  });

  const getConnectionRowById = SqlSchema.findOneOption({
    Request: ProjectDatabaseConnectionLookup,
    Result: ProjectDatabaseConnectionDbRow,
    execute: ({ projectId, connectionId }) => sql`
      SELECT
        project_id AS "projectId",
        connection_id AS "connectionId",
        engine,
        label,
        config_json AS "config",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM project_database_connections
      WHERE project_id = ${projectId}
        AND connection_id = ${connectionId}
      LIMIT 1
    `,
  });

  const deleteConnectionRowById = SqlSchema.void({
    Request: ProjectDatabaseConnectionLookup,
    execute: ({ projectId, connectionId }) => sql`
      DELETE FROM project_database_connections
      WHERE project_id = ${projectId}
        AND connection_id = ${connectionId}
    `,
  });

  const upsert: ProjectDatabaseConnectionRepositoryShape["upsert"] = (connection) =>
    upsertConnectionRow({
      projectId: connection.projectId,
      connectionId: connection.id,
      engine: connection.engine,
      label: connection.label,
      config: serializeConnectionConfig(connection),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectDatabaseConnectionRepository.upsert:query",
          "ProjectDatabaseConnectionRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByProjectId: ProjectDatabaseConnectionRepositoryShape["listByProjectId"] = (input) =>
    listConnectionRowsByProject(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectDatabaseConnectionRepository.listByProjectId:query",
          "ProjectDatabaseConnectionRepository.listByProjectId:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeConnectionRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectDatabaseConnectionRepository.listByProjectId:rowToConnection",
                ),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const getById: ProjectDatabaseConnectionRepositoryShape["getById"] = (input) =>
    getConnectionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectDatabaseConnectionRepository.getById:query",
          "ProjectDatabaseConnectionRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeConnectionRow(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectDatabaseConnectionRepository.getById:rowToConnection",
                ),
              ),
              Effect.map((connection) => Option.some(connection)),
            ),
        }),
      ),
    );

  const deleteById: ProjectDatabaseConnectionRepositoryShape["deleteById"] = (input) =>
    deleteConnectionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectDatabaseConnectionRepository.deleteById:query"),
      ),
    );

  return {
    upsert,
    listByProjectId,
    getById,
    deleteById,
  } satisfies ProjectDatabaseConnectionRepositoryShape;
});

export const ProjectDatabaseConnectionRepositoryLive = Layer.effect(
  ProjectDatabaseConnectionRepository,
  makeProjectDatabaseConnectionRepository,
);
