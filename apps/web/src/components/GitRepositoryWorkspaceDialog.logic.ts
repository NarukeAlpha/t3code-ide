import type { GitGraphNode } from "@t3tools/contracts";

export type GraphRow = {
  readonly node: GitGraphNode;
  readonly lanesBefore: ReadonlyArray<string>;
  readonly lanesAfter: ReadonlyArray<string>;
  readonly nodeLane: number;
  readonly hadExistingLane: boolean;
};

export function buildGraphRows(nodes: ReadonlyArray<GitGraphNode>) {
  let lanes: string[] = [];
  let maxLaneCount = 1;
  const rows: GraphRow[] = [];

  for (const node of nodes) {
    const existingLane = lanes.indexOf(node.oid);
    const lanesBefore = existingLane === -1 ? [...lanes, node.oid] : [...lanes];
    const nodeLane = existingLane === -1 ? lanes.length : existingLane;
    const lanesAfter = [...lanesBefore];

    if (node.parentOids.length === 0) {
      lanesAfter.splice(nodeLane, 1);
    } else {
      const firstParentOid = node.parentOids[0]!;
      const additionalParentOids = node.parentOids.slice(1);
      const firstParentLane = lanesAfter.indexOf(firstParentOid);
      let replacementLane = nodeLane;

      if (firstParentLane !== -1) {
        lanesAfter.splice(firstParentLane, 1);
        if (firstParentLane < replacementLane) {
          replacementLane -= 1;
        }
      }
      lanesAfter[replacementLane] = firstParentOid;

      let insertAt = replacementLane + 1;
      for (const parentOid of additionalParentOids) {
        const existingParentLane = lanesAfter.indexOf(parentOid);
        if (existingParentLane !== -1) {
          lanesAfter.splice(existingParentLane, 1);
          if (existingParentLane < insertAt) {
            insertAt -= 1;
          }
        }
        lanesAfter.splice(insertAt, 0, parentOid);
        insertAt += 1;
      }
    }

    maxLaneCount = Math.max(maxLaneCount, lanesBefore.length, lanesAfter.length, nodeLane + 1);
    rows.push({
      node,
      lanesBefore,
      lanesAfter,
      nodeLane,
      hadExistingLane: existingLane !== -1,
    });
    lanes = lanesAfter;
  }

  return {
    rows,
    maxLaneCount,
  };
}
