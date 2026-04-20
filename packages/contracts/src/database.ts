import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const DATABASE_LABEL_MAX_LENGTH = 128;
const DATABASE_PATH_MAX_LENGTH = 1024;
const DATABASE_HOST_MAX_LENGTH = 512;
const DATABASE_DATABASE_NAME_MAX_LENGTH = 256;
const DATABASE_USER_MAX_LENGTH = 256;
const DATABASE_DSN_MAX_LENGTH = 4_096;
const DATABASE_SQL_MAX_LENGTH = 100_000;

export const DatabaseEngine = Schema.Literals(["sqlite", "mysql", "postgres"]);
export type DatabaseEngine = typeof DatabaseEngine.Type;

export const DatabaseConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("DatabaseConnectionId"),
);
export type DatabaseConnectionId = typeof DatabaseConnectionId.Type;

export const DatabaseConnectionLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_LABEL_MAX_LENGTH),
);
export type DatabaseConnectionLabel = typeof DatabaseConnectionLabel.Type;

export const DatabaseSchemaName = TrimmedNonEmptyString;
export type DatabaseSchemaName = typeof DatabaseSchemaName.Type;

export const DatabaseTableName = TrimmedNonEmptyString;
export type DatabaseTableName = typeof DatabaseTableName.Type;

export const DatabaseSqliteFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_PATH_MAX_LENGTH),
);
export type DatabaseSqliteFilePath = typeof DatabaseSqliteFilePath.Type;

export const DatabaseHost = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_HOST_MAX_LENGTH),
);
export type DatabaseHost = typeof DatabaseHost.Type;

export const DatabaseDatabaseName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_DATABASE_NAME_MAX_LENGTH),
);
export type DatabaseDatabaseName = typeof DatabaseDatabaseName.Type;

export const DatabaseUsername = TrimmedNonEmptyString.check(
  Schema.isMaxLength(DATABASE_USER_MAX_LENGTH),
);
export type DatabaseUsername = typeof DatabaseUsername.Type;

export const DatabaseDsn = TrimmedNonEmptyString.check(Schema.isMaxLength(DATABASE_DSN_MAX_LENGTH));
export type DatabaseDsn = typeof DatabaseDsn.Type;

export const DatabasePassword = Schema.String.check(Schema.isMaxLength(DATABASE_DSN_MAX_LENGTH));
export type DatabasePassword = typeof DatabasePassword.Type;

export const DatabasePort = PositiveInt.check(Schema.isLessThanOrEqualTo(65_535));
export type DatabasePort = typeof DatabasePort.Type;

export const DatabaseValue = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
]);
export type DatabaseValue = typeof DatabaseValue.Type;

export const DatabaseRow = Schema.Record(Schema.String, DatabaseValue);
export type DatabaseRow = typeof DatabaseRow.Type;

export const DatabaseColumn = Schema.Struct({
  name: Schema.String,
  databaseType: Schema.NullOr(Schema.String),
});
export type DatabaseColumn = typeof DatabaseColumn.Type;

