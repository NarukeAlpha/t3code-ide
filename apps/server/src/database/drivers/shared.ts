import {
  DatabaseColumn,
  type DatabaseExecuteCommandResult,
  type DatabasePreviewTableResult,
  type DatabaseRow,
} from "@t3tools/contracts";

export const DATABASE_PREVIEW_PAGE_SIZE = 100;

export function quoteAnsiIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteMysqlIdentifier(identifier: string) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

export function inferSqlCommand(sqlText: string): string {
  const trimmed = sqlText.trimStart();
  const match = /^[A-Za-z_]+/.exec(trimmed);
  return match ? match[0].toUpperCase() : "SQL";
}

export function findTrailingSqlAfterFirstStatement(sqlText: string): string | null {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktickQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < sqlText.length; index += 1) {
    const char = sqlText[index];
    const next = sqlText[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "'") {
        if (next === "'") {
          index += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') {
        if (next === '"') {
          index += 1;
        } else {
          inDoubleQuote = false;
        }
      }
      continue;
    }

    if (inBacktickQuote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "`") {
        if (next === "`") {
          index += 1;
        } else {
          inBacktickQuote = false;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (char === "`") {
      inBacktickQuote = true;
      continue;
    }

    if (char === ";") {
      return sqlText.slice(index + 1);
    }
  }

  return null;
}

export function normalizeDatabaseValue(value: unknown): DatabaseRow[string] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("hex");
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
  }
  return String(value);
}

export function normalizeRow(row: Record<string, unknown>): DatabaseRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeDatabaseValue(value)]),
  );
}

export function normalizeRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<DatabaseRow> {
  return rows.map(normalizeRow);
}

export function createColumnsFromNames(
  names: ReadonlyArray<string>,
  databaseType: string | null = null,
): ReadonlyArray<typeof DatabaseColumn.Type> {
  return names.map((name) => ({
    name,
    databaseType,
  }));
}

export function formatCommandMessage(command: string, affectedRowCount: number | null) {
  if (affectedRowCount === null) {
    return `${command} completed.`;
  }
  if (affectedRowCount === 1) {
    return `${command} affected 1 row.`;
  }
  return `${command} affected ${affectedRowCount} rows.`;
}

export function createCommandResult(input: {
  command: string;
  affectedRowCount: number | null;
}): DatabaseExecuteCommandResult {
  return {
    kind: "command",
    command: input.command,
    affectedRowCount: input.affectedRowCount,
    message: formatCommandMessage(input.command, input.affectedRowCount),
  };
}

export function parseDatabaseCount(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  if (typeof value === "bigint") {
    if (value >= 0 && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  throw new Error(`${label} must be a non-negative safe integer.`);
}

export function createPreviewResult(input: {
  schemaName: string;
  tableName: string;
  page: number;
  totalRowCount: number;
  columns: ReadonlyArray<typeof DatabaseColumn.Type>;
  rows: ReadonlyArray<DatabaseRow>;
}): DatabasePreviewTableResult {
  return {
    schemaName: input.schemaName,
    tableName: input.tableName,
    page: input.page,
    pageSize: DATABASE_PREVIEW_PAGE_SIZE,
    totalRowCount: input.totalRowCount,
    hasNextPage: input.rows.length > DATABASE_PREVIEW_PAGE_SIZE,
    columns: input.columns,
    rows: input.rows.slice(0, DATABASE_PREVIEW_PAGE_SIZE),
  };
}
