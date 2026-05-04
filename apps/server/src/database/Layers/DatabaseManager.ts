import * as Path from "node:path";

import {
  DatabaseConnectionId,
  DatabaseDatabaseName,
  DatabaseError,
  DatabaseHost,
  DatabaseInspectConvexProjectResult,
  DatabasePort,
  DatabaseScaffoldConvexHelpersResult,
  DatabaseUsername,
  type DatabaseConnectionDraft,
  type DatabaseDeleteConnectionResult,
  type DatabaseExecuteQueryInput,
  type DatabaseListConnectionsResult,
  type DatabaseListSchemasResult,
  type DatabaseListTablesResult,
  type DatabasePreviewTableInput,
  type DatabaseTestConnectionResult,
  type DatabaseUpsertConnectionResult,
  type ProjectId,
  type SavedDatabaseConnection,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { inspectConvexProject } from "../convex/ProjectInspector.ts";
import { scaffoldConvexHelpers } from "../convex/Scaffolder.ts";
import {
  normalizeConvexGatewayBaseUrl,
  toDatabaseError as createConvexDatabaseError,
} from "../convex/shared.ts";
import { ProjectDatabaseConnectionRepository } from "../Services/ProjectDatabaseConnectionRepository.ts";
import { ProjectDatabaseConnectionSecrets } from "../Services/ProjectDatabaseConnectionSecrets.ts";
import { ProjectDatabaseConnectionSharedSecrets } from "../Services/ProjectDatabaseConnectionSharedSecrets.ts";
import {
  DatabaseManager,
  type DatabaseDriver,
  type DatabaseManagerShape,
} from "../Services/DatabaseManager.ts";
import { createConvexDriver, type ConvexDriverConfig } from "../drivers/convex.ts";
import { createMysqlDriver, type MysqlDriverConfig } from "../drivers/mysql.ts";
import { createPostgresDriver, type PostgresDriverConfig } from "../drivers/postgres.ts";
import { findTrailingSqlAfterFirstStatement } from "../drivers/shared.ts";
import { createSqliteDriver, type SqliteDriverConfig } from "../drivers/sqlite.ts";

const CACHED_DRIVER_IDLE_TTL_MS = 5 * 60 * 1000;

type SavedSqliteConnection = Extract<SavedDatabaseConnection, { readonly engine: "sqlite" }>;
type SavedMysqlConnection = Extract<SavedDatabaseConnection, { readonly engine: "mysql" }>;
type SavedPostgresConnection = Extract<SavedDatabaseConnection, { readonly engine: "postgres" }>;
type SavedConvexConnection = Extract<SavedDatabaseConnection, { readonly engine: "convex" }>;

type SqliteResolvedRuntimeConnection = {
  readonly connection: SavedSqliteConnection;
  readonly runtime: SqliteDriverConfig;
  readonly password: null;
};

type MysqlResolvedRuntimeConnection = {
  readonly connection: SavedMysqlConnection;
  readonly runtime: MysqlDriverConfig;
  readonly password: string | null;
};

type PostgresResolvedRuntimeConnection = {
  readonly connection: SavedPostgresConnection;
  readonly runtime: PostgresDriverConfig;
  readonly password: string | null;
};

type ConvexResolvedRuntimeConnection = {
  readonly connection: SavedConvexConnection;
  readonly runtime: ConvexDriverConfig;
  readonly password: null;
  readonly sharedSecret: string;
};

type NetworkResolvedRuntimeConnection =
  | MysqlResolvedRuntimeConnection
  | PostgresResolvedRuntimeConnection;

type ResolvedRuntimeConnection =
  | SqliteResolvedRuntimeConnection
  | NetworkResolvedRuntimeConnection
  | ConvexResolvedRuntimeConnection;

interface NormalizedDraft {
  readonly projectId: ProjectId;
  readonly connection: SavedDatabaseConnection;
  readonly password: string | null;
  readonly sharedSecret: string | null;
}

interface CachedDriverEntry {
  readonly fingerprint: string;
  readonly driver: DatabaseDriver;
  lastUsedAtMs: number;
}

const decodeDatabaseHost = Schema.decodeUnknownSync(DatabaseHost);
const decodeDatabasePort = Schema.decodeUnknownSync(DatabasePort);
const decodeDatabaseName = Schema.decodeUnknownSync(DatabaseDatabaseName);
const decodeDatabaseUsername = Schema.decodeUnknownSync(DatabaseUsername);

function toDatabaseError(message: string, cause?: unknown) {
  return new DatabaseError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function mapUnknownToDatabaseError(message: string) {
  return (cause: unknown) =>
    Schema.is(DatabaseError)(cause) ? cause : toDatabaseError(message, cause);
}

function defaultPortForEngine(engine: "mysql" | "postgres") {
  return engine === "mysql" ? 3306 : 5432;
}

function resolveSslFromDsn(url: URL) {
  const ssl = url.searchParams.get("ssl");
  if (ssl !== null) {
    return ["1", "true", "yes", "require"].includes(ssl.toLowerCase());
  }
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode !== null) {
    return !["disable", "allow", "prefer"].includes(sslMode.toLowerCase());
  }
  return false;
}

function stripIgnorableSqlPrefix(sqlText: string) {
  let remaining = sqlText;
  while (remaining.length > 0) {
    const trimmed = remaining.trimStart();
    if (trimmed.startsWith("--")) {
      const newlineIndex = trimmed.indexOf("\n");
      remaining = newlineIndex >= 0 ? trimmed.slice(newlineIndex + 1) : "";
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const closeIndex = trimmed.indexOf("*/");
      remaining = closeIndex >= 0 ? trimmed.slice(closeIndex + 2) : "";
      continue;
    }
    return trimmed;
  }
  return "";
}

function validateSingleStatementSql(sqlText: string) {
  const trimmed = sqlText.trim();
  if (trimmed.length === 0) {
    throw toDatabaseError("Enter a SQL statement before running it.");
  }
  const trailing = findTrailingSqlAfterFirstStatement(trimmed);
  const normalizedTrailing = trailing === null ? "" : stripIgnorableSqlPrefix(trailing);
  if (normalizedTrailing.length > 0) {
    throw toDatabaseError("Only a single SQL statement is supported right now.");
  }
  return trimmed;
}

function parseNetworkDsn(input: { readonly engine: "mysql" | "postgres"; readonly dsn: string }) {
  let url: URL;
  try {
    url = new URL(input.dsn);
  } catch (cause) {
    throw toDatabaseError(`Invalid ${input.engine} DSN.`, cause);
  }

  const protocols = input.engine === "mysql" ? ["mysql:", "mysql2:"] : ["postgres:", "postgresql:"];
  if (!protocols.includes(url.protocol)) {
    throw toDatabaseError(`Invalid ${input.engine} DSN protocol.`);
  }

  const databaseName = url.pathname.replace(/^\/+/, "");
  if (databaseName.length === 0) {
    throw toDatabaseError("Database name is required.");
  }

  if (url.hostname.trim().length === 0) {
    throw toDatabaseError("Host is required.");
  }

  if (url.username.trim().length === 0) {
    throw toDatabaseError("User is required.");
  }

  const port =
    url.port.length > 0 ? Number.parseInt(url.port, 10) : defaultPortForEngine(input.engine);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw toDatabaseError("Port must be between 1 and 65535.");
  }

  return {
    host: decodeDatabaseHost(url.hostname),
    port: decodeDatabasePort(port),
    database: decodeDatabaseName(databaseName),
    user: decodeDatabaseUsername(decodeURIComponent(url.username)),
    password: url.password.length > 0 ? decodeURIComponent(url.password) : null,
    ssl: resolveSslFromDsn(url),
  };
}

