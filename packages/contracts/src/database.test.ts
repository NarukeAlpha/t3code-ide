import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DatabaseConnectionDraft,
  DatabaseExecuteQueryInput,
  DatabaseExecuteQueryResult,
  DatabasePreviewTableResult,
  SavedDatabaseConnection,
} from "./database.ts";

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("SavedDatabaseConnection", () => {
  it("accepts normalized sqlite connections", () => {
    expect(
      decodes(SavedDatabaseConnection, {
        id: "connection-sqlite",
        engine: "sqlite",
        label: "Local DB",
        filePath: "./data/app.sqlite",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("accepts normalized network connections without secrets", () => {
    expect(
      decodes(SavedDatabaseConnection, {
        id: "connection-postgres",
        engine: "postgres",
        label: "Primary",
        host: "db.internal",
        port: 5432,
        database: "app",
        user: "postgres",
        ssl: true,
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("DatabaseConnectionDraft", () => {
  it("accepts mysql DSN drafts", () => {
    expect(
      decodes(DatabaseConnectionDraft, {
        projectId: "project-1",
        engine: "mysql",
        inputMode: "dsn",
        label: "Reporting",
        dsn: "mysql://user:secret@localhost:3306/reporting",
      }),
    ).toBe(true);
  });

  it("accepts postgres manual drafts", () => {
    expect(
      decodes(DatabaseConnectionDraft, {
        projectId: "project-1",
        engine: "postgres",
        inputMode: "manual",
        label: "Analytics",
        host: "localhost",
        port: 5432,
        database: "analytics",
        user: "postgres",
        password: "secret",
        ssl: false,
      }),
    ).toBe(true);
  });

  it("rejects missing connection fields", () => {
    expect(
      decodes(DatabaseConnectionDraft, {
        projectId: "project-1",
        engine: "mysql",
        inputMode: "manual",
        label: "Broken",
        host: "localhost",
        port: 3306,
      }),
    ).toBe(false);
  });
});

describe("DatabaseExecuteQueryInput", () => {
  it("accepts multi-line SQL input", () => {
    expect(
      decodes(DatabaseExecuteQueryInput, {
        projectId: "project-1",
        connectionId: "connection-1",
        sql: "select *\nfrom users\nwhere id = 1;",
      }),
    ).toBe(true);
  });
});

describe("DatabaseExecuteQueryResult", () => {
  it("accepts row-set results", () => {
    expect(
      decodes(DatabaseExecuteQueryResult, {
        kind: "rows",
        command: "SELECT",
        columns: [
          { name: "id", databaseType: "INTEGER" },
          { name: "name", databaseType: "TEXT" },
        ],
        rows: [{ id: 1, name: "Ada" }],
        rowCount: 1,
      }),
    ).toBe(true);
  });

  it("accepts command summary results", () => {
    expect(
      decodes(DatabaseExecuteQueryResult, {
        kind: "command",
        command: "UPDATE",
        affectedRowCount: 3,
        message: "Updated 3 rows.",
      }),
    ).toBe(true);
  });
});

describe("DatabasePreviewTableResult", () => {
  it("accepts preview results with total row counts", () => {
    expect(
      decodes(DatabasePreviewTableResult, {
        schemaName: "main",
        tableName: "users",
        page: 1,
        pageSize: 100,
        totalRowCount: 245,
        hasNextPage: true,
        columns: [
          { name: "id", databaseType: "INTEGER" },
          { name: "name", databaseType: "TEXT" },
        ],
        rows: [{ id: 1, name: "Ada" }],
      }),
    ).toBe(true);
  });
});
