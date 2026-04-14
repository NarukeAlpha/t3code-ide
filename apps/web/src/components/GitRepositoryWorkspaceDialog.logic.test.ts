import type { GitGraphNode } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildGraphRows } from "./GitRepositoryWorkspaceDialog.logic";

function makeNode(input: {
  oid: string;
  parentOids: string[];
  shortOid?: string;
  subject?: string;
}): GitGraphNode {
  return {
    oid: input.oid,
    shortOid: input.shortOid ?? input.oid.slice(0, 7),
    subject: input.subject ?? input.oid,
    authorName: "Test User",
    authoredAt: "2026-04-13T00:00:00.000Z",
    parentOids: input.parentOids,
    isHead: false,
    isMergeCommit: input.parentOids.length > 1,
  };
}

describe("buildGraphRows", () => {
  it("keeps existing lanes stable when a new branch tip appears", () => {
    const { rows } = buildGraphRows([
      makeNode({ oid: "aaaaaaa", parentOids: ["bbbbbbb"] }),
      makeNode({ oid: "ccccccc", parentOids: ["ddddddd"] }),
      makeNode({ oid: "bbbbbbb", parentOids: ["ddddddd"] }),
      makeNode({ oid: "ddddddd", parentOids: [] }),
    ]);

    expect(rows[0]?.nodeLane).toBe(0);
    expect(rows[1]?.lanesBefore).toEqual(["bbbbbbb", "ccccccc"]);
    expect(rows[1]?.nodeLane).toBe(1);
    expect(rows[2]?.lanesBefore).toEqual(["bbbbbbb", "ddddddd"]);
    expect(rows[2]?.nodeLane).toBe(0);
  });

  it("does not duplicate parent lanes after a merge commit", () => {
    const { rows } = buildGraphRows([
      makeNode({ oid: "merge001", parentOids: ["main001", "side001"] }),
      makeNode({ oid: "main001", parentOids: ["base001"] }),
      makeNode({ oid: "side001", parentOids: ["base001"] }),
      makeNode({ oid: "base001", parentOids: [] }),
    ]);

    expect(rows[0]?.lanesAfter).toEqual(["main001", "side001"]);
    expect(rows[1]?.lanesAfter).toEqual(["base001", "side001"]);
    expect(rows[2]?.lanesAfter).toEqual(["base001"]);
  });

  it("keeps the first parent on the same lane when later lanes already exist", () => {
    const { rows } = buildGraphRows([
      makeNode({ oid: "head001", parentOids: ["main001"] }),
      makeNode({ oid: "topic001", parentOids: ["base001"] }),
      makeNode({ oid: "main001", parentOids: ["base001"] }),
      makeNode({ oid: "base001", parentOids: [] }),
    ]);

    expect(rows[1]?.lanesBefore).toEqual(["main001", "topic001"]);
    expect(rows[1]?.lanesAfter).toEqual(["main001", "base001"]);
    expect(rows[2]?.nodeLane).toBe(0);
    expect(rows[2]?.lanesAfter).toEqual(["base001"]);
  });

  it("collapses duplicate parent lanes when two tips converge", () => {
    const { rows } = buildGraphRows([
      makeNode({ oid: "left001", parentOids: ["base001"] }),
      makeNode({ oid: "right001", parentOids: ["base001"] }),
      makeNode({ oid: "base001", parentOids: [] }),
    ]);

    expect(rows[1]?.lanesBefore).toEqual(["base001", "right001"]);
    expect(rows[1]?.lanesAfter).toEqual(["base001"]);
    expect(rows[2]?.nodeLane).toBe(0);
  });
});
