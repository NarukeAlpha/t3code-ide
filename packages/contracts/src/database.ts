import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const DatabaseDialect = Schema.Literals(["postgres", "mysql", "sqlite"]);
export type DatabaseDialect = typeof DatabaseDialect.Type;

export const DatabaseConnectionId = TrimmedNonEmptyString;
export type DatabaseConnectionId = typeof DatabaseConnectionId.Type;

export const DatabaseConnectionDescriptor = Schema.Struct({
  id: DatabaseConnectionId,
  name: TrimmedNonEmptyString,
  dialect: DatabaseDialect,
  summary: Schema.NullOr(TrimmedNonEmptyString),
  defaultDatabase: Schema.NullOr(TrimmedNonEmptyString),
  defaultSchema: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DatabaseConnectionDescriptor = typeof DatabaseConnectionDescriptor.Type;

export const DatabaseConnectionDraft = Schema.Struct({
  id: DatabaseConnectionId,
  name: TrimmedNonEmptyString,
  dialect: DatabaseDialect,
  summary: Schema.NullOr(TrimmedNonEmptyString),
  defaultDatabase: Schema.NullOr(TrimmedNonEmptyString),
  defaultSchema: Schema.NullOr(TrimmedNonEmptyString),
});
export type DatabaseConnectionDraft = typeof DatabaseConnectionDraft.Type;

export const PostgresDatabaseSecret = Schema.Struct({
  dialect: Schema.Literal("postgres"),
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  username: TrimmedNonEmptyString,
  password: Schema.optional(Schema.String),
  database: Schema.optional(TrimmedNonEmptyString),
  ssl: Schema.optional(Schema.Boolean),
});
export type PostgresDatabaseSecret = typeof PostgresDatabaseSecret.Type;

export const MysqlDatabaseSecret = Schema.Struct({
  dialect: Schema.Literal("mysql"),
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  username: TrimmedNonEmptyString,
  password: Schema.optional(Schema.String),
  database: Schema.optional(TrimmedNonEmptyString),
  ssl: Schema.optional(Schema.Boolean),
});
export type MysqlDatabaseSecret = typeof MysqlDatabaseSecret.Type;

export const SqliteDatabaseSecret = Schema.Struct({
  dialect: Schema.Literal("sqlite"),
  filePath: TrimmedNonEmptyString,
});
export type SqliteDatabaseSecret = typeof SqliteDatabaseSecret.Type;

export const DatabaseConnectionSecret = Schema.Union([
  PostgresDatabaseSecret,
  MysqlDatabaseSecret,
  SqliteDatabaseSecret,
]);
export type DatabaseConnectionSecret = typeof DatabaseConnectionSecret.Type;

export const DatabaseUpsertConnectionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectId: ProjectId,
  connection: DatabaseConnectionDraft,
  secret: DatabaseConnectionSecret,
});
export type DatabaseUpsertConnectionInput = typeof DatabaseUpsertConnectionInput.Type;

export const DatabaseDeleteConnectionInput = Schema.Struct({
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type DatabaseDeleteConnectionInput = typeof DatabaseDeleteConnectionInput.Type;

export const DatabaseTestConnectionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  secret: DatabaseConnectionSecret,
});
export type DatabaseTestConnectionInput = typeof DatabaseTestConnectionInput.Type;

export const DatabaseGetSchemaInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
});
export type DatabaseGetSchemaInput = typeof DatabaseGetSchemaInput.Type;

export const DatabaseRunReadOnlyQueryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectId: ProjectId,
  connectionId: DatabaseConnectionId,
  sql: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(5_000))),
});
export type DatabaseRunReadOnlyQueryInput = typeof DatabaseRunReadOnlyQueryInput.Type;

export const DatabaseTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  message: TrimmedNonEmptyString,
});
export type DatabaseTestConnectionResult = typeof DatabaseTestConnectionResult.Type;

export const DatabaseSchemaNodeKind = Schema.Literals([
  "database",
  "schema",
  "table",
  "view",
  "column",
]);
export type DatabaseSchemaNodeKind = typeof DatabaseSchemaNodeKind.Type;

const DatabaseSchemaChild = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: DatabaseSchemaNodeKind,
  name: TrimmedNonEmptyString,
  path: Schema.Array(TrimmedNonEmptyString),
  dataType: Schema.NullOr(TrimmedNonEmptyString),
  nullable: Schema.optional(Schema.Boolean),
});

const DatabaseSchemaNodeSchema = Schema.Struct({
  ...DatabaseSchemaChild.fields,
  children: Schema.Array(DatabaseSchemaChild),
});
export const DatabaseSchemaNode = DatabaseSchemaNodeSchema;
export type DatabaseSchemaNode = typeof DatabaseSchemaNode.Type;

export const DatabaseSchemaResult = Schema.Struct({
  connectionId: DatabaseConnectionId,
  nodes: Schema.Array(DatabaseSchemaNode),
  fetchedAt: IsoDateTime,
});
export type DatabaseSchemaResult = typeof DatabaseSchemaResult.Type;

export const DatabaseQueryColumn = Schema.Struct({
  name: TrimmedNonEmptyString,
  dataType: Schema.NullOr(TrimmedNonEmptyString),
  nullable: Schema.optional(Schema.Boolean),
});
export type DatabaseQueryColumn = typeof DatabaseQueryColumn.Type;

export const DatabaseQueryRow = Schema.Record(Schema.String, Schema.Unknown);
export type DatabaseQueryRow = typeof DatabaseQueryRow.Type;

export const DatabaseQueryTruncationReason = Schema.Literals(["row_limit", "payload_size"]);
export type DatabaseQueryTruncationReason = typeof DatabaseQueryTruncationReason.Type;

export const DatabaseReadOnlyQueryResult = Schema.Struct({
  columns: Schema.Array(DatabaseQueryColumn),
  rows: Schema.Array(DatabaseQueryRow),
  rowCount: NonNegativeInt,
  limitApplied: PositiveInt,
  durationMs: NonNegativeInt,
  outputBytes: NonNegativeInt,
  truncated: Schema.Boolean,
  truncationReasons: Schema.Array(DatabaseQueryTruncationReason),
});
export type DatabaseReadOnlyQueryResult = typeof DatabaseReadOnlyQueryResult.Type;

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Database error in ${this.operation}: ${this.detail}`;
  }
}