function isSqliteResolvedRuntimeConnection(
  resolved: ResolvedRuntimeConnection,
): resolved is SqliteResolvedRuntimeConnection {
  return resolved.connection.engine === "sqlite";
}

function isMysqlResolvedRuntimeConnection(
  resolved: ResolvedRuntimeConnection,
): resolved is MysqlResolvedRuntimeConnection {
  return resolved.connection.engine === "mysql";
}

function isConvexResolvedRuntimeConnection(
  resolved: ResolvedRuntimeConnection,
): resolved is ConvexResolvedRuntimeConnection {
  return resolved.connection.engine === "convex";
}

function buildFingerprint(resolved: ResolvedRuntimeConnection) {
  if (isSqliteResolvedRuntimeConnection(resolved)) {
    return JSON.stringify({
      engine: "sqlite",
      filePath: resolved.runtime.filePath,
    });
  }
  if (isConvexResolvedRuntimeConnection(resolved)) {
    return JSON.stringify({
      engine: "convex",
      gatewayBaseUrl: resolved.runtime.gatewayBaseUrl,
      schemaFilePath: resolved.runtime.schemaFilePath,
      sharedSecret: resolved.sharedSecret,
    });
  }
  return JSON.stringify({
    engine: resolved.connection.engine,
    host: resolved.runtime.host,
    port: resolved.runtime.port,
    database: resolved.runtime.database,
    user: resolved.runtime.user,
    password: resolved.runtime.password,
    ssl: resolved.runtime.ssl,
  });
}

