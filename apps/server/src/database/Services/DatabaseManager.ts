import type {
  DatabaseDeleteConnectionInput,
  DatabaseDeleteConnectionResult,
  DatabaseError,
  DatabaseExecuteQueryInput,
  DatabaseExecuteQueryResult,
  DatabaseInspectConvexProjectInput,
  DatabaseInspectConvexProjectResult,
  DatabaseListConnectionsInput,
  DatabaseListConnectionsResult,
  DatabaseListSchemasInput,
  DatabaseListSchemasResult,
  DatabaseListTablesInput,
  DatabaseListTablesResult,
  DatabasePreviewTableInput,
  DatabaseScaffoldConvexHelpersInput,
  DatabaseScaffoldConvexHelpersResult,
  DatabasePreviewTableResult,
  DatabaseTestConnectionInput,
  DatabaseTestConnectionResult,
  DatabaseUpsertConnectionInput,
  DatabaseUpsertConnectionResult,
  DatabaseSchemaInfo,
  DatabaseTableInfo,
  SavedDatabaseConnection,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface DatabaseDriver {
  readonly testConnection: () => Promise<void>;
  readonly listSchemas: () => Promise<ReadonlyArray<DatabaseSchemaInfo>>;
  readonly listTables: (schemaName: string) => Promise<ReadonlyArray<DatabaseTableInfo>>;
  readonly previewTable: (input: {
    readonly schemaName: string;
    readonly tableName: string;
    readonly page: number;
  }) => Promise<DatabasePreviewTableResult>;
  readonly executeQuery: (sqlText: string) => Promise<DatabaseExecuteQueryResult>;
  readonly dispose: () => Promise<void>;
}

export interface DatabaseManagerShape {
  readonly listConnections: (
    input: DatabaseListConnectionsInput,
  ) => Effect.Effect<DatabaseListConnectionsResult, DatabaseError>;
  readonly upsertConnection: (
    input: DatabaseUpsertConnectionInput,
  ) => Effect.Effect<DatabaseUpsertConnectionResult, DatabaseError>;
  readonly deleteConnection: (
    input: DatabaseDeleteConnectionInput,
  ) => Effect.Effect<DatabaseDeleteConnectionResult, DatabaseError>;
  readonly testConnection: (
    input: DatabaseTestConnectionInput,
  ) => Effect.Effect<DatabaseTestConnectionResult, DatabaseError>;
  readonly inspectConvexProject: (
    input: DatabaseInspectConvexProjectInput,
  ) => Effect.Effect<DatabaseInspectConvexProjectResult, DatabaseError>;
  readonly scaffoldConvexHelpers: (
    input: DatabaseScaffoldConvexHelpersInput,
  ) => Effect.Effect<DatabaseScaffoldConvexHelpersResult, DatabaseError>;
  readonly listSchemas: (
    input: DatabaseListSchemasInput,
  ) => Effect.Effect<DatabaseListSchemasResult, DatabaseError>;
  readonly listTables: (
    input: DatabaseListTablesInput,
  ) => Effect.Effect<DatabaseListTablesResult, DatabaseError>;
  readonly previewTable: (
    input: DatabasePreviewTableInput,
  ) => Effect.Effect<DatabasePreviewTableResult, DatabaseError>;
  readonly executeQuery: (
    input: DatabaseExecuteQueryInput,
  ) => Effect.Effect<DatabaseExecuteQueryResult, DatabaseError>;
  readonly invalidateConnection: (input: {
    readonly projectId: string;
    readonly connection: SavedDatabaseConnection;
  }) => Effect.Effect<void, never>;
}

export class DatabaseManager extends Context.Service<DatabaseManager, DatabaseManagerShape>()(
  "t3/database/Services/DatabaseManager",
) {}
