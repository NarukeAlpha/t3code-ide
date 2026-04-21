import {
  DatabaseColumn,
  DatabaseError,
  DatabaseRow,
  DatabaseTableName,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { CONVEX_HTTP_ROUTE_PATH, CONVEX_SHARED_SECRET_HEADER, toDatabaseError } from "./shared.ts";

const CONVEX_GATEWAY_TIMEOUT_MS = 10_000;

const ConvexGatewayErrorResponse = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Literal(false),
  errorCode: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

const ConvexGatewayPingResponse = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Literal(true),
});

const ConvexGatewayPreviewResponse = Schema.Struct({
  version: Schema.Literal(1),
  ok: Schema.Literal(true),
  tableName: DatabaseTableName,
  page: PositiveInt,
  pageSize: PositiveInt,
  totalRowCount: NonNegativeInt,
  hasNextPage: Schema.Boolean,
  columns: Schema.Array(DatabaseColumn),
  rows: Schema.Array(DatabaseRow),
});

type ConvexGatewayPreviewResponse = typeof ConvexGatewayPreviewResponse.Type;

function buildConvexGatewayUrl(gatewayBaseUrl: string) {
  return new URL(CONVEX_HTTP_ROUTE_PATH, `${gatewayBaseUrl}/`).toString();
}

function summarizeGatewayResponseText(responseText: string) {
  const collapsed = responseText.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length <= 240) {
    return collapsed;
  }
  return `${collapsed.slice(0, 237)}...`;
}

async function parseJsonResponse(response: Response) {
  const responseText = await response.text();
  if (responseText.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch (cause) {
    throw toDatabaseError(
      `Convex gateway returned a non-JSON response (status ${response.status}): ${summarizeGatewayResponseText(responseText)}`,
      cause,
    );
  }
}

async function callConvexGateway<T>(input: {
  readonly gatewayBaseUrl: string;
  readonly sharedSecret: string;
  readonly body: Record<string, unknown>;
  readonly responseSchema: Schema.Schema<T>;
}): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CONVEX_GATEWAY_TIMEOUT_MS);

  try {
    const response = await fetch(buildConvexGatewayUrl(input.gatewayBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CONVEX_SHARED_SECRET_HEADER]: input.sharedSecret,
      },
      body: JSON.stringify(input.body),
      signal: abortController.signal,
    });
    const payload = await parseJsonResponse(response);

    if (payload !== null && Schema.is(ConvexGatewayErrorResponse)(payload)) {
      throw toDatabaseError(payload.message, payload);
    }

    if (!response.ok) {
      throw toDatabaseError(
        `Convex gateway request failed with status ${response.status}.`,
        payload,
      );
    }

    try {
      return Schema.decodeUnknownSync(input.responseSchema as any)(payload) as T;
    } catch (cause) {
      throw toDatabaseError("Convex gateway returned an unexpected response shape.", cause);
    }
  } catch (cause) {
    if (Schema.is(DatabaseError)(cause)) {
      throw cause;
    }
    throw toDatabaseError("Failed to reach the Convex gateway.", cause);
  } finally {
    clearTimeout(timeout);
  }
}

export async function pingConvexGateway(input: {
  readonly gatewayBaseUrl: string;
  readonly sharedSecret: string;
}) {
  await callConvexGateway({
    gatewayBaseUrl: input.gatewayBaseUrl,
    sharedSecret: input.sharedSecret,
    body: {
      version: 1,
      op: "ping",
    },
    responseSchema: ConvexGatewayPingResponse,
  });
}

export async function previewConvexTable(input: {
  readonly gatewayBaseUrl: string;
  readonly sharedSecret: string;
  readonly tableName: string;
  readonly page: number;
  readonly pageSize: number;
}): Promise<ConvexGatewayPreviewResponse> {
  return callConvexGateway({
    gatewayBaseUrl: input.gatewayBaseUrl,
    sharedSecret: input.sharedSecret,
    body: {
      version: 1,
      op: "previewTable",
      tableName: input.tableName,
      page: input.page,
      pageSize: input.pageSize,
    },
    responseSchema: ConvexGatewayPreviewResponse,
  });
}
