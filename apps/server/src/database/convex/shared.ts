import * as Path from "node:path";
import { access } from "node:fs/promises";

import { DatabaseError } from "@t3tools/contracts";

export const CONVEX_DATABASE_SCHEMA_NAME = "tables";
export const CONVEX_DEFAULT_SCHEMA_FILE_PATH = "convex/schema.ts";
export const CONVEX_HTTP_ROUTE_PATH = "/t3code/database";
export const CONVEX_SHARED_SECRET_ENV_VAR = "T3CODE_CONVEX_SHARED_SECRET";
export const CONVEX_SHARED_SECRET_HEADER = "x-t3code-shared-secret";
export const CONVEX_PREFILL_ENV_VARS = [
  "NEXT_PUBLIC_CONVEX_URL",
  "VITE_CONVEX_URL",
  "REACT_APP_CONVEX_URL",
  "CONVEX_URL",
] as const;

function toPosixRelativePath(input: string) {
  return input.replaceAll("\\", "/");
}

export function toDatabaseError(message: string, cause?: unknown) {
  return new DatabaseError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function normalizeConvexGatewayBaseUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw toDatabaseError("Convex gateway base URL must be a valid URL.", cause);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw toDatabaseError("Convex gateway base URL must use http or https.");
  }

  return url.origin;
}

export function deriveConvexGatewayBaseUrl(input: string) {
  const normalized = normalizeConvexGatewayBaseUrl(input);
  const url = new URL(normalized);

  if (url.hostname.endsWith(".convex.site")) {
    return url.origin;
  }

  if (!url.hostname.endsWith(".convex.cloud")) {
    return null;
  }

  url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return url.origin;
}

export function resolveProjectRelativePathWithinRoot(projectRoot: string, relativePath: string) {
  const normalizedInputPath = relativePath.trim();
  if (normalizedInputPath.length === 0 || Path.isAbsolute(normalizedInputPath)) {
    throw toDatabaseError("Project-relative paths must stay within the project root.");
  }

  const absolutePath = Path.resolve(projectRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(Path.relative(projectRoot, absolutePath));
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith("../") ||
    Path.isAbsolute(relativeToRoot)
  ) {
    throw toDatabaseError("Project-relative paths must stay within the project root.");
  }

  return {
    absolutePath,
    relativePath: relativeToRoot,
  };
}
