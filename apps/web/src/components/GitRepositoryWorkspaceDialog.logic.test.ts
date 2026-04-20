import type { GitHubWorkspaceSnapshot, GitRecentGraphResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  countRecentGraphCommits,
  resolveActiveWorkspacePullRequest,
  workspacePullRequestKey,
} from "./GitRepositoryWorkspaceDialog.logic";

function makeWorkspace(): GitHubWorkspaceSnapshot {
  return {
    availability: {
      kind: "available",
      message: "GitHub workspace is available.",
    },
    pullRequests: [
      {
        repository: "NarukeAlpha/t3code-ide",
        number: 1,
        title: "Fork PR",
        url: "https://github.com/NarukeAlpha/t3code-ide/pull/1",
        state: "open",
        isDraft: false,
        body: "",
        author: null,
        reviewDecision: null,
        baseBranch: "main",
        headBranch: "feature/upstream-sync-ide-expansion",
        headSha: "6117667085320c65b8fc6c4f13f42d9039a6005b",
        createdAt: "2026-04-17T05:21:05.000Z",
        updatedAt: "2026-04-17T05:23:10.000Z",
        comments: [],
        reviews: [],
        checks: [],
        runs: [],
      },
      {
        repository: "pingdotgg/t3code",
        number: 2101,
        title: "Upstream PR",
        url: "https://github.com/pingdotgg/t3code/pull/2101",
        state: "open",
        isDraft: false,
        body: "",
        author: null,
        reviewDecision: null,
        baseBranch: "main",
        headBranch: "feature/upstream-sync-ide-expansion",
        headSha: "54179c86f2cb0cab0ef0d9af09d6b6b1206a1b9b",
        createdAt: "2026-04-17T05:20:00.000Z",
        updatedAt: "2026-04-17T05:22:00.000Z",
        comments: [],
        reviews: [],
        checks: [],
        runs: [],
      },
    ],
    activePullRequest: {
      repository: "NarukeAlpha/t3code-ide",
      number: 1,
    },
    fetchedAt: "2026-04-17T05:24:00.000Z",
  };
}

describe("resolveActiveWorkspacePullRequest", () => {
  it("defaults to the server-selected active pull request", () => {
    const workspace = makeWorkspace();

    expect(resolveActiveWorkspacePullRequest(workspace, null)?.repository).toBe(
      "NarukeAlpha/t3code-ide",
    );
    expect(resolveActiveWorkspacePullRequest(workspace, null)?.number).toBe(1);
  });

  it("preserves a locally selected pull request when the same key still exists", () => {
    const workspace = makeWorkspace();
    const selectedKey = workspacePullRequestKey({
      repository: "pingdotgg/t3code",
      number: 2101,
    });

    expect(resolveActiveWorkspacePullRequest(workspace, selectedKey)?.repository).toBe(
      "pingdotgg/t3code",
    );
  });

  it("falls back to the server-selected pull request when the previous selection disappears", () => {
    const workspace = makeWorkspace();
    const nextWorkspace: GitHubWorkspaceSnapshot = {
      ...workspace,
      pullRequests: [workspace.pullRequests[0]!],
    };
    const staleKey = workspacePullRequestKey({
      repository: "pingdotgg/t3code",
      number: 2101,
    });

    expect(resolveActiveWorkspacePullRequest(nextWorkspace, staleKey)?.repository).toBe(
      "NarukeAlpha/t3code-ide",
    );
    expect(resolveActiveWorkspacePullRequest(nextWorkspace, staleKey)?.number).toBe(1);
  });
});

describe("countRecentGraphCommits", () => {
  it("counts only commit rows and ignores continuation rows", () => {
    const graph: GitRecentGraphResult = {
      rows: [
        {
          id: "commit-1",
          cells: [{ column: 0, glyph: "*", lane: 0 }],
          commit: {
            oid: "commit-1",
            shortOid: "commit-1",
            parentOids: ["commit-0"],
            subject: "Commit 1",
            authoredAt: "2026-04-17T05:00:00.000Z",
            authorName: "Test User",
            isHead: true,
            isMergeCommit: false,
          },
        },
        {
          id: "graph:1",
          cells: [{ column: 0, glyph: "|", lane: 0 }],
          commit: null,
        },
        {
          id: "commit-0",
          cells: [{ column: 0, glyph: "*", lane: 0 }],
          commit: {
            oid: "commit-0",
            shortOid: "commit-0",
            parentOids: [],
            subject: "Commit 0",
            authoredAt: "2026-04-17T04:00:00.000Z",
            authorName: "Test User",
            isHead: false,
            isMergeCommit: false,
          },
        },
      ],
      maxColumns: 1,
      refs: [],
      topology: {
        headOid: "commit-1",
        headBranch: "feature/demo",
        defaultBranch: "main",
        worktrees: [],
      },
      truncated: false,
    };

    expect(countRecentGraphCommits(graph)).toBe(2);
  });
});
