import * as Path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type {
  DatabaseConvexSyncTarget,
  DatabaseScaffoldConvexHelpersResult,
} from "@t3tools/contracts";

import { runProcess } from "../../processRunner.ts";
import {
  CONVEX_HTTP_ROUTE_PATH,
  CONVEX_SHARED_SECRET_ENV_VAR,
  fileExists,
  toDatabaseError,
} from "./shared.ts";

const T3CODE_MARKER = "// t3code-convex-database-scaffold:v1";
const T3CODE_FILE_PATH = "convex/t3code.ts";
const HTTP_FILE_PATH = "convex/http.ts";
const T3CODE_HANDLER_NAME = "t3codeDatabaseHttpAction";

function asScaffoldText(
  value: string,
): DatabaseScaffoldConvexHelpersResult["writtenPaths"][number] {
  return value as DatabaseScaffoldConvexHelpersResult["writtenPaths"][number];
}

function createManualFollowUp() {
  return [
    asScaffoldText(
      `Set ${CONVEX_SHARED_SECRET_ENV_VAR} in your Convex deployment environment variables.`,
    ),
  ] satisfies DatabaseScaffoldConvexHelpersResult["manualFollowUp"];
}

function getConvexSyncArgs(syncTarget: DatabaseConvexSyncTarget) {
  return syncTarget === "dev" ? ["convex", "dev", "--once"] : ["convex", "deploy"];
}

function getConvexSyncCommand(syncTarget: DatabaseConvexSyncTarget) {
  return `npx ${getConvexSyncArgs(syncTarget).join(" ")}` as const;
}

async function syncConvexProject(input: {
  readonly projectRoot: string;
  readonly syncTarget: DatabaseConvexSyncTarget;
}) {
  const args = getConvexSyncArgs(input.syncTarget);
  const syncCommand = getConvexSyncCommand(input.syncTarget);

  try {
    await runProcess("npx", args, {
      cwd: input.projectRoot,
      timeoutMs: input.syncTarget === "dev" ? 120_000 : 180_000,
      outputMode: "truncate",
      maxBufferBytes: 512 * 1024,
    });
    return syncCommand;
  } catch (cause) {
    throw toDatabaseError(`Failed to sync Convex helpers with ${syncCommand}.`, cause);
  }
}

function createT3CodeFileContents() {
  return `${T3CODE_MARKER}
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function error(status: number, errorCode: string, message: string) {
  return json(status, {
    version: 1,
    ok: false,
    errorCode,
    message,
  });
}

function asErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unexpected Convex gateway failure.";
}

function normalizeValue(value: unknown): null | boolean | number | string {
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
  if (Array.isArray(value) || typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function normalizeRow(row: Record<string, unknown>) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  ) as Record<string, null | boolean | number | string>;

  if ("_id" in row && normalized._id === undefined) {
    normalized._id = normalizeValue(row._id);
  }
  if ("_creationTime" in row && normalized._creationTime === undefined) {
    normalized._creationTime = normalizeValue(row._creationTime);
  }

  return normalized;
}

export const ping = internalQuery({
  args: {},
  handler: async () => ({
    ok: true,
  }),
});

export const previewTable = internalQuery({
  args: {
    tableName: v.string(),
    page: v.number(),
    pageSize: v.number(),
  },
  handler: async (ctx, args) => {
    const page = Number.isSafeInteger(args.page) && args.page > 0 ? args.page : 1;
    const pageSize = Number.isSafeInteger(args.pageSize) && args.pageSize > 0 ? args.pageSize : 100;
    const dynamicDb = ctx.db as unknown as {
      query: (tableName: string) => { collect: () => Promise<Array<Record<string, unknown>>> };
    };
    const allRows = await dynamicDb.query(args.tableName).collect();
    const totalRowCount = allRows.length;
    const startIndex = (page - 1) * pageSize;
    const normalizedRows = allRows.map((row) => normalizeRow(row));
    const pageRows = normalizedRows.slice(startIndex, startIndex + pageSize);
    const columnNames = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));

    return {
      tableName: args.tableName,
      page,
      pageSize,
      totalRowCount,
      hasNextPage: startIndex + pageSize < totalRowCount,
      columns: columnNames.map((name) => ({
        name,
        databaseType: null,
      })),
      rows: pageRows,
    };
  },
});

export const ${T3CODE_HANDLER_NAME} = httpAction(async (ctx, request) => {
  try {
    const expectedSecret = process.env.${CONVEX_SHARED_SECRET_ENV_VAR};
    if (!expectedSecret) {
      return error(500, "MISSING_SHARED_SECRET", "The Convex shared secret is not configured.");
    }

    const providedSecret = request.headers.get("x-t3code-shared-secret");
    if (providedSecret !== expectedSecret) {
      return error(401, "UNAUTHORIZED", "The Convex shared secret is invalid.");
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return error(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !("version" in payload) ||
      payload.version !== 1
    ) {
      return error(400, "INVALID_REQUEST", "Request version must be 1.");
    }

    if (!("op" in payload) || typeof payload.op !== "string") {
      return error(400, "INVALID_REQUEST", "Request operation is required.");
    }

    switch (payload.op) {
      case "ping": {
        await ctx.runQuery(internal.t3code.ping, {});
        return json(200, {
          version: 1,
          ok: true,
        });
      }
      case "previewTable": {
        if (
          !("tableName" in payload) ||
          typeof payload.tableName !== "string" ||
          !("page" in payload) ||
          typeof payload.page !== "number" ||
          !("pageSize" in payload) ||
          typeof payload.pageSize !== "number"
        ) {
          return error(400, "INVALID_REQUEST", "Preview requests require tableName, page, and pageSize.");
        }

        const result = await ctx.runQuery(internal.t3code.previewTable, {
          tableName: payload.tableName,
          page: payload.page,
          pageSize: payload.pageSize,
        });
        return json(200, {
          version: 1,
          ok: true,
          ...result,
        });
      }
      default:
        return error(400, "UNSUPPORTED_OPERATION", "Unsupported T3 Code Convex operation.");
    }
  } catch (caughtError) {
    return error(500, "INTERNAL_ERROR", asErrorMessage(caughtError));
  }
});
`;
}

