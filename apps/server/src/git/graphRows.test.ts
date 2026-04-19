import { describe, expect, it } from "vitest";

import { parseGitLogGraphRows } from "./graphRows.ts";

function commitLine(input: {
  prefix: string;
  oid: string;
  parentOids?: ReadonlyArray<string>;
  shortOid?: string;
  authoredAtEpoch?: number;
  authorName?: string;
  subject?: string;
}): string {
  const {
    prefix,
    oid,
    parentOids = [],
    shortOid = oid.slice(0, 7),
    authoredAtEpoch = 1_713_331_200,
    authorName = "Test User",
    subject = oid,
  } = input;
  return `${prefix}\u001f${oid}\u0000${parentOids.join(" ")}\u0000${shortOid}\u0000${authoredAtEpoch}\u0000${authorName}\u0000${subject}`;
}

describe("parseGitLogGraphRows", () => {
  it("parses linear history into commit rows", () => {
    const stdout = [
      commitLine({
        prefix: "*",
        oid: "commit-2",
        parentOids: ["commit-1"],
        subject: "Commit 2",
      }),
      commitLine({
        prefix: "*",
        oid: "commit-1",
        parentOids: ["commit-0"],
        subject: "Commit 1",
      }),
    ].join("\n");

    const result = parseGitLogGraphRows(stdout);

    expect(result.commitCount).toBe(2);
    expect(result.maxColumns).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      id: "commit-2",
      cells: [{ column: 0, glyph: "*", lane: 0 }],
      commit: expect.objectContaining({
        oid: "commit-2",
        parentOids: ["commit-1"],
        subject: "Commit 2",
        isMergeCommit: false,
      }),
    });
  });

  it("keeps continuation rows for merge topology", () => {
    const stdout = [
      commitLine({
        prefix: "*",
        oid: "merge-1",
        parentOids: ["main-1", "side-1"],
        subject: "Merge branch",
      }),
      "|\\",
      commitLine({
        prefix: "| *",
        oid: "side-1",
        parentOids: ["base-1"],
        subject: "Side commit",
      }),
      "|/",
      commitLine({
        prefix: "*",
        oid: "base-1",
        subject: "Base commit",
      }),
    ].join("\n");

    const result = parseGitLogGraphRows(stdout);

    expect(result.commitCount).toBe(3);
    expect(result.rows[0]?.commit?.isMergeCommit).toBe(true);
    expect(result.rows[1]).toEqual({
      id: "graph:1",
      cells: [
        { column: 0, glyph: "|", lane: 0 },
        { column: 1, glyph: "\\", lane: 0 },
      ],
      commit: null,
    });
    expect(result.rows[2]?.cells).toEqual([
      { column: 0, glyph: "|", lane: 0 },
      { column: 2, glyph: "*", lane: 1 },
    ]);
  });

  it("tracks the widest rendered graph prefix across diverging rows", () => {
    const stdout = [
      commitLine({
        prefix: "*",
        oid: "head-1",
        parentOids: ["base-2"],
        subject: "Head commit",
      }),
      commitLine({
        prefix: "| *",
        oid: "side-2",
        parentOids: ["base-2"],
        subject: "Side branch",
      }),
      "|/",
      commitLine({
        prefix: "*",
        oid: "base-2",
        parentOids: ["root-1"],
        subject: "Base commit",
      }),
    ].join("\n");

    const result = parseGitLogGraphRows(stdout);

    expect(result.maxColumns).toBe(3);
    expect(result.rows[1]?.cells).toEqual([
      { column: 0, glyph: "|", lane: 0 },
      { column: 2, glyph: "*", lane: 1 },
    ]);
  });

  it("parses a multi-lane upstream-sync style slice without losing branch scaffolding", () => {
    const stdout = [
      commitLine({
        prefix: "*",
        oid: "bf5c741d",
        parentOids: ["61176670", "54179c86"],
        shortOid: "bf5c741",
        subject: "Merge upstream/main into feature/upstream-sync-ide-expansion",
      }),
      "|\\",
      commitLine({
        prefix: "| *",
        oid: "54179c86",
        parentOids: ["8d32969"],
        shortOid: "54179c8",
        subject: "Update workflow to use ubuntu-24.04 runner (#2110)",
      }),
      commitLine({
        prefix: "* |",
        oid: "61176670",
        parentOids: ["f07e8354"],
        shortOid: "6117667",
        subject: "feat: enhance project script management and add filesystem browse query resolver",
      }),
      "|/",
      commitLine({
        prefix: "*",
        oid: "f07e8354",
        parentOids: ["e6217d1f"],
        shortOid: "f07e835",
        subject: "refactor: split opencode changes to separate branch",
      }),
    ].join("\n");

    const result = parseGitLogGraphRows(stdout);

    expect(result.commitCount).toBe(4);
    expect(result.maxColumns).toBe(3);
    expect(result.rows.map((row) => row.id)).toEqual([
      "bf5c741d",
      "graph:1",
      "54179c86",
      "61176670",
      "graph:4",
      "f07e8354",
    ]);
    expect(result.rows[3]?.cells).toEqual([
      { column: 0, glyph: "*", lane: 0 },
      { column: 2, glyph: "|", lane: 1 },
    ]);
  });
});
