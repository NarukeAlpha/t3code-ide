import {
  type EnvironmentId,
  type GitActionProgressEvent,
  type GitHubPullRequestFilters,
  type GitHubWorkflowTarget,
  type GitStackedAction,
  type ThreadId,
} from "@t3tools/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureEnvironmentApi } from "../environmentApi";
import { requireEnvironmentConnection } from "../environments/runtime";

const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;
const GIT_HUB_PULL_REQUEST_DETAIL_STALE_TIME_MS = 10_000;
const GIT_HUB_WORKFLOW_STALE_TIME_MS = 5_000;

function normalizeGitHubPullRequestFilterKey(filters?: GitHubPullRequestFilters | null) {
  return {
    search: filters?.search?.trim() ?? "",
    state: filters?.state ?? "open",
    review: filters?.review ?? "any",
    author: filters?.author?.trim() ?? "",
    assignee: filters?.assignee?.trim() ?? "",
    baseBranch: filters?.baseBranch?.trim() ?? "",
    headBranch: filters?.headBranch?.trim() ?? "",
    labels: [...(filters?.labels ?? [])].toSorted(),
    draft: filters?.draft ?? "any",
    sort: filters?.sort ?? "updated",
  } as const;
}

function normalizeGitHubWorkflowTargetKey(target: GitHubWorkflowTarget | null) {
  if (!target) {
    return null;
  }

  return target.kind === "pull_request"
    ? {
        kind: target.kind,
        repository: target.repository,
        number: target.number,
      }
    : {
        kind: target.kind,
        remoteName: target.remoteName,
        branch: target.branch,
      };
}

function gitHubBaseQueryKey(environmentId: EnvironmentId | null, cwd: string | null) {
  return ["git", "github", environmentId ?? null, cwd] as const;
}

export const gitQueryKeys = {
  all: ["git"] as const,
  github: (environmentId: EnvironmentId | null, cwd: string | null) =>
    gitHubBaseQueryKey(environmentId, cwd),
  branches: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "branches", environmentId ?? null, cwd] as const,
  branchSearch: (environmentId: EnvironmentId | null, cwd: string | null, query: string) =>
    ["git", "branches", environmentId ?? null, cwd, "search", query] as const,
  recentGraph: (environmentId: EnvironmentId | null, cwd: string | null, limit: number) =>
    ["git", "recent-graph", environmentId ?? null, cwd, limit] as const,
  githubWorkspace: (environmentId: EnvironmentId | null, cwd: string | null) =>
    [...gitHubBaseQueryKey(environmentId, cwd), "workspace"] as const,
  pullRequestInbox: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    filters?: GitHubPullRequestFilters | null,
    cursor?: string | null,
    pageSize?: number | null,
  ) =>
    [
      ...gitHubBaseQueryKey(environmentId, cwd),
      "pull-request-inbox",
      normalizeGitHubPullRequestFilterKey(filters),
      cursor ?? null,
      pageSize ?? null,
    ] as const,
  pullRequestDetail: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    repository: string | null,
    number: number | null,
  ) =>
    [...gitHubBaseQueryKey(environmentId, cwd), "pull-request-detail", repository, number] as const,
  workflowOverview: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    target: GitHubWorkflowTarget | null,
  ) =>
    [
      ...gitHubBaseQueryKey(environmentId, cwd),
      "workflow-overview",
      normalizeGitHubWorkflowTargetKey(target),
    ] as const,
};

export const gitMutationKeys = {
  init: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "init", environmentId ?? null, cwd] as const,
  checkout: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "checkout", environmentId ?? null, cwd] as const,
  runStackedAction: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "run-stacked-action", environmentId ?? null, cwd] as const,
  pull: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "pull", environmentId ?? null, cwd] as const,
  preparePullRequestThread: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", environmentId ?? null, cwd] as const,
  addPullRequestComment: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "github-comment", environmentId ?? null, cwd] as const,
  submitPullRequestReview: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["git", "mutation", "github-review", environmentId ?? null, cwd] as const,
};

export function invalidateGitQueries(
  queryClient: QueryClient,
  input?: { environmentId?: EnvironmentId | null; cwd?: string | null },
) {
  const environmentId = input?.environmentId ?? null;
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(environmentId, cwd) });
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

function invalidateGitBranchQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  cwd: string | null,
) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(environmentId, cwd) });
}

