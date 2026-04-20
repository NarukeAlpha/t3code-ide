import mysql from "mysql2/promise";
import type { FieldPacket, ResultSetHeader, RowDataPacket } from "mysql2/promise";
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
  quoteMysqlIdentifier,
  DATABASE_PREVIEW_PAGE_SIZE,
} from "./shared.ts";

export interface MysqlDriverConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string | null;
  readonly ssl: boolean;
}

function fieldsToColumns(fields: ReadonlyArray<FieldPacket> | undefined) {
  return (fields ?? []).map((field) => ({
    name: field.name,
    databaseType: field.columnType != null ? String(field.columnType) : null,
  }));
}

function isRowSet(value: unknown): value is ReadonlyArray<RowDataPacket> {
  return Array.isArray(value);
}

interface MysqlNamedRow extends RowDataPacket {
  readonly name: string;
}

interface MysqlCountRow extends RowDataPacket {
  readonly totalRowCount?: unknown;
}

export async function createMysqlDriver(config: MysqlDriverConfig): Promise<DatabaseDriver> {
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    multipleStatements: false,
    ...(config.password === null ? {} : { password: config.password }),
    ...(config.ssl ? { ssl: {} } : {}),
  });

  const listSchemas = async (): Promise<ReadonlyArray<DatabaseSchemaInfo>> => [
    { name: config.database },
  ];

  const listTables = async (schemaName: string): Promise<ReadonlyArray<DatabaseTableInfo>> => {
    const [rows] = await connection.query<MysqlNamedRow[]>(
      `
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_type = 'BASE TABLE'
        ORDER BY table_name ASC
      `,
      [schemaName],
    );
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
    const [countRows] = await connection.query<MysqlCountRow[]>(
      `
        SELECT COUNT(*) AS totalRowCount
        FROM ${quoteMysqlIdentifier(input.schemaName)}.${quoteMysqlIdentifier(input.tableName)}
      `,
    );
    const [rows, fields] = await connection.query<RowDataPacket[]>(
      `
        SELECT *
        FROM ${quoteMysqlIdentifier(input.schemaName)}.${quoteMysqlIdentifier(input.tableName)}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
    );
    return createPreviewResult({
      schemaName: input.schemaName,
      tableName: input.tableName,
      page: input.page,
      totalRowCount: parseDatabaseCount(countRows[0]?.totalRowCount, "Total row count"),
      columns: fieldsToColumns(fields),
      rows: normalizeRows(rows as ReadonlyArray<Record<string, unknown>>),
    });
  };

  const executeQuery = async (sqlText: string): Promise<DatabaseExecuteQueryResult> => {
    const [result, fields] = await connection.query(sqlText);
    if (isRowSet(result)) {
      const rows = result as ReadonlyArray<Record<string, unknown>>;
      return {
        kind: "rows",
        command: inferSqlCommand(sqlText),
        columns: fieldsToColumns(fields),
        rows: normalizeRows(rows),
        rowCount: rows.length,
      };
    }
    const header = result as ResultSetHeader;
    return createCommandResult({
      command: inferSqlCommand(sqlText),
      affectedRowCount: header.affectedRows,
    });
  };

  return {
    testConnection: async () => {
      await connection.ping();
    },
    listSchemas,
    listTables,
    previewTable,
    executeQuery,
    dispose: async () => {
      await connection.end();
    },
  };
}