export const SavedDatabaseSqliteConnection = Schema.Struct({
  id: DatabaseConnectionId,
  engine: Schema.Literal("sqlite"),
  label: DatabaseConnectionLabel,
  filePath: DatabaseSqliteFilePath,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedDatabaseSqliteConnection = typeof SavedDatabaseSqliteConnection.Type;

export const SavedDatabaseMysqlConnection = Schema.Struct({
  id: DatabaseConnectionId,
  engine: Schema.Literal("mysql"),
  label: DatabaseConnectionLabel,
  host: DatabaseHost,
  port: DatabasePort,
  database: DatabaseDatabaseName,
  user: DatabaseUsername,
  ssl: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedDatabaseMysqlConnection = typeof SavedDatabaseMysqlConnection.Type;

export const SavedDatabasePostgresConnection = Schema.Struct({
  id: DatabaseConnectionId,
  engine: Schema.Literal("postgres"),
  label: DatabaseConnectionLabel,
  host: DatabaseHost,
  port: DatabasePort,
  database: DatabaseDatabaseName,
  user: DatabaseUsername,
  ssl: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SavedDatabasePostgresConnection = typeof SavedDatabasePostgresConnection.Type;

export const SavedDatabaseConnection = Schema.Union([
  SavedDatabaseSqliteConnection,
  SavedDatabaseMysqlConnection,
  SavedDatabasePostgresConnection,
]);
export type SavedDatabaseConnection = typeof SavedDatabaseConnection.Type;

const DatabaseProjectScopedDraftBase = {
  projectId: ProjectId,
  connectionId: Schema.optional(DatabaseConnectionId),
  label: DatabaseConnectionLabel,
} as const;

export const DatabaseSqliteConnectionDraft = Schema.Struct({
  ...DatabaseProjectScopedDraftBase,
  engine: Schema.Literal("sqlite"),
  filePath: DatabaseSqliteFilePath,
});
export type DatabaseSqliteConnectionDraft = typeof DatabaseSqliteConnectionDraft.Type;

export const DatabaseMysqlConnectionManualDraft = Schema.Struct({
  ...DatabaseProjectScopedDraftBase,
  engine: Schema.Literal("mysql"),
  inputMode: Schema.Literal("manual"),
  host: DatabaseHost,
  port: DatabasePort,
  database: DatabaseDatabaseName,
  user: DatabaseUsername,
  password: Schema.optional(DatabasePassword),
  ssl: Schema.Boolean,
});
export type DatabaseMysqlConnectionManualDraft = typeof DatabaseMysqlConnectionManualDraft.Type;

export const DatabaseMysqlConnectionDsnDraft = Schema.Struct({
  ...DatabaseProjectScopedDraftBase,
  engine: Schema.Literal("mysql"),
  inputMode: Schema.Literal("dsn"),
  dsn: DatabaseDsn,
  password: Schema.optional(DatabasePassword),
});
export type DatabaseMysqlConnectionDsnDraft = typeof DatabaseMysqlConnectionDsnDraft.Type;

export const DatabasePostgresConnectionManualDraft = Schema.Struct({
  ...DatabaseProjectScopedDraftBase,
  engine: Schema.Literal("postgres"),
  inputMode: Schema.Literal("manual"),
  host: DatabaseHost,
  port: DatabasePort,
  database: DatabaseDatabaseName,
  user: DatabaseUsername,
  password: Schema.optional(DatabasePassword),
  ssl: Schema.Boolean,
});
export type DatabasePostgresConnectionManualDraft =
  typeof DatabasePostgresConnectionManualDraft.Type;

export const DatabasePostgresConnectionDsnDraft = Schema.Struct({
  ...DatabaseProjectScopedDraftBase,
  engine: Schema.Literal("postgres"),
  inputMode: Schema.Literal("dsn"),
  dsn: DatabaseDsn,
  password: Schema.optional(DatabasePassword),
});
export type DatabasePostgresConnectionDsnDraft = typeof DatabasePostgresConnectionDsnDraft.Type;

export const DatabaseConnectionDraft = Schema.Union([
  DatabaseSqliteConnectionDraft,
  DatabaseMysqlConnectionManualDraft,
  DatabaseMysqlConnectionDsnDraft,
  DatabasePostgresConnectionManualDraft,
  DatabasePostgresConnectionDsnDraft,
]);
export type DatabaseConnectionDraft = typeof DatabaseConnectionDraft.Type;

export const DatabaseListConnectionsInput = Schema.Struct({
  projectId: ProjectId,
});
export type DatabaseListConnectionsInput = typeof DatabaseListConnectionsInput.Type;

export const DatabaseListConnectionsResult = Schema.Struct({
  connections: Schema.Array(SavedDatabaseConnection),
});
export type DatabaseListConnectionsResult = typeof DatabaseListConnectionsResult.Type;

export const DatabaseUpsertConnectionInput = DatabaseConnectionDraft;
export type DatabaseUpsertConnectionInput = typeof DatabaseUpsertConnectionInput.Type;

export const DatabaseUpsertConnectionResult = Schema.Struct({
  connection: SavedDatabaseConnection,
});
export type DatabaseUpsertConnectionResult = typeof DatabaseUpsertConnectionResult.Type;

export const DatabaseDeleteConnectionInput = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type DatabaseDeleteConnectionInput = typeof DatabaseDeleteConnectionInput.Type;

export const DatabaseDeleteConnectionResult = Schema.Struct({
  connectionId: DatabaseConnectionId,
});
export type DatabaseDeleteConnectionResult = typeof DatabaseDeleteConnectionResult.Type;

export const DatabaseTestConnectionInput = DatabaseConnectionDraft;
export type DatabaseTestConnectionInput = typeof DatabaseTestConnectionInput.Type;

export const DatabaseTestConnectionResult = Schema.Struct({
  ok: Schema.Literal(true),
});
export type DatabaseTestConnectionResult = typeof DatabaseTestConnectionResult.Type;

const DatabaseConnectionTargetFields = {
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
} as const;

export const DatabaseListSchemasInput = Schema.Struct({
  ...DatabaseConnectionTargetFields,
});
export type DatabaseListSchemasInput = typeof DatabaseListSchemasInput.Type;

export const DatabaseSchemaInfo = Schema.Struct({
  name: DatabaseSchemaName,
});
export type DatabaseSchemaInfo = typeof DatabaseSchemaInfo.Type;

export const DatabaseListSchemasResult = Schema.Struct({
  schemas: Schema.Array(DatabaseSchemaInfo),
});
export type DatabaseListSchemasResult = typeof DatabaseListSchemasResult.Type;

export const DatabaseListTablesInput = Schema.Struct({
  ...DatabaseConnectionTargetFields,
  schemaName: DatabaseSchemaName,
});
export type DatabaseListTablesInput = typeof DatabaseListTablesInput.Type;

export const DatabaseTableInfo = Schema.Struct({
  schemaName: DatabaseSchemaName,
  name: DatabaseTableName,
});
export type DatabaseTableInfo = typeof DatabaseTableInfo.Type;

export const DatabaseListTablesResult = Schema.Struct({
  tables: Schema.Array(DatabaseTableInfo),
});
export type DatabaseListTablesResult = typeof DatabaseListTablesResult.Type;

export const DatabasePreviewTableInput = Schema.Struct({
  ...DatabaseConnectionTargetFields,
  schemaName: DatabaseSchemaName,
  tableName: DatabaseTableName,
  page: Schema.optional(PositiveInt),
});
export type DatabasePreviewTableInput = typeof DatabasePreviewTableInput.Type;

export const DatabasePreviewTableResult = Schema.Struct({
  schemaName: DatabaseSchemaName,
  tableName: DatabaseTableName,
  page: PositiveInt,
  pageSize: PositiveInt,
  totalRowCount: NonNegativeInt,
  hasNextPage: Schema.Boolean,
  columns: Schema.Array(DatabaseColumn),
  rows: Schema.Array(DatabaseRow),
});
export type DatabasePreviewTableResult = typeof DatabasePreviewTableResult.Type;

export const DatabaseExecuteQueryInput = Schema.Struct({
  ...DatabaseConnectionTargetFields,
  sql: Schema.String.check(Schema.isMaxLength(DATABASE_SQL_MAX_LENGTH)),
});
export type DatabaseExecuteQueryInput = typeof DatabaseExecuteQueryInput.Type;

export const DatabaseExecuteRowsResult = Schema.Struct({
  kind: Schema.Literal("rows"),
  command: Schema.String,
  columns: Schema.Array(DatabaseColumn),
  rows: Schema.Array(DatabaseRow),
  rowCount: NonNegativeInt,
});
export type DatabaseExecuteRowsResult = typeof DatabaseExecuteRowsResult.Type;

export const DatabaseExecuteCommandResult = Schema.Struct({
  kind: Schema.Literal("command"),
  command: Schema.String,
  affectedRowCount: Schema.NullOr(NonNegativeInt),
  message: TrimmedNonEmptyString,
});
export type DatabaseExecuteCommandResult = typeof DatabaseExecuteCommandResult.Type;

export const DatabaseExecuteQueryResult = Schema.Union([
  DatabaseExecuteRowsResult,
  DatabaseExecuteCommandResult,
]);
export type DatabaseExecuteQueryResult = typeof DatabaseExecuteQueryResult.Type;

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