function invalidateGitHubWorkspaceQueries(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  cwd: string | null,
) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: gitQueryKeys.githubWorkspace(environmentId, cwd),
    }),
    queryClient.invalidateQueries({
      queryKey: [...gitQueryKeys.github(environmentId, cwd), "pull-request-inbox"],
    }),
    queryClient.invalidateQueries({
      queryKey: [...gitQueryKeys.github(environmentId, cwd), "pull-request-detail"],
    }),
  ]).then(() => undefined);
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.environmentId, input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      if (!input.environmentId) throw new Error("Git branches are unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.listBranches({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: [
      "git",
      "pull-request",
      input.environmentId ?? null,
      input.cwd,
      input.reference,
    ] as const,
    queryFn: async () => {
      if (!input.cwd || !input.reference || !input.environmentId) {
        throw new Error("Pull request lookup is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.environmentId !== null && input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitRecentGraphQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  limit?: number;
  enabled?: boolean;
}) {
  const limit = input.limit ?? 300;
  return queryOptions({
    queryKey: gitQueryKeys.recentGraph(input.environmentId, input.cwd, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Git graph is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.getRecentGraph({ cwd: input.cwd, limit });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitHubWorkspaceQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.githubWorkspace(input.environmentId, input.cwd),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("GitHub workspace is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.github.getWorkspace({ cwd: input.cwd });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitHubPullRequestInboxQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  filters?: GitHubPullRequestFilters | null;
  cursor?: string | null;
  pageSize?: number;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.pullRequestInbox(
      input.environmentId,
      input.cwd,
      input.filters,
      input.cursor,
      input.pageSize,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("GitHub pull request inbox is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.github.getPullRequestInbox({
        cwd: input.cwd,
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.pageSize ? { pageSize: input.pageSize } : {}),
      });
    },
    enabled: input.environmentId !== null && input.cwd !== null && (input.enabled ?? true),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitHubPullRequestDetailQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  repository: string | null;
  number: number | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.pullRequestDetail(
      input.environmentId,
      input.cwd,
      input.repository,
      input.number,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.repository || input.number === null) {
        throw new Error("GitHub pull request detail is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.github.getPullRequestDetail({
        cwd: input.cwd,
        repository: input.repository,
        number: input.number,
      });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.repository !== null &&
      input.number !== null &&
      (input.enabled ?? true),
    staleTime: GIT_HUB_PULL_REQUEST_DETAIL_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function gitHubWorkflowOverviewQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  target: GitHubWorkflowTarget | null;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.workflowOverview(input.environmentId, input.cwd, input.target),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId || !input.target) {
        throw new Error("GitHub workflows are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.github.getWorkflowOverview({
        cwd: input.cwd,
        target: input.target,
      });
    },
    enabled:
      input.environmentId !== null &&
      input.cwd !== null &&
      input.target !== null &&
      (input.enabled ?? true),
    staleTime: GIT_HUB_WORKFLOW_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    ...(input.refetchInterval !== undefined ? { refetchInterval: input.refetchInterval } : {}),
  });
}

export function gitInitMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git init is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.init({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.environmentId, input.cwd),
    mutationFn: async (branch: string) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git checkout is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSettled: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.environmentId, input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd || !input.environmentId) throw new Error("Git action is unavailable.");
      return requireEnvironmentConnection(input.environmentId).client.git.runStackedAction(
        {
          action,
          actionId,
          cwd: input.cwd,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch: true } : {}),
          ...(filePaths && filePaths.length > 0 ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitPullMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.environmentId, input.cwd),
    mutationFn: async () => {
      if (!input.cwd || !input.environmentId) throw new Error("Git pull is unavailable.");
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.pull({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "create-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["git"]["createWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree creation is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).git.createWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: {
  environmentId: EnvironmentId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "remove-worktree", input.environmentId ?? null] as const,
    mutationFn: (
      args: Parameters<ReturnType<typeof ensureEnvironmentApi>["git"]["removeWorktree"]>[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("Worktree removal is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).git.removeWorktree(args);
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient, { environmentId: input.environmentId });
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.preparePullRequestThread(input.environmentId, input.cwd),
    mutationFn: async (args: {
      reference: string;
      mode: "local" | "worktree";
      threadId?: ThreadId;
    }) => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Pull request thread preparation is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference: args.reference,
        mode: args.mode,
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
    },
    onSuccess: async () => {
      await invalidateGitBranchQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitAddPullRequestCommentMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.addPullRequestComment(input.environmentId, input.cwd),
    mutationFn: async (
      args: Parameters<
        ReturnType<typeof ensureEnvironmentApi>["github"]["addPullRequestComment"]
      >[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("GitHub pull request comments are unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).github.addPullRequestComment(args);
    },
    onSuccess: async () => {
      await invalidateGitHubWorkspaceQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}

export function gitSubmitPullRequestReviewMutationOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.submitPullRequestReview(input.environmentId, input.cwd),
    mutationFn: async (
      args: Parameters<
        ReturnType<typeof ensureEnvironmentApi>["github"]["submitPullRequestReview"]
      >[0],
    ) => {
      if (!input.environmentId) {
        throw new Error("GitHub pull request reviews are unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).github.submitPullRequestReview(args);
    },
    onSuccess: async () => {
      await invalidateGitHubWorkspaceQueries(input.queryClient, input.environmentId, input.cwd);
    },
  });
}
