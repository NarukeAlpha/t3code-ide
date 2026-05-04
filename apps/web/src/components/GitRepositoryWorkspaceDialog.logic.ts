import type {
  GitHubWorkspacePullRequest,
  GitHubWorkspaceSnapshot,
  GitRecentGraphResult,
} from "@t3tools/contracts";

export function workspacePullRequestKey(input: { repository: string; number: number }): string {
  return `${input.repository}#${input.number}`;
}

export function resolveActiveWorkspacePullRequest(
  workspace: GitHubWorkspaceSnapshot | null | undefined,
  selectedKey: string | null,
): GitHubWorkspacePullRequest | null {
  if (!workspace || workspace.pullRequests.length === 0) {
    return null;
  }

  if (selectedKey) {
    const selected = workspace.pullRequests.find(
      (pullRequest) => workspacePullRequestKey(pullRequest) === selectedKey,
    );
    if (selected) {
      return selected;
    }
  }

  if (workspace.activePullRequest) {
    const active = workspace.pullRequests.find(
      (pullRequest) =>
        pullRequest.repository === workspace.activePullRequest?.repository &&
        pullRequest.number === workspace.activePullRequest?.number,
    );
    if (active) {
      return active;
    }
  }

  return workspace.pullRequests[0] ?? null;
}

export function countRecentGraphCommits(graph: GitRecentGraphResult): number {
  return graph.rows.reduce((count, row) => count + (row.commit ? 1 : 0), 0);
}
