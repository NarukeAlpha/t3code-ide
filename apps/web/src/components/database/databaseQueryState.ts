import * as Schema from "effect/Schema";
import { type EnvironmentId, DatabaseConnectionId, type ProjectId } from "@t3tools/contracts";

export const DATABASE_QUERY_MAX_VISIBLE_ROWS = 4;

export const NullableDatabaseConnectionId = Schema.NullOr(DatabaseConnectionId);

export function deriveDatabaseQueryVisibleRows(queryText: string) {
  const lineCount = queryText.split(/\r?\n/).length;
  return Math.max(1, Math.min(DATABASE_QUERY_MAX_VISIBLE_ROWS, lineCount));
}

export function getDatabaseSelectedConnectionStorageKey(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  return `t3code:database:selected-connection:${input.environmentId}:${input.projectId}`;
}
