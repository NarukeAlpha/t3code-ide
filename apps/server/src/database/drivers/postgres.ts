import postgres from "postgres";
import type {
  DatabaseExecuteQueryResult,
  DatabasePreviewTableResult,
  DatabaseSchemaInfo,
  DatabaseTableInfo,
} from "@t3tools/contracts";

import type { DatabaseDriver } from "../Services/DatabaseManager.ts";
import {
  createColumnsFromNames,
  createCommandResult,
  createPreviewResult,
  inferSqlCommand,
  normalizeRows,
  parseDatabaseCount,
  quoteAnsiIdentifier,
  DATABASE_PREVIEW_PAGE_SIZE,
} from "./shared.ts";

export interface PostgresDriverConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string | null;
  readonly ssl: boolean;
}

export async function createPostgresDriver(config: PostgresDriverConfig): Promise<DatabaseDriver> {
  const sql = postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    max: 1,
    prepare: false,
    ...(config.password === null ? {} : { password: config.password }),
    ...(config.ssl ? { ssl: "require" as const } : {}),
  });

  const listSchemas = async (): Promise<ReadonlyArray<DatabaseSchemaInfo>> => {
    const rows = await sql<Array<{ readonly name: string }>>`
      SELECT schema_name AS name
      FROM information_schema.schemata
      WHERE schema_name <> 'information_schema'
        AND schema_name <> 'pg_catalog'
        AND schema_name NOT LIKE 'pg_toast%'
        AND schema_name NOT LIKE 'pg_temp_%'
      ORDER BY schema_name ASC
    `;
    return rows.map((row) => ({
      name: row.name,
    }));
  };

  const listTables = async (schemaName: string): Promise<ReadonlyArray<DatabaseTableInfo>> => {
    const rows = await sql<Array<{ readonly name: string }>>`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = ${schemaName}
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;
    return rows.map((row) => ({
      schemaName,
      name: row.name,
    }));
  };

  const previewTable = async (input: {
    readonly schemaName: string;
    readonly tableName: string;
    readonly page: number;
  }): Promise<DatabasePreviewTableResult> => {
    const offset = (input.page - 1) * DATABASE_PREVIEW_PAGE_SIZE;
    const limit = DATABASE_PREVIEW_PAGE_SIZE + 1;
    const countRows = await sql.unsafe<Array<{ readonly totalRowCount?: unknown }>>(`
      SELECT COUNT(*) AS "totalRowCount"
      FROM ${quoteAnsiIdentifier(input.schemaName)}.${quoteAnsiIdentifier(input.tableName)}
    `);
    const result = await sql.unsafe(`
      SELECT *
      FROM ${quoteAnsiIdentifier(input.schemaName)}.${quoteAnsiIdentifier(input.tableName)}
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    const rows = result as ReadonlyArray<Record<string, unknown>> & {
      readonly columns?: ReadonlyArray<{ readonly name: string; readonly type?: number }>;
    };
    const columns =
      rows.columns?.map((column) => ({
        name: column.name,
        databaseType: column.type != null ? String(column.type) : null,
      })) ?? createColumnsFromNames(Object.keys(rows[0] ?? {}));
    return createPreviewResult({
      schemaName: input.schemaName,
      tableName: input.tableName,
      page: input.page,
      totalRowCount: parseDatabaseCount(countRows[0]?.totalRowCount, "Total row count"),
      columns,
      rows: normalizeRows(rows),
    });
  };

  const executeQuery = async (sqlText: string): Promise<DatabaseExecuteQueryResult> => {
    const result = await sql.unsafe(sqlText);
    const rows = result as ReadonlyArray<Record<string, unknown>> & {
      readonly columns?: ReadonlyArray<{ readonly name: string; readonly type?: number }>;
      readonly command?: string;
      readonly count?: number;
    };
    const columns =
      rows.columns?.map((column) => ({
        name: column.name,
        databaseType: column.type != null ? String(column.type) : null,
      })) ?? [];
    const command = rows.command ?? inferSqlCommand(sqlText);
    if (columns.length > 0 || rows.length > 0) {
      return {
        kind: "rows",
        command,
        columns: columns.length > 0 ? columns : createColumnsFromNames(Object.keys(rows[0] ?? {})),
        rows: normalizeRows(rows),
        rowCount: rows.length,
      };
    }
    return createCommandResult({
      command,
      affectedRowCount: typeof rows.count === "number" ? rows.count : null,
    });
  };

  return {
    testConnection: async () => {
      await sql`SELECT 1`;
    },
    listSchemas,
    listTables,
    previewTable,
    executeQuery,
    dispose: async () => {
      await sql.end({ timeout: 1 });
    },
  };
}
