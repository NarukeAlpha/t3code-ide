import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseExecuteQueryResult,
  DatabasePreviewTableResult,
  DatabaseSchemaInfo,
  DatabaseTableInfo,
} from "@t3tools/contracts";

import type { DatabaseDriver } from "../Services/DatabaseManager.ts";
import {
  createCommandResult,
  createPreviewResult,
  inferSqlCommand,
  normalizeRows,
  parseDatabaseCount,
  quoteAnsiIdentifier,
  DATABASE_PREVIEW_PAGE_SIZE,
} from "./shared.ts";

export interface SqliteDriverConfig {
  readonly filePath: string;
}

const listSqliteSchemas = async (): Promise<ReadonlyArray<DatabaseSchemaInfo>> => [
  { name: "main" },
];

export async function createSqliteDriver(config: SqliteDriverConfig): Promise<DatabaseDriver> {
  const db = new DatabaseSync(config.filePath);

  const listTables = async (schemaName: string): Promise<ReadonlyArray<DatabaseTableInfo>> => {
    const schema = schemaName.trim().length > 0 ? schemaName : "main";
    const statement = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `);
    const rows = statement.all() as unknown as ReadonlyArray<{ readonly name: string }>;
    return rows.map((row) => ({
      schemaName: schema,
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
    const countStatement = db.prepare(`
      SELECT COUNT(*) AS totalRowCount
      FROM ${quoteAnsiIdentifier(input.schemaName)}.${quoteAnsiIdentifier(input.tableName)}
    `);
    const countRow = countStatement.get() as { readonly totalRowCount?: unknown } | undefined;
    const statement = db.prepare(`
      SELECT *
      FROM ${quoteAnsiIdentifier(input.schemaName)}.${quoteAnsiIdentifier(input.tableName)}
      LIMIT ${limit}
      OFFSET ${offset}
    `);
    const rows = statement.all() as ReadonlyArray<Record<string, unknown>>;
    const columns = statement.columns().map((column) => ({
      name: column.name,
      databaseType: column.type ?? null,
    }));
    return createPreviewResult({
      schemaName: input.schemaName,
      tableName: input.tableName,
      page: input.page,
      totalRowCount: parseDatabaseCount(countRow?.totalRowCount, "Total row count"),
      columns,
      rows: normalizeRows(rows),
    });
  };

  const executeQuery = async (sqlText: string): Promise<DatabaseExecuteQueryResult> => {
    const statement = db.prepare(sqlText);
    const columns = statement.columns().map((column) => ({
      name: column.name,
      databaseType: column.type ?? null,
    }));
    if (columns.length > 0) {
      const rows = statement.all() as ReadonlyArray<Record<string, unknown>>;
      return {
        kind: "rows",
        command: inferSqlCommand(sqlText),
        columns,
        rows: normalizeRows(rows),
        rowCount: rows.length,
      };
    }
    const result = statement.run() as { readonly changes?: number };
    return createCommandResult({
      command: inferSqlCommand(sqlText),
      affectedRowCount: typeof result.changes === "number" ? result.changes : null,
    });
  };

  return {
    testConnection: async () => {
      db.exec("SELECT 1");
    },
    listSchemas: listSqliteSchemas,
    listTables,
    previewTable,
    executeQuery,
    dispose: async () => {
      db.close();
    },
  };
}