function createHttpFileContents() {
  return `import { httpRouter } from "convex/server";
import { ${T3CODE_HANDLER_NAME} } from "./t3code";

const http = httpRouter();

http.route({
  path: "${CONVEX_HTTP_ROUTE_PATH}",
  method: "POST",
  handler: ${T3CODE_HANDLER_NAME},
});

export default http;
`;
}

function patchHttpFileContents(sourceText: string) {
  if (sourceText.includes(CONVEX_HTTP_ROUTE_PATH) || sourceText.includes(T3CODE_HANDLER_NAME)) {
    return {
      kind: "already-present" as const,
      nextText: sourceText,
    };
  }

  if (
    !sourceText.includes("const http = httpRouter();") ||
    !sourceText.includes("export default http;")
  ) {
    throw toDatabaseError(
      `Could not patch ${HTTP_FILE_PATH} automatically. Add the ${CONVEX_HTTP_ROUTE_PATH} POST route manually.`,
    );
  }

  let nextText = sourceText;
  if (!nextText.includes(`import { ${T3CODE_HANDLER_NAME} } from "./t3code";`)) {
    const importMatches = [...nextText.matchAll(/^import .*;$/gmu)];
    const insertionIndex =
      importMatches.length > 0
        ? importMatches[importMatches.length - 1]!.index! +
          importMatches[importMatches.length - 1]![0].length
        : 0;
    nextText =
      nextText.slice(0, insertionIndex) +
      `${insertionIndex > 0 ? "\n" : ""}import { ${T3CODE_HANDLER_NAME} } from "./t3code";` +
      nextText.slice(insertionIndex);
  }

  nextText = nextText.replace(
    "export default http;",
    `http.route({\n  path: "${CONVEX_HTTP_ROUTE_PATH}",\n  method: "POST",\n  handler: ${T3CODE_HANDLER_NAME},\n});\n\nexport default http;`,
  );

  return {
    kind: "patched" as const,
    nextText,
  };
}

export async function scaffoldConvexHelpers(input: {
  readonly projectRoot: string;
  readonly syncTarget: DatabaseConvexSyncTarget;
}): Promise<DatabaseScaffoldConvexHelpersResult> {
  const convexDirectoryPath = Path.resolve(input.projectRoot, "convex");
  const t3codeAbsolutePath = Path.resolve(input.projectRoot, T3CODE_FILE_PATH);
  const httpAbsolutePath = Path.resolve(input.projectRoot, HTTP_FILE_PATH);

  const writtenPaths: Array<DatabaseScaffoldConvexHelpersResult["writtenPaths"][number]> = [];
  const alreadyPresentPaths: Array<
    DatabaseScaffoldConvexHelpersResult["alreadyPresentPaths"][number]
  > = [];

  let nextT3CodeText: string | null = null;
  const latestT3CodeText = createT3CodeFileContents();
  if (await fileExists(t3codeAbsolutePath)) {
    const existingT3CodeText = await readFile(t3codeAbsolutePath, "utf8");
    if (!existingT3CodeText.includes(T3CODE_MARKER)) {
      throw toDatabaseError(
        `Refusing to overwrite ${T3CODE_FILE_PATH}. Move the existing file or wire ${T3CODE_HANDLER_NAME} in manually.`,
      );
    }
    if (existingT3CodeText === latestT3CodeText) {
      alreadyPresentPaths.push(asScaffoldText(T3CODE_FILE_PATH));
    } else {
      nextT3CodeText = latestT3CodeText;
    }
  } else {
    nextT3CodeText = latestT3CodeText;
  }

  let nextHttpText: string | null = null;
  if (await fileExists(httpAbsolutePath)) {
    const existingHttpText = await readFile(httpAbsolutePath, "utf8");
    const patchResult = patchHttpFileContents(existingHttpText);
    if (patchResult.kind === "already-present") {
      alreadyPresentPaths.push(asScaffoldText(HTTP_FILE_PATH));
    } else {
      nextHttpText = patchResult.nextText;
    }
  } else {
    nextHttpText = createHttpFileContents();
  }

  await mkdir(convexDirectoryPath, { recursive: true });

  if (nextT3CodeText !== null) {
    await writeFile(t3codeAbsolutePath, nextT3CodeText, "utf8");
    writtenPaths.push(asScaffoldText(T3CODE_FILE_PATH));
  }

  if (nextHttpText !== null) {
    await writeFile(httpAbsolutePath, nextHttpText, "utf8");
    writtenPaths.push(asScaffoldText(HTTP_FILE_PATH));
  }

  const syncCommand = await syncConvexProject({
    projectRoot: input.projectRoot,
    syncTarget: input.syncTarget,
  });

  return {
    writtenPaths,
    alreadyPresentPaths,
    manualFollowUp: createManualFollowUp(),
    syncTarget: input.syncTarget,
    syncCommand: asScaffoldText(syncCommand),
  };
}
