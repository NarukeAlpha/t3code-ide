import type { GitGraphCell, GitGraphNode, GitGraphRow } from "@t3tools/contracts";

const GRAPH_ROW_MARKER = "\u001f";
const GRAPH_ROW_METADATA_SEPARATOR = "\u0000";

function normalizeGraphPrefix(value: string): string {
  return value.replace(/\s+$/u, "");
}

function parseCommitPayload(payload: string): GitGraphNode | null {
  const [oid, parentLine, shortOid, authoredAtEpoch, authorName, subject] = payload.split(
    GRAPH_ROW_METADATA_SEPARATOR,
  );
  const normalizedOid = oid?.trim() ?? "";
  if (normalizedOid.length === 0) {
    return null;
  }

  const authoredAtSeconds = Number.parseInt(authoredAtEpoch ?? "", 10);
  const authoredAt = Number.isFinite(authoredAtSeconds)
    ? new Date(authoredAtSeconds * 1000).toISOString()
    : new Date(0).toISOString();
  const normalizedParentLine = parentLine?.trim() ?? "";

  return {
    oid: normalizedOid,
    shortOid: shortOid?.trim() || normalizedOid.slice(0, 7),
    parentOids:
      normalizedParentLine.length === 0
        ? []
        : normalizedParentLine.split(/\s+/u).filter((value) => value.length > 0),
    subject: subject?.trim() || "(no subject)",
    authoredAt,
    authorName: authorName?.trim() || "Unknown author",
    isHead: false,
    isMergeCommit:
      normalizedParentLine.split(/\s+/u).filter((value) => value.length > 0).length > 1,
  };
}

function parseGraphCells(prefix: string): ReadonlyArray<GitGraphCell> {
  return Array.from(prefix).flatMap((glyph, column) => {
    if (glyph === " ") {
      return [];
    }
    return [
      {
        column,
        glyph,
        lane: Math.floor(column / 2),
      } satisfies GitGraphCell,
    ];
  });
}

export function parseGitLogGraphRows(stdout: string): {
  readonly rows: ReadonlyArray<GitGraphRow>;
  readonly maxColumns: number;
  readonly commitCount: number;
} {
  const rows: GitGraphRow[] = [];
  let maxColumns = 0;
  let commitCount = 0;

  for (const [rowIndex, rawLine] of stdout.split("\n").entries()) {
    if (rawLine.length === 0) {
      continue;
    }

    const markerIndex = rawLine.indexOf(GRAPH_ROW_MARKER);
    const prefix = normalizeGraphPrefix(
      markerIndex === -1 ? rawLine : rawLine.slice(0, markerIndex),
    );
    const commit =
      markerIndex === -1
        ? null
        : parseCommitPayload(rawLine.slice(markerIndex + GRAPH_ROW_MARKER.length));

    if (commit) {
      commitCount += 1;
    }

    maxColumns = Math.max(maxColumns, prefix.length);
    rows.push({
      id: commit ? commit.oid : `graph:${rowIndex}`,
      cells: [...parseGraphCells(prefix)],
      commit,
    });
  }

  return {
    rows,
    maxColumns,
    commitCount,
  };
}

export const GIT_LOG_GRAPH_FORMAT = ["%x1f%H", "%P", "%h", "%ct", "%an", "%s"].join("%x00");