function makeCacheKey(projectId: string, connectionId: DatabaseConnectionId) {
  return `${projectId}:${connectionId}`;
}

async function disposeDriverQuietly(driver: DatabaseDriver) {
  try {
    await driver.dispose();
  } catch {
    // Best-effort cache cleanup.
  }
}

const makeDatabaseManager = Effect.gen(function* () {
  const connections = yield* ProjectDatabaseConnectionRepository;
  const secrets = yield* ProjectDatabaseConnectionSecrets;
  const sharedSecrets = yield* ProjectDatabaseConnectionSharedSecrets;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cachedDrivers = new Map<string, CachedDriverEntry>();

  const sweepExpiredCachedDrivers = Effect.tryPromise({
    try: async () => {
      const now = Date.now();
      const expired = Array.from(cachedDrivers.entries()).filter(
        ([, entry]) => now - entry.lastUsedAtMs > CACHED_DRIVER_IDLE_TTL_MS,
      );
      await Promise.all(
        expired.map(async ([key, entry]) => {
          cachedDrivers.delete(key);
          await disposeDriverQuietly(entry.driver);
        }),
      );
    },
    catch: mapUnknownToDatabaseError("Failed to sweep cached database drivers."),
  });

  const resolveProjectRoot = (projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(mapUnknownToDatabaseError("Failed to load project details.")),
      Effect.flatMap((projectOption) =>
        Option.match(projectOption, {
          onNone: () => Effect.fail(toDatabaseError(`Project ${projectId} was not found.`)),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const resolveSavedConnection = (input: {
    readonly projectId: ProjectId;
    readonly connectionId: DatabaseConnectionId;
  }) =>
    connections.getById(input).pipe(
      Effect.mapError(mapUnknownToDatabaseError("Failed to load database connection.")),
      Effect.flatMap((connectionOption) =>
        Option.match(connectionOption, {
          onNone: () =>
            Effect.fail(
              toDatabaseError(`Database connection ${input.connectionId} was not found.`),
            ),
          onSome: (connection) => Effect.succeed(connection),
        }),
      ),
    );

  const resolveConnectionPassword = (input: {
    readonly projectId: ProjectId;
    readonly connectionId: DatabaseConnectionId;
  }) =>
    secrets
      .getPassword(input)
      .pipe(Effect.mapError(mapUnknownToDatabaseError("Failed to read database credentials.")));

  const resolveConnectionSharedSecret = (input: {
    readonly projectId: ProjectId;
    readonly connectionId: DatabaseConnectionId;
  }) =>
    sharedSecrets
      .getSharedSecret(input)
      .pipe(Effect.mapError(mapUnknownToDatabaseError("Failed to read Convex shared secret.")));

  const resolveRuntimeConnection = (connection: SavedDatabaseConnection, projectId: ProjectId) =>
    Effect.gen(function* () {
      switch (connection.engine) {
        case "sqlite": {
          const projectRoot = yield* resolveProjectRoot(projectId);
          return {
            connection,
            runtime: {
              filePath: Path.isAbsolute(connection.filePath)
                ? connection.filePath
                : Path.resolve(projectRoot, connection.filePath),
            },
            password: null,
          } satisfies SqliteResolvedRuntimeConnection;
        }
        case "mysql": {
          const password = yield* resolveConnectionPassword({
            projectId,
            connectionId: connection.id,
          });
          return {
            connection,
            runtime: {
              host: connection.host,
              port: connection.port,
              database: connection.database,
              user: connection.user,
              password,
              ssl: connection.ssl,
            },
            password,
          } satisfies MysqlResolvedRuntimeConnection;
        }
        case "postgres": {
          const password = yield* resolveConnectionPassword({
            projectId,
            connectionId: connection.id,
          });
          return {
            connection,
            runtime: {
              host: connection.host,
              port: connection.port,
              database: connection.database,
              user: connection.user,
              password,
              ssl: connection.ssl,
            },
            password,
          } satisfies PostgresResolvedRuntimeConnection;
        }
        case "convex": {
          const projectRoot = yield* resolveProjectRoot(projectId);
          const sharedSecret = yield* resolveConnectionSharedSecret({
            projectId,
            connectionId: connection.id,
          });
          if (sharedSecret === null) {
            return yield* toDatabaseError(
              `Convex connection ${connection.id} is missing its shared secret. Edit the connection and save it again.`,
            );
          }
          return {
            connection,
            runtime: {
              projectRoot,
              schemaFilePath: connection.schemaFilePath,
              gatewayBaseUrl: connection.gatewayBaseUrl,
              sharedSecret,
            },
            password: null,
            sharedSecret,
          } satisfies ConvexResolvedRuntimeConnection;
        }
      }
    });

  const createDriver = (resolved: ResolvedRuntimeConnection) =>
    Effect.tryPromise({
      try: async () => {
        if (isSqliteResolvedRuntimeConnection(resolved)) {
          return createSqliteDriver(resolved.runtime);
        }
        if (isConvexResolvedRuntimeConnection(resolved)) {
          return createConvexDriver(resolved.runtime);
        }
        if (isMysqlResolvedRuntimeConnection(resolved)) {
          return createMysqlDriver(resolved.runtime);
        }
        return createPostgresDriver(resolved.runtime);
      },
      catch: mapUnknownToDatabaseError("Failed to connect to the database."),
    });

  const getCachedNetworkDriver = (
    resolved: NetworkResolvedRuntimeConnection,
    projectId: ProjectId,
  ) =>
    Effect.gen(function* () {
      yield* sweepExpiredCachedDrivers;

      const cacheKey = makeCacheKey(projectId, resolved.connection.id);
      const fingerprint = buildFingerprint(resolved);
      const now = Date.now();
      const cached = cachedDrivers.get(cacheKey);
      if (cached && cached.fingerprint === fingerprint) {
        cached.lastUsedAtMs = now;
        return cached.driver;
      }

      if (cached) {
        cachedDrivers.delete(cacheKey);
        yield* Effect.tryPromise({
          try: () => disposeDriverQuietly(cached.driver),
          catch: mapUnknownToDatabaseError("Failed to reset cached database driver."),
        });
      }

      const driver = yield* createDriver(resolved);
      cachedDrivers.set(cacheKey, {
        fingerprint,
        driver,
        lastUsedAtMs: now,
      });
      return driver;
    });

  const withResolvedDriver = <T>(
    resolved: ResolvedRuntimeConnection,
    projectId: ProjectId,
    fn: (driver: DatabaseDriver) => Promise<T>,
  ) =>
    Effect.gen(function* () {
      if (
        isSqliteResolvedRuntimeConnection(resolved) ||
        isConvexResolvedRuntimeConnection(resolved)
      ) {
        const driver = yield* createDriver(resolved);
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return await fn(driver);
            } finally {
              await disposeDriverQuietly(driver);
            }
          },
          catch: mapUnknownToDatabaseError("Database operation failed."),
        });
      }
      const driver = yield* getCachedNetworkDriver(resolved, projectId);
      return yield* Effect.tryPromise({
        try: () => fn(driver),
        catch: mapUnknownToDatabaseError("Database operation failed."),
      });
    });

  const invalidateConnection: DatabaseManagerShape["invalidateConnection"] = ({
    projectId,
    connection,
  }) =>
    Effect.tryPromise({
      try: async () => {
        const key = makeCacheKey(projectId, connection.id);
        const cached = cachedDrivers.get(key);
        if (!cached) {
          return;
        }
        cachedDrivers.delete(key);
        await disposeDriverQuietly(cached.driver);
      },
      catch: () => toDatabaseError("Failed to invalidate cached database connection."),
    }).pipe(Effect.orDie);

  const writeConnectionSecrets = (input: {
    readonly projectId: ProjectId;
    readonly connectionId: DatabaseConnectionId;
    readonly password: string | null;
    readonly sharedSecret: string | null;
  }) =>
    Effect.all(
      [
        input.password === null
          ? secrets.removePassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
            })
          : secrets.setPassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
              password: input.password,
            }),
        input.sharedSecret === null
          ? sharedSecrets.removeSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
            })
          : sharedSecrets.setSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
              sharedSecret: input.sharedSecret,
            }),
      ],
      {
        concurrency: "unbounded",
        discard: true,
      },
    ).pipe(Effect.mapError(mapUnknownToDatabaseError("Failed to store database credentials.")));

  const restoreConnectionSecrets = (input: {
    readonly projectId: ProjectId;
    readonly connectionId: DatabaseConnectionId;
    readonly password: string | null;
    readonly sharedSecret: string | null;
  }) =>
    Effect.all(
      [
        input.password === null
          ? secrets.removePassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
            })
          : secrets.setPassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
              password: input.password,
            }),
        input.sharedSecret === null
          ? sharedSecrets.removeSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
            })
          : sharedSecrets.setSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
              sharedSecret: input.sharedSecret,
            }),
      ],
      {
        concurrency: "unbounded",
        discard: true,
      },
    ).pipe(Effect.ignore({ log: true }));

  const normalizeDraft = (
    input: DatabaseConnectionDraft,
  ): Effect.Effect<NormalizedDraft, DatabaseError> =>
    Effect.gen(function* () {
      const previousPassword =
        input.connectionId === undefined
          ? null
          : yield* resolveConnectionPassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
            });

      const previousSharedSecret =
        input.connectionId === undefined
          ? null
          : yield* resolveConnectionSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
            });

      const previousConnection =
        input.connectionId === undefined
          ? Option.none<SavedDatabaseConnection>()
          : yield* connections
              .getById({
                projectId: input.projectId,
                connectionId: input.connectionId,
              })
              .pipe(
                Effect.mapError(mapUnknownToDatabaseError("Failed to load database connection.")),
              );

      const now = new Date().toISOString();
      const connectionId =
        input.connectionId ?? DatabaseConnectionId.make(`database-${crypto.randomUUID()}`);
      const createdAt = Option.match(previousConnection, {
        onNone: () => now,
        onSome: (connection) => connection.createdAt,
      });

      switch (input.engine) {
        case "sqlite":
          return {
            projectId: input.projectId,
            connection: {
              id: connectionId,
              engine: "sqlite",
              label: input.label,
              filePath: input.filePath,
              createdAt,
              updatedAt: now,
            },
            password: null,
            sharedSecret: null,
          };
        case "mysql":
        case "postgres": {
          const normalized =
            input.inputMode === "dsn"
              ? yield* Effect.try({
                  try: () => parseNetworkDsn({ engine: input.engine, dsn: input.dsn }),
                  catch: mapUnknownToDatabaseError("Invalid database connection."),
                })
              : {
                  host: input.host,
                  port: input.port,
                  database: input.database,
                  user: input.user,
                  password: input.password ?? null,
                  ssl: input.ssl,
                };

          const password =
            input.inputMode === "dsn"
              ? (normalized.password ?? input.password ?? previousPassword ?? null)
              : (input.password ?? previousPassword ?? null);

          return {
            projectId: input.projectId,
            connection: {
              id: connectionId,
              engine: input.engine,
              label: input.label,
              host: normalized.host,
              port: normalized.port,
              database: normalized.database,
              user: normalized.user,
              ssl: normalized.ssl,
              createdAt,
              updatedAt: now,
            },
            password,
            sharedSecret: null,
          };
        }
        case "convex": {
          const gatewayBaseUrl = yield* Effect.try({
            try: () => normalizeConvexGatewayBaseUrl(input.gatewayBaseUrl),
            catch: mapUnknownToDatabaseError("Invalid Convex connection."),
          });

          return {
            projectId: input.projectId,
            connection: {
              id: connectionId,
              engine: "convex",
              label: input.label,
              gatewayBaseUrl,
              schemaFilePath: input.schemaFilePath,
              syncTarget: input.syncTarget,
              createdAt,
              updatedAt: now,
            },
            password: null,
            sharedSecret: input.sharedSecret ?? previousSharedSecret ?? null,
          };
        }
      }
    });

  const testResolvedConnection = (
    projectId: ProjectId,
    connection: SavedDatabaseConnection,
    password: string | null,
    sharedSecret: string | null,
  ) =>
    Effect.gen(function* () {
      const resolved =
        connection.engine === "sqlite"
          ? yield* resolveRuntimeConnection(connection, projectId)
          : connection.engine === "mysql"
            ? ({
                connection,
                runtime: {
                  host: connection.host,
                  port: connection.port,
                  database: connection.database,
                  user: connection.user,
                  password,
                  ssl: connection.ssl,
                },
                password,
              } satisfies MysqlResolvedRuntimeConnection)
            : connection.engine === "postgres"
              ? ({
                  connection,
                  runtime: {
                    host: connection.host,
                    port: connection.port,
                    database: connection.database,
                    user: connection.user,
                    password,
                    ssl: connection.ssl,
                  },
                  password,
                } satisfies PostgresResolvedRuntimeConnection)
              : ({
                  connection,
                  runtime: {
                    projectRoot: yield* resolveProjectRoot(projectId),
                    schemaFilePath: connection.schemaFilePath,
                    gatewayBaseUrl: connection.gatewayBaseUrl,
                    sharedSecret:
                      sharedSecret ??
                      (() => {
                        throw createConvexDatabaseError(
                          "Convex connections require a shared secret before they can be tested.",
                        );
                      })(),
                  },
                  password: null,
                  sharedSecret:
                    sharedSecret ??
                    (() => {
                      throw createConvexDatabaseError(
                        "Convex connections require a shared secret before they can be tested.",
                      );
                    })(),
                } satisfies ConvexResolvedRuntimeConnection);

      const driver = yield* createDriver(resolved);
      yield* Effect.tryPromise({
        try: async () => {
          try {
            await driver.testConnection();
          } finally {
            await disposeDriverQuietly(driver);
          }
        },
        catch: mapUnknownToDatabaseError("Failed to connect to the database."),
      });
    });

  const listConnections: DatabaseManagerShape["listConnections"] = (input) =>
    connections.listByProjectId(input).pipe(
      Effect.mapError(mapUnknownToDatabaseError("Failed to load database connections.")),
      Effect.map(
        (savedConnections): DatabaseListConnectionsResult => ({
          connections: savedConnections,
        }),
      ),
    );

  const upsertConnection: DatabaseManagerShape["upsertConnection"] = (input) =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDraft(input);
      const previousPassword =
        input.connectionId === undefined
          ? null
          : yield* resolveConnectionPassword({
              projectId: input.projectId,
              connectionId: input.connectionId,
            });
      const previousSharedSecret =
        input.connectionId === undefined
          ? null
          : yield* resolveConnectionSharedSecret({
              projectId: input.projectId,
              connectionId: input.connectionId,
            });

      yield* testResolvedConnection(
        input.projectId,
        normalized.connection,
        normalized.password,
        normalized.sharedSecret,
      );
      yield* writeConnectionSecrets({
        projectId: input.projectId,
        connectionId: normalized.connection.id,
        password: normalized.password,
        sharedSecret: normalized.sharedSecret,
      });

      yield* connections
        .upsert({
          projectId: normalized.projectId,
          ...normalized.connection,
        })
        .pipe(
          Effect.mapError(mapUnknownToDatabaseError("Failed to save database connection.")),
          Effect.catch((error) =>
            restoreConnectionSecrets({
              projectId: input.projectId,
              connectionId: normalized.connection.id,
              password: previousPassword,
              sharedSecret: previousSharedSecret,
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      yield* invalidateConnection({
        projectId: input.projectId,
        connection: normalized.connection,
      });

      return {
        connection: normalized.connection,
      } satisfies DatabaseUpsertConnectionResult;
    });

  const deleteConnection: DatabaseManagerShape["deleteConnection"] = (input) =>
    Effect.gen(function* () {
      const connection = yield* resolveSavedConnection(input);
      const previousPassword = yield* resolveConnectionPassword(input);
      const previousSharedSecret = yield* resolveConnectionSharedSecret(input);

      yield* writeConnectionSecrets({
        projectId: input.projectId,
        connectionId: input.connectionId,
        password: null,
        sharedSecret: null,
      }).pipe(Effect.mapError(mapUnknownToDatabaseError("Failed to remove database credentials.")));

      yield* connections.deleteById(input).pipe(
        Effect.mapError(mapUnknownToDatabaseError("Failed to delete database connection.")),
        Effect.catch((error) =>
          restoreConnectionSecrets({
            projectId: input.projectId,
            connectionId: input.connectionId,
            password: previousPassword,
            sharedSecret: previousSharedSecret,
          }).pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );

      yield* invalidateConnection({
        projectId: input.projectId,
        connection,
      });

      return {
        connectionId: input.connectionId,
      } satisfies DatabaseDeleteConnectionResult;
    });

  const testConnection: DatabaseManagerShape["testConnection"] = (input) =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDraft(input);
      yield* testResolvedConnection(
        input.projectId,
        normalized.connection,
        normalized.password,
        normalized.sharedSecret,
      );
      return {
        ok: true,
      } satisfies DatabaseTestConnectionResult;
    });

  const inspectConvexProjectForManager: DatabaseManagerShape["inspectConvexProject"] = (input) =>
    resolveProjectRoot(input.projectId).pipe(
      Effect.flatMap((projectRoot) =>
        Effect.tryPromise({
          try: () => inspectConvexProject({ projectRoot }),
          catch: mapUnknownToDatabaseError("Failed to inspect the Convex project."),
        }),
      ),
      Effect.map((result): DatabaseInspectConvexProjectResult => result),
    );

  const scaffoldConvexHelpersForManager: DatabaseManagerShape["scaffoldConvexHelpers"] = (input) =>
    resolveProjectRoot(input.projectId).pipe(
      Effect.flatMap((projectRoot) =>
        Effect.tryPromise({
          try: () =>
            scaffoldConvexHelpers({
              projectRoot,
              syncTarget: input.syncTarget,
            }),
          catch: mapUnknownToDatabaseError("Failed to scaffold Convex helper files."),
        }),
      ),
      Effect.map((result): DatabaseScaffoldConvexHelpersResult => result),
    );

  const listSchemas: DatabaseManagerShape["listSchemas"] = (input) =>
    Effect.gen(function* () {
      const connection = yield* resolveSavedConnection(input);
      const resolved = yield* resolveRuntimeConnection(connection, input.projectId);
      const schemas = yield* withResolvedDriver(resolved, input.projectId, (driver) =>
        driver.listSchemas(),
      );
      return {
        schemas,
      } satisfies DatabaseListSchemasResult;
    });

  const listTables: DatabaseManagerShape["listTables"] = (input) =>
    Effect.gen(function* () {
      const connection = yield* resolveSavedConnection(input);
      const resolved = yield* resolveRuntimeConnection(connection, input.projectId);
      const tables = yield* withResolvedDriver(resolved, input.projectId, (driver) =>
        driver.listTables(input.schemaName),
      );
      return {
        tables,
      } satisfies DatabaseListTablesResult;
    });

  const previewTable: DatabaseManagerShape["previewTable"] = (input: DatabasePreviewTableInput) =>
    Effect.gen(function* () {
      const connection = yield* resolveSavedConnection(input);
      const resolved = yield* resolveRuntimeConnection(connection, input.projectId);
      return yield* withResolvedDriver(resolved, input.projectId, (driver) =>
        driver.previewTable({
          schemaName: input.schemaName,
          tableName: input.tableName,
          page: input.page ?? 1,
        }),
      );
    });

  const executeQuery: DatabaseManagerShape["executeQuery"] = (input: DatabaseExecuteQueryInput) =>
    Effect.gen(function* () {
      const sqlText = yield* Effect.try({
        try: () => validateSingleStatementSql(input.sql),
        catch: mapUnknownToDatabaseError("Failed to validate SQL query."),
      });
      const connection = yield* resolveSavedConnection(input);
      const resolved = yield* resolveRuntimeConnection(connection, input.projectId);
      return yield* withResolvedDriver(resolved, input.projectId, (driver) =>
        driver.executeQuery(sqlText),
      );
    }).pipe(
      Effect.mapError(
        (error): DatabaseError =>
          Schema.is(DatabaseError)(error)
            ? error
            : toDatabaseError("Failed to execute query.", error),
      ),
    );

  return {
    listConnections,
    upsertConnection,
    deleteConnection,
    testConnection,
    inspectConvexProject: inspectConvexProjectForManager,
    scaffoldConvexHelpers: scaffoldConvexHelpersForManager,
    listSchemas,
    listTables,
    previewTable,
    executeQuery,
    invalidateConnection,
  } satisfies DatabaseManagerShape;
});

export const DatabaseManagerLive = Layer.effect(DatabaseManager, makeDatabaseManager);
