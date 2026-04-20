import { Cause, Effect, Exit, Layer, Path, Ref } from "effect";

import type {
  GitGraphRef,
  GitHubActor,
  GitHubCheckBucket,
  GitHubCheckSummary,
  GitHubPullRequestFilters,
  GitHubPullRequestComment,
  GitHubPullRequestInboxSnapshot,
  GitHubPullRequestSummary,
  GitHubPullRequestReview,
  GitHubReviewState,
  GitHubRepositoryLabel,
  GitHubWorkspaceAvailability,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  GitRecentGraphResult,
  GitTopologyWorktree,
} from "@t3tools/contracts";
import type { GitCommandError } from "@t3tools/contracts";
import { GitHubWorkspaceError } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import { GIT_LOG_GRAPH_FORMAT, parseGitLogGraphRows } from "../graphRows.ts";
import { discoverPullRequestsForBranch } from "../pullRequestDiscovery.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitManager } from "../Services/GitManager.ts";
import { GitWorkspace, type GitWorkspaceShape } from "../Services/GitWorkspace.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";

const DEFAULT_GRAPH_LIMIT = 300;
const PULL_REQUEST_PAGE_SIZE = 25;
const MAX_WORKFLOW_RUNS = 10;
const WORKFLOW_REMOTE_REFRESH_COOLDOWN_MS = 30_000;
const AVAILABLE_GITHUB_WORKSPACE_MESSAGE = "GitHub workspace is available.";

interface NormalizedPullRequestFilters {
  readonly search: string;
  readonly state: "open" | "closed" | "merged" | "all";
  readonly review:
    | "any"
    | "review_required"
    | "approved"
    | "changes_requested"
    | "commented"
    | "no_decision";
  readonly author: string;
  readonly assignee: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly labels: ReadonlyArray<string>;
  readonly draft: "any" | "draft" | "ready";
  readonly sort: "updated" | "created" | "number";
}

interface ResolvedGitHubContext {
  readonly availability: GitHubWorkspaceAvailability;
  readonly repository: string;
}

function gitHubWorkspaceError(operation: string, detail: string, cause?: unknown) {
  return new GitHubWorkspaceError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function ensureNonEmpty(value: unknown, fallback: string): string {
  return trimToNull(value) ?? fallback;
}

function normalizeIsoDateTime(value: unknown, fallback = new Date(0).toISOString()): string {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return fallback;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeActor(value: unknown): GitHubActor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const login = trimToNull(record.login);
  if (!login) {
    return null;
  }
  const name = trimToNull(record.name);
  const avatarUrl = trimToNull(record.avatarUrl);
  return {
    login,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function normalizeReviewState(value: unknown): GitHubReviewState {
  const normalized = trimToNull(value)?.toLowerCase().replace(/\s+/g, "_");
  switch (normalized) {
    case "approved":
      return "approved";
    case "changes_requested":
    case "changes-requested":
      return "changes_requested";
    case "dismissed":
      return "dismissed";
    case "pending":
      return "pending";
    case "commented":
    default:
      return "commented";
  }
}

function normalizePullRequestState(value: unknown): "open" | "closed" | "merged" {
  switch (trimToNull(value)?.toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "open":
    default:
      return "open";
  }
}

function normalizeRepositoryLabel(value: unknown): GitHubRepositoryLabel | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = trimToNull(record.id);
  const name = trimToNull(record.name);
  const color = trimToNull(record.color);
  if (!id || !name || !color) {
    return null;
  }
  return {
    id,
    name,
    color,
    description: typeof record.description === "string" ? record.description : null,
  };
}

function normalizePullRequestSummary(
  value: unknown,
  repositoryFallback: string,
): GitHubPullRequestSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const number = Number(record.number);
  const title = trimToNull(record.title);
  const url = trimToNull(record.url);
  const baseBranch = trimToNull(record.baseRefName);
  const headBranch = trimToNull(record.headRefName);
  if (!Number.isFinite(number) || !title || !url || !baseBranch || !headBranch) {
    return null;
  }

  const labels = Array.isArray((record.labels as { nodes?: unknown })?.nodes)
    ? (record.labels as { nodes: ReadonlyArray<unknown> }).nodes
        .map(normalizeRepositoryLabel)
        .filter((candidate): candidate is GitHubRepositoryLabel => candidate !== null)
    : [];
  const repositoryNameWithOwner =
    trimToNull(record.repositoryNameWithOwner) ??
    (record.repository && typeof record.repository === "object"
      ? trimToNull((record.repository as Record<string, unknown>).nameWithOwner)
      : null);

  return {
    repository: repositoryNameWithOwner ?? repositoryFallback,
    number,
    title,
    url,
    state: normalizePullRequestState(record.state),
    isDraft: Boolean(record.isDraft),
    author: normalizeActor(record.author),
    reviewDecision: trimToNull(record.reviewDecision),
    baseBranch,
    headBranch,
    labels,
    createdAt: normalizeIsoDateTime(record.createdAt),
    updatedAt: normalizeIsoDateTime(record.updatedAt ?? record.createdAt),
  };
}

function normalizePullRequestFilters(
  filters?: GitHubPullRequestFilters,
): NormalizedPullRequestFilters {
  return {
    search: filters?.search?.trim() ?? "",
    state: filters?.state ?? "open",
    review: filters?.review ?? "any",
    author: filters?.author?.trim() ?? "",
    assignee: filters?.assignee?.trim() ?? "",
    baseBranch: filters?.baseBranch?.trim() ?? "",
    headBranch: filters?.headBranch?.trim() ?? "",
    labels: (filters?.labels ?? [])
      .map((label) => label.trim())
      .filter((label) => label.length > 0),
    draft: filters?.draft ?? "any",
    sort: filters?.sort ?? "updated",
  };
}

function normalizePullRequestFiltersOutput(
  filters: NormalizedPullRequestFilters,
): GitHubPullRequestInboxSnapshot["appliedFilters"] {
  return {
    search: filters.search,
    state: filters.state,
    review: filters.review,
    author: filters.author,
    assignee: filters.assignee,
    baseBranch: filters.baseBranch,
    headBranch: filters.headBranch,
    labels: [...filters.labels],
    draft: filters.draft,
    sort: filters.sort,
  };
}

function quoteGitHubSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildPullRequestSearchQuery(
  repository: string,
  filters: NormalizedPullRequestFilters,
): string {
  const qualifiers = [`repo:${repository}`, "is:pr"];

  switch (filters.state) {
    case "open":
      qualifiers.push("is:open");
      break;
    case "closed":
      qualifiers.push("is:closed", "-is:merged");
      break;
    case "merged":
      qualifiers.push("is:merged");
      break;
    case "all":
      break;
  }

  switch (filters.review) {
    case "review_required":
      qualifiers.push("review:required");
      break;
    case "approved":
      qualifiers.push("review:approved");
      break;
    case "changes_requested":
      qualifiers.push("review:changes_requested");
      break;
    case "commented":
      qualifiers.push("review:commented");
      break;
    case "no_decision":
      qualifiers.push("review:none");
      break;
    case "any":
      break;
  }

  if (filters.author.length > 0) {
    qualifiers.push(`author:${quoteGitHubSearchValue(filters.author)}`);
  }
  if (filters.assignee.length > 0) {
    qualifiers.push(`assignee:${quoteGitHubSearchValue(filters.assignee)}`);
  }
  if (filters.baseBranch.length > 0) {
    qualifiers.push(`base:${quoteGitHubSearchValue(filters.baseBranch)}`);
  }
  if (filters.headBranch.length > 0) {
    qualifiers.push(`head:${quoteGitHubSearchValue(filters.headBranch)}`);
  }
  for (const label of filters.labels) {
    qualifiers.push(`label:${quoteGitHubSearchValue(label)}`);
  }

  switch (filters.draft) {
    case "draft":
      qualifiers.push("draft:true");
      break;
    case "ready":
      qualifiers.push("draft:false");
      break;
    case "any":
      break;
  }

  switch (filters.sort) {
    case "created":
      qualifiers.push("sort:created-desc");
      break;
    case "updated":
      qualifiers.push("sort:updated-desc");
      break;
    case "number":
      break;
  }

  const trimmedSearch = filters.search.trim();
  if (trimmedSearch.length > 0) {
    const numberMatch = /^#?(\d+)$/.exec(trimmedSearch);
    qualifiers.push(numberMatch ? `number:${numberMatch[1]}` : trimmedSearch);
  }

  return qualifiers.join(" ");
}

function sortPullRequestSummaries(
  pullRequests: ReadonlyArray<GitHubPullRequestSummary>,
  sort: NormalizedPullRequestFilters["sort"],
): ReadonlyArray<GitHubPullRequestSummary> {
  return [...pullRequests].toSorted((left, right) => {
    switch (sort) {
      case "created":
        return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      case "number":
        return right.number - left.number;
      case "updated":
      default:
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    }
  });
}

function parseJson(
  operation: string,
  detail: string,
  raw: string,
): Effect.Effect<unknown, GitHubWorkspaceError> {
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => gitHubWorkspaceError(operation, detail, cause),
  });
}

function parseGraphRefs(stdout: string): ReadonlyArray<{
  readonly targetOid: string;
  readonly refName: string;
  readonly isHead: boolean;
}> {
  return stdout
    .split("\n")
    .map((line) => {
      if (line.length === 0) {
        return null;
      }
      const [targetOid, refName, headMarker] = line.split("\u0000");
      const normalizedTargetOid = trimToNull(targetOid);
      const normalizedRefName = trimToNull(refName);
      if (!normalizedTargetOid || !normalizedRefName) {
        return null;
      }
      return {
        targetOid: normalizedTargetOid,
        refName: normalizedRefName,
        isHead: trimToNull(headMarker) === "*",
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

function normalizeComment(value: unknown): GitHubPullRequestComment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = trimToNull(record.id ?? record.databaseId);
  const url = trimToNull(record.url);
  if (!id || !url) {
    return null;
  }
  return {
    id,
    url,
    author: normalizeActor(record.author),
    body: typeof record.body === "string" ? record.body : "",
    createdAt: normalizeIsoDateTime(record.createdAt),
    updatedAt: normalizeIsoDateTime(record.updatedAt ?? record.createdAt),
  };
}

function normalizeReview(value: unknown): GitHubPullRequestReview | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = trimToNull(record.id ?? record.databaseId);
  const url = trimToNull(record.url);
  if (!id || !url) {
    return null;
  }
  return {
    id,
    url,
    author: normalizeActor(record.author),
    state: normalizeReviewState(record.state),
    body: typeof record.body === "string" ? record.body : "",
    submittedAt: trimToNull(record.submittedAt) ? normalizeIsoDateTime(record.submittedAt) : null,
  };
}

function normalizeWorkflowJob(value: unknown): GitHubWorkflowJob | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const name = trimToNull(record.name);
  const status = trimToNull(record.status);
  const url = trimToNull(record.html_url ?? record.url);
  if (!Number.isFinite(id) || !name || !status || !url) {
    return null;
  }
  return {
    id,
    name,
    status,
    conclusion: trimToNull(record.conclusion),
    startedAt: trimToNull(record.started_at) ? normalizeIsoDateTime(record.started_at) : null,
    completedAt: trimToNull(record.completed_at) ? normalizeIsoDateTime(record.completed_at) : null,
    url,
  };
}

function normalizeWorkflowRun(
  value: unknown,
  jobs: ReadonlyArray<GitHubWorkflowJob>,
): GitHubWorkflowRun | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const name = trimToNull(record.display_title ?? record.name);
  const event = trimToNull(record.event);
  const status = trimToNull(record.status);
  const url = trimToNull(record.html_url ?? record.url);
  if (!Number.isFinite(id) || !name || !event || !status || !url) {
    return null;
  }
  return {
    id,
    name,
    workflowName: trimToNull(record.name),
    event,
    status,
    conclusion: trimToNull(record.conclusion),
    headBranch: trimToNull(record.head_branch),
    headSha: trimToNull(record.head_sha),
    ...(Number.isFinite(Number(record.run_attempt)) ? { attempt: Number(record.run_attempt) } : {}),
    url,
    createdAt: trimToNull(record.created_at) ? normalizeIsoDateTime(record.created_at) : null,
    startedAt: trimToNull(record.run_started_at)
      ? normalizeIsoDateTime(record.run_started_at)
      : null,
    updatedAt: trimToNull(record.updated_at) ? normalizeIsoDateTime(record.updated_at) : null,
    jobs: [...jobs],
  };
}

function normalizeCheckRunBucket(
  status: string | null,
  conclusion: string | null,
): GitHubCheckBucket {
  if (status && status.toLowerCase() !== "completed") {
    return "pending";
  }

  switch ((conclusion ?? status ?? "").toLowerCase()) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
    case "stale":
    case "error":
      return "fail";
    default:
      return "pending";
  }
}

function workflowCheckBucketPriority(bucket: GitHubCheckBucket) {
  switch (bucket) {
    case "fail":
      return 0;
    case "pending":
      return 1;
    case "pass":
      return 2;
    case "skipping":
      return 3;
    case "cancel":
      return 4;
  }
}

function normalizeCheckSummaryFromCheckRun(value: unknown): GitHubCheckSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = trimToNull(record.name);
  const status = trimToNull(record.status);
  if (!name || !status) {
    return null;
  }
  const conclusion = trimToNull(record.conclusion);
  const appName =
    record.app && typeof record.app === "object"
      ? trimToNull((record.app as Record<string, unknown>).name)
      : null;

  return {
    name,
    state: conclusion ?? status,
    bucket: normalizeCheckRunBucket(status, conclusion),
    ...(appName ? { workflow: appName } : {}),
    ...(trimToNull(record.details_url ?? record.html_url)
      ? { link: ensureNonEmpty(record.details_url ?? record.html_url, "") }
      : {}),
    startedAt: trimToNull(record.started_at) ? normalizeIsoDateTime(record.started_at) : null,
    completedAt: trimToNull(record.completed_at) ? normalizeIsoDateTime(record.completed_at) : null,
  };
}

function normalizeCheckSummaryFromStatusContext(value: unknown): GitHubCheckSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const context = trimToNull(record.context);
  const state = trimToNull(record.state);
  if (!context || !state) {
    return null;
  }

  const bucket = (() => {
    switch (state.toLowerCase()) {
      case "success":
        return "pass";
      case "error":
      case "failure":
        return "fail";
      case "pending":
      default:
        return "pending";
    }
  })();

  return {
    name: context,
    state,
    bucket,
    ...(trimToNull(record.description)
      ? { description: ensureNonEmpty(record.description, "") }
      : {}),
    ...(trimToNull(record.target_url) ? { link: ensureNonEmpty(record.target_url, "") } : {}),
    startedAt: trimToNull(record.created_at) ? normalizeIsoDateTime(record.created_at) : null,
    completedAt: trimToNull(record.updated_at) ? normalizeIsoDateTime(record.updated_at) : null,
  };
}

function isGitHubCliUnavailable(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("not available on path") ||
    normalized.includes("required but not available")
  );
}

function isGitHubCliUnauthenticated(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes("not authenticated") || normalized.includes("gh auth login");
}

export const makeGitWorkspace = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const gitHubCli = yield* GitHubCli;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  const path = yield* Path.Path;
  const remoteRefRefreshAttemptAt = yield* Ref.make(new Map<string, number>());

  const executeOptionalGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    gitCore.execute({
      operation,
      cwd,
      args,
      allowNonZeroExit: true,
      truncateOutputAtMaxBytes: true,
      maxOutputBytes: 512 * 1024,
    });

  const buildAvailableAvailability = (
    hostingProvider?: GitHubWorkspaceAvailability["hostingProvider"],
  ) =>
    ({
      kind: "available" as const,
      message: AVAILABLE_GITHUB_WORKSPACE_MESSAGE,
      ...(hostingProvider ? { hostingProvider } : {}),
    }) satisfies GitHubWorkspaceAvailability;

  const resolveRepositoryFromRemoteName = Effect.fn("GitWorkspace.resolveRepositoryFromRemoteName")(
    function* (cwd: string, remoteName: string) {
      const remoteUrl = yield* gitCore
        .readConfigValue(cwd, `remote.${remoteName}.url`)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
    },
  );

  const loadGitHubAvailability = Effect.fn("GitWorkspace.loadGitHubAvailability")(function* (
    cwd: string,
    operation: string,
  ) {
    const localStatus = yield* gitManager
      .localStatus({ cwd })
      .pipe(Effect.mapError((error) => gitHubWorkspaceError(operation, error.message, error)));

    if (!localStatus.isRepo) {
      return {
        availability: {
          kind: "error" as const,
          message: "Git repository status is unavailable for this workspace.",
        },
        hostingProvider: null,
      };
    }

    if (localStatus.hostingProvider?.kind !== "github") {
      return {
        availability: {
          kind: "unsupported_host" as const,
          message:
            localStatus.hostingProvider?.name ??
            "This repository is not configured for GitHub workspace features.",
          ...(localStatus.hostingProvider ? { hostingProvider: localStatus.hostingProvider } : {}),
        },
        hostingProvider: localStatus.hostingProvider ?? null,
      };
    }

    const authStatusExit = yield* Effect.exit(
      gitHubCli.execute({
        cwd,
        args: ["auth", "status"],
        timeoutMs: 15_000,
      }),
    );
    if (Exit.isFailure(authStatusExit)) {
      const error = Cause.squash(authStatusExit.cause);
      const detail = error instanceof Error ? error.message : "GitHub CLI is unavailable.";
      if (isGitHubCliUnavailable(detail)) {
        return {
          availability: {
            kind: "gh_unavailable" as const,
            message: "GitHub CLI is required for PR and workflow features.",
            hostingProvider: localStatus.hostingProvider,
          },
          hostingProvider: localStatus.hostingProvider,
        };
      }
      if (isGitHubCliUnauthenticated(detail)) {
        return {
          availability: {
            kind: "gh_unauthenticated" as const,
            message: "Authenticate GitHub CLI with `gh auth login` to use PR features.",
            hostingProvider: localStatus.hostingProvider,
          },
          hostingProvider: localStatus.hostingProvider,
        };
      }
      return {
        availability: {
          kind: "error" as const,
          message: detail,
          hostingProvider: localStatus.hostingProvider,
        },
        hostingProvider: localStatus.hostingProvider,
      };
    }

    return {
      availability: buildAvailableAvailability(localStatus.hostingProvider),
      hostingProvider: localStatus.hostingProvider,
    };
  });

  const resolveGitHubContext = Effect.fn("GitWorkspace.resolveGitHubContext")(function* (
    cwd: string,
    operation: string,
    repositoryFallback?: string,
  ): Effect.fn.Return<
    ResolvedGitHubContext | { availability: GitHubWorkspaceAvailability; repository: null },
    GitHubWorkspaceError
  > {
    const availabilityState = yield* loadGitHubAvailability(cwd, operation);
    if (availabilityState.availability.kind !== "available") {
      return {
        availability: availabilityState.availability,
        repository: null,
      };
    }

    const repositoryIdentity = yield* repositoryIdentityResolver
      .resolve(cwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const repository =
      trimToNull(repositoryFallback) ??
      (repositoryIdentity?.provider === "github" &&
      repositoryIdentity.owner &&
      repositoryIdentity.name
        ? `${repositoryIdentity.owner}/${repositoryIdentity.name}`
        : trimToNull(repositoryIdentity?.displayName)?.includes("/")
          ? trimToNull(repositoryIdentity?.displayName)
          : null);

    if (!repository) {
      return {
        availability: {
          kind: "error",
          message: "GitHub repository identity could not be resolved for this workspace.",
          ...(availabilityState.hostingProvider
            ? { hostingProvider: availabilityState.hostingProvider }
            : {}),
        },
        repository: null,
      };
    }

    return {
      availability: availabilityState.availability,
      repository,
    };
  });

  const ensureGitHubContext = Effect.fn("GitWorkspace.ensureGitHubContext")(function* (
    cwd: string,
    operation: string,
    repositoryFallback?: string,
  ) {
    const context = yield* resolveGitHubContext(cwd, operation, repositoryFallback);
    if (context.availability.kind !== "available" || context.repository === null) {
      return yield* Effect.fail(gitHubWorkspaceError(operation, context.availability.message));
    }
    return context;
  });

  const parseGraphQlData = Effect.fn("GitWorkspace.parseGraphQlData")(function* (
    operation: string,
    detail: string,
    raw: string,
  ) {
    const parsed = yield* parseJson(operation, detail, raw);
    if (!parsed || typeof parsed !== "object") {
      return yield* Effect.fail(gitHubWorkspaceError(operation, detail));
    }
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const messages = record.errors
        .map((entry) =>
          entry && typeof entry === "object"
            ? trimToNull((entry as Record<string, unknown>).message)
            : null,
        )
        .filter((message): message is string => message !== null);
      return yield* Effect.fail(
        gitHubWorkspaceError(operation, messages.join("; ") || "GitHub GraphQL query failed."),
      );
    }
    const data = record.data;
    if (!data || typeof data !== "object") {
      return yield* Effect.fail(gitHubWorkspaceError(operation, detail));
    }
    return data as Record<string, unknown>;
  });

  const loadWorkflowRuns = Effect.fn("GitWorkspace.loadWorkflowRuns")(function* (input: {
    operation: string;
    cwd: string;
    repository: string;
    headSha: string;
  }): Effect.fn.Return<ReadonlyArray<GitHubWorkflowRun>, GitHubWorkspaceError> {
    if (input.headSha === "unknown") {
      return [];
    }

    const runsResult = yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          `repos/${input.repository}/actions/runs?head_sha=${encodeURIComponent(
            input.headSha,
          )}&per_page=${MAX_WORKFLOW_RUNS}`,
        ],
        timeoutMs: 20_000,
      })
      .pipe(Effect.mapError((error) => gitHubWorkspaceError(input.operation, error.detail, error)));
    const runsRaw = yield* parseJson(
      input.operation,
      "GitHub CLI returned invalid workflow runs JSON.",
      runsResult.stdout,
    );
    const runEntries =
      runsRaw && typeof runsRaw === "object" && Array.isArray((runsRaw as any).workflow_runs)
        ? ((runsRaw as any).workflow_runs as ReadonlyArray<unknown>)
        : [];

    return yield* Effect.forEach(
      runEntries,
      (entry) =>
        Effect.gen(function* () {
          const runRecord =
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const runId = Number(runRecord.id);
          if (!Number.isFinite(runId)) {
            return null;
          }

          const jobsResult = yield* gitHubCli
            .execute({
              cwd: input.cwd,
              args: ["api", `repos/${input.repository}/actions/runs/${runId}/jobs?per_page=50`],
              timeoutMs: 20_000,
            })
            .pipe(
              Effect.mapError((error) =>
                gitHubWorkspaceError(input.operation, error.detail, error),
              ),
            );
          const jobsRaw = yield* parseJson(
            input.operation,
            "GitHub CLI returned invalid workflow jobs JSON.",
            jobsResult.stdout,
          );
          const jobs =
            jobsRaw && typeof jobsRaw === "object" && Array.isArray((jobsRaw as any).jobs)
              ? ((jobsRaw as any).jobs as ReadonlyArray<unknown>)
                  .map(normalizeWorkflowJob)
                  .filter((value): value is GitHubWorkflowJob => value !== null)
              : [];
          return normalizeWorkflowRun(entry, jobs);
        }),
      { concurrency: 3 },
    ).pipe(
      Effect.map((runs) =>
        runs
          .filter((value): value is GitHubWorkflowRun => value !== null)
          .toSorted((left, right) => {
            const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
            const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
            if (rightUpdatedAt !== leftUpdatedAt) {
              return rightUpdatedAt - leftUpdatedAt;
            }
            return (right.attempt ?? 0) - (left.attempt ?? 0);
          }),
      ),
    );
  });

  const loadChecksForHeadSha = Effect.fn("GitWorkspace.loadChecksForHeadSha")(function* (input: {
    operation: string;
    cwd: string;
    repository: string;
    headSha: string;
  }): Effect.fn.Return<ReadonlyArray<GitHubCheckSummary>, GitHubWorkspaceError> {
    if (input.headSha === "unknown") {
      return [];
    }

    const [checkRunsResult, statusResult] = yield* Effect.all(
      [
        gitHubCli
          .execute({
            cwd: input.cwd,
            args: [
              "api",
              `repos/${input.repository}/commits/${encodeURIComponent(input.headSha)}/check-runs?per_page=100`,
            ],
            timeoutMs: 20_000,
          })
          .pipe(
            Effect.mapError((error) => gitHubWorkspaceError(input.operation, error.detail, error)),
          ),
        gitHubCli
          .execute({
            cwd: input.cwd,
            args: [
              "api",
              `repos/${input.repository}/commits/${encodeURIComponent(input.headSha)}/status`,
            ],
            timeoutMs: 20_000,
          })
          .pipe(
            Effect.mapError((error) => gitHubWorkspaceError(input.operation, error.detail, error)),
          ),
      ],
      { concurrency: "unbounded" },
    );

    const checkRunsRaw = yield* parseJson(
      input.operation,
      "GitHub CLI returned invalid check runs JSON.",
      checkRunsResult.stdout,
    );
    const statusRaw = yield* parseJson(
      input.operation,
      "GitHub CLI returned invalid commit status JSON.",
      statusResult.stdout,
    );

    const checksFromRuns =
      checkRunsRaw &&
      typeof checkRunsRaw === "object" &&
      Array.isArray((checkRunsRaw as any).check_runs)
        ? ((checkRunsRaw as any).check_runs as ReadonlyArray<unknown>)
            .map(normalizeCheckSummaryFromCheckRun)
            .filter((value): value is GitHubCheckSummary => value !== null)
        : [];
    const checksFromStatuses =
      statusRaw && typeof statusRaw === "object" && Array.isArray((statusRaw as any).statuses)
        ? ((statusRaw as any).statuses as ReadonlyArray<unknown>)
            .map(normalizeCheckSummaryFromStatusContext)
            .filter((value): value is GitHubCheckSummary => value !== null)
        : [];

    const seenNames = new Set<string>();
    return [...checksFromRuns, ...checksFromStatuses]
      .filter((check) => {
        const key = check.name.toLowerCase();
        if (seenNames.has(key)) {
          return false;
        }
        seenNames.add(key);
        return true;
      })
      .toSorted((left, right) => {
        const bucketDifference =
          workflowCheckBucketPriority(left.bucket) - workflowCheckBucketPriority(right.bucket);
        if (bucketDifference !== 0) {
          return bucketDifference;
        }
        const rightTime = right.completedAt
          ? Date.parse(right.completedAt)
          : right.startedAt
            ? Date.parse(right.startedAt)
            : 0;
        const leftTime = left.completedAt
          ? Date.parse(left.completedAt)
          : left.startedAt
            ? Date.parse(left.startedAt)
            : 0;
        return rightTime - leftTime;
      });
  });

  const loadPullRequestDetailSnapshot = Effect.fn("GitWorkspace.loadPullRequestDetailSnapshot")(
    function* (input: {
      operation: string;
      cwd: string;
      repository: string;
      number: number;
      fallbackTitle?: string;
      fallbackUrl?: string;
      fallbackBaseBranch?: string;
      fallbackHeadBranch?: string;
    }) {
      const prViewResult = yield* gitHubCli
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            "--repo",
            input.repository,
            String(input.number),
            "--json",
            [
              "number",
              "title",
              "url",
              "state",
              "isDraft",
              "body",
              "author",
              "reviewDecision",
              "baseRefName",
              "headRefName",
              "headRefOid",
              "createdAt",
              "updatedAt",
              "comments",
              "reviews",
            ].join(","),
          ],
          timeoutMs: 20_000,
        })
        .pipe(
          Effect.mapError((error) => gitHubWorkspaceError(input.operation, error.detail, error)),
        );

      const prRaw = yield* parseJson(
        input.operation,
        "GitHub CLI returned invalid pull request JSON.",
        prViewResult.stdout,
      );
      const prRecord = prRaw && typeof prRaw === "object" ? (prRaw as Record<string, unknown>) : {};

      return {
        repository: input.repository,
        number: Number(prRecord.number ?? input.number),
        title: ensureNonEmpty(
          prRecord.title,
          input.fallbackTitle ?? `Pull Request #${input.number}`,
        ),
        url: ensureNonEmpty(
          prRecord.url,
          input.fallbackUrl ?? `https://github.com/${input.repository}/pull/${input.number}`,
        ),
        state: normalizePullRequestState(prRecord.state),
        isDraft: Boolean(prRecord.isDraft),
        body: typeof prRecord.body === "string" ? prRecord.body : "",
        author: normalizeActor(prRecord.author),
        reviewDecision: trimToNull(prRecord.reviewDecision),
        baseBranch: ensureNonEmpty(prRecord.baseRefName, input.fallbackBaseBranch ?? "unknown"),
        headBranch: ensureNonEmpty(prRecord.headRefName, input.fallbackHeadBranch ?? "unknown"),
        headSha: ensureNonEmpty(prRecord.headRefOid, "unknown"),
        createdAt: normalizeIsoDateTime(prRecord.createdAt),
        updatedAt: normalizeIsoDateTime(prRecord.updatedAt ?? prRecord.createdAt),
        comments: Array.isArray(prRecord.comments)
          ? prRecord.comments
              .map(normalizeComment)
              .filter((value): value is GitHubPullRequestComment => value !== null)
          : [],
        reviews: Array.isArray(prRecord.reviews)
          ? prRecord.reviews
              .map(normalizeReview)
              .filter((value): value is GitHubPullRequestReview => value !== null)
          : [],
      };
    },
  );

  const loadWorkspacePullRequest = Effect.fn("GitWorkspace.loadWorkspacePullRequest")(
    function* (input: {
      cwd: string;
      repository: string;
      number: number;
      title: string;
      url: string;
      baseBranch: string;
      headBranch: string;
    }) {
      const pullRequest = yield* loadPullRequestDetailSnapshot({
        operation: "getWorkspace",
        cwd: input.cwd,
        repository: input.repository,
        number: input.number,
        fallbackTitle: input.title,
        fallbackUrl: input.url,
        fallbackBaseBranch: input.baseBranch,
        fallbackHeadBranch: input.headBranch,
      });
      const [checks, runs] = yield* Effect.all(
        [
          loadChecksForHeadSha({
            operation: "getWorkspace",
            cwd: input.cwd,
            repository: input.repository,
            headSha: pullRequest.headSha,
          }),
          loadWorkflowRuns({
            operation: "getWorkspace",
            cwd: input.cwd,
            repository: input.repository,
            headSha: pullRequest.headSha,
          }),
        ],
        { concurrency: "unbounded" },
      );

      return {
        ...pullRequest,
        checks,
        runs,
      };
    },
  );

  const refreshRemoteRefIfNeeded = Effect.fn("GitWorkspace.refreshRemoteRefIfNeeded")(function* (
    cwd: string,
    remoteName: string,
    branch: string,
  ) {
    const cacheKey = `${cwd}::${remoteName}::${branch}`;
    const now = Date.now();
    const shouldRefresh = yield* Ref.modify(remoteRefRefreshAttemptAt, (cache) => {
      const lastAttemptAt = cache.get(cacheKey) ?? 0;
      if (now - lastAttemptAt < WORKFLOW_REMOTE_REFRESH_COOLDOWN_MS) {
        return [false, cache] as const;
      }
      const next = new Map(cache);
      next.set(cacheKey, now);
      return [true, next] as const;
    });

    if (!shouldRefresh) {
      return { attempted: false, succeeded: false } as const;
    }

    const refreshExit = yield* Effect.exit(
      gitCore.execute({
        operation: "GitWorkspace.refreshRemoteRef",
        cwd,
        args: ["fetch", "--quiet", "--no-tags", remoteName, branch],
        allowNonZeroExit: true,
        timeoutMs: 15_000,
        truncateOutputAtMaxBytes: true,
        maxOutputBytes: 128 * 1024,
      }),
    );
    return Exit.isSuccess(refreshExit)
      ? { attempted: true, succeeded: refreshExit.value.code === 0 }
      : { attempted: true, succeeded: false };
  });

  const resolveRemoteRefHeadSha = Effect.fn("GitWorkspace.resolveRemoteRefHeadSha")(function* (
    cwd: string,
    remoteName: string,
    branch: string,
  ) {
    const refresh = yield* refreshRemoteRefIfNeeded(cwd, remoteName, branch);
    const refResult = yield* executeOptionalGit("GitWorkspace.resolveRemoteRefHeadSha", cwd, [
      "rev-parse",
      `refs/remotes/${remoteName}/${branch}`,
    ]);
    const resolvedSha = trimToNull(refResult.stdout);
    return {
      resolvedSha,
      isStale: refresh.attempted && !refresh.succeeded && resolvedSha !== null,
      unavailableReason:
        resolvedSha === null ? `Remote ref ${remoteName}/${branch} is unavailable.` : null,
    };
  });

  const getRecentGraph: GitWorkspaceShape["getRecentGraph"] = Effect.fn(
    "GitWorkspace.getRecentGraph",
  )(function* (input): Effect.fn.Return<GitRecentGraphResult, GitCommandError> {
    const limit = input.limit ?? DEFAULT_GRAPH_LIMIT;
    const graphResult = yield* gitCore.execute({
      operation: "GitWorkspace.getRecentGraph.log",
      cwd: input.cwd,
      args: [
        "log",
        "--graph",
        "--topo-order",
        "--branches",
        "--remotes",
        "--tags",
        `--max-count=${limit + 1}`,
        `--format=${GIT_LOG_GRAPH_FORMAT}`,
      ],
      truncateOutputAtMaxBytes: true,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const parsedGraph = parseGitLogGraphRows(graphResult.stdout);
    const truncated = parsedGraph.commitCount > limit;
    const visibleRows = (() => {
      if (!truncated) {
        return parsedGraph.rows;
      }
      const rows: Array<(typeof parsedGraph.rows)[number]> = [];
      let visibleCommitCount = 0;
      for (const row of parsedGraph.rows) {
        if (row.commit) {
          if (visibleCommitCount >= limit) {
            break;
          }
          visibleCommitCount += 1;
        }
        rows.push(row);
      }
      return rows;
    })();

    const maxColumns = visibleRows.reduce((currentMax, row) => {
      const rowMaxColumn = row.cells.reduce(
        (maxColumn, cell) => Math.max(maxColumn, cell.column + 1),
        0,
      );
      return Math.max(currentMax, rowMaxColumn);
    }, 0);

    const branchList = yield* gitCore.listBranches({
      cwd: input.cwd,
      limit: 500,
    });
    const localBranchMeta = new Map(
      branchList.branches
        .filter((branch) => !branch.isRemote)
        .map((branch) => [
          branch.name,
          {
            current: branch.current,
            isDefault: branch.isDefault,
            worktreePath: branch.worktreePath,
          },
        ]),
    );

    const refResult = yield* executeOptionalGit("GitWorkspace.getRecentGraph.refs", input.cwd, [
      "for-each-ref",
      "--format=%(objectname)%00%(refname)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const headOidResult = yield* executeOptionalGit(
      "GitWorkspace.getRecentGraph.headOid",
      input.cwd,
      ["rev-parse", "HEAD"],
    );
    const headBranchResult = yield* executeOptionalGit(
      "GitWorkspace.getRecentGraph.headBranch",
      input.cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
    );
    const defaultBranchResult = yield* executeOptionalGit(
      "GitWorkspace.getRecentGraph.defaultBranch",
      input.cwd,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    );

    const refs: GitGraphRef[] = [];
    const branchTargetOidByName = new Map<string, string>();
    for (const entry of parseGraphRefs(refResult.stdout)) {
      if (entry.refName === "refs/remotes/origin/HEAD") {
        continue;
      }
      if (entry.refName.startsWith("refs/heads/")) {
        const branchName = entry.refName.slice("refs/heads/".length);
        const branchMeta = localBranchMeta.get(branchName);
        branchTargetOidByName.set(branchName, entry.targetOid);
        refs.push({
          id: entry.refName,
          targetOid: entry.targetOid,
          label: branchName,
          type: "branch",
          branchName,
          ...(entry.isHead || branchMeta?.current ? { current: true } : {}),
          ...(branchMeta?.isDefault ? { isDefault: true } : {}),
          ...(branchMeta?.worktreePath ? { worktreePath: branchMeta.worktreePath } : {}),
        });
        continue;
      }
      if (entry.refName.startsWith("refs/remotes/")) {
        const branchName = entry.refName.slice("refs/remotes/".length);
        refs.push({
          id: entry.refName,
          targetOid: entry.targetOid,
          label: branchName,
          type: "remote",
          branchName,
        });
        continue;
      }
      if (entry.refName.startsWith("refs/tags/")) {
        refs.push({
          id: entry.refName,
          targetOid: entry.targetOid,
          label: entry.refName.slice("refs/tags/".length),
          type: "tag",
        });
      }
    }

    const headOid = trimToNull(headOidResult.stdout);
    const headBranch = trimToNull(headBranchResult.stdout);
    if (headOid) {
      refs.unshift({
        id: "HEAD",
        targetOid: headOid,
        label: "HEAD",
        type: "head",
        ...(headBranch ? { branchName: headBranch } : {}),
        current: true,
      });
    }

    const topologyWorktrees: GitTopologyWorktree[] = [];
    for (const branch of branchList.branches.filter((candidate) => !candidate.isRemote)) {
      if (!branch.worktreePath) {
        continue;
      }
      topologyWorktrees.push({
        path: branch.worktreePath,
        branch: branch.name,
      });
      const targetOid =
        branchTargetOidByName.get(branch.name) ?? (headBranch === branch.name ? headOid : null);
      if (!targetOid) {
        continue;
      }
      refs.push({
        id: `worktree:${branch.worktreePath}`,
        targetOid,
        label: path.basename(branch.worktreePath),
        type: "worktree",
        branchName: branch.name,
        worktreePath: branch.worktreePath,
        ...(branch.current ? { current: true } : {}),
      });
    }

    const defaultBranch =
      trimToNull(defaultBranchResult.stdout)?.replace(/^refs\/remotes\/origin\//, "") ?? null;
    const rows = visibleRows.map((row) => ({
      id: row.id,
      cells: row.cells,
      commit: row.commit
        ? {
            ...row.commit,
            isHead: row.commit.oid === headOid,
          }
        : null,
    }));

    return {
      rows,
      maxColumns,
      refs,
      topology: {
        headOid,
        headBranch,
        defaultBranch,
        worktrees: topologyWorktrees,
      },
      truncated,
    };
  });

  const getGitHubWorkspace: GitWorkspaceShape["getGitHubWorkspace"] = Effect.fn(
    "GitWorkspace.getGitHubWorkspace",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    const emptySnapshot = {
      pullRequests: [],
      activePullRequest: null,
      fetchedAt: new Date().toISOString(),
    } as const;
    return yield* Effect.gen(function* () {
      const context = yield* resolveGitHubContext(input.cwd, "getWorkspace");
      if (context.availability.kind !== "available") {
        return {
          availability: context.availability,
          ...emptySnapshot,
        };
      }

      const details = yield* gitCore
        .statusDetails(input.cwd)
        .pipe(
          Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.message, error)),
        );

      if (!details.branch) {
        return {
          availability: context.availability,
          ...emptySnapshot,
        };
      }

      const discoveredPullRequests = yield* discoverPullRequestsForBranch({
        cwd: input.cwd,
        branch: details.branch,
        upstreamRef: details.upstreamRef,
        gitCore,
        gitHubCli,
        limit: 5,
      }).pipe(
        Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.message, error)),
      );

      const pullRequests = yield* Effect.forEach(
        discoveredPullRequests,
        (pullRequest) =>
          loadWorkspacePullRequest({
            cwd: input.cwd,
            repository: pullRequest.repository,
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            baseBranch: pullRequest.baseRefName,
            headBranch: pullRequest.headRefName,
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                repository: pullRequest.repository,
                number: pullRequest.number,
                title: pullRequest.title,
                url: pullRequest.url,
                state: pullRequest.state,
                isDraft: false,
                body: "",
                author: null,
                reviewDecision: null,
                baseBranch: pullRequest.baseRefName,
                headBranch: pullRequest.headRefName,
                headSha: "unknown",
                createdAt: new Date(0).toISOString(),
                updatedAt: pullRequest.updatedAt ?? new Date(0).toISOString(),
                comments: [],
                reviews: [],
                checks: [],
                runs: [],
              }),
            ),
          ),
        { concurrency: 2 },
      );
      const activeMatch = pullRequests.find(
        (pullRequest) => pullRequest.headBranch === details.branch,
      );
      const activePullRequest = activeMatch
        ? {
            repository: activeMatch.repository,
            number: activeMatch.number,
          }
        : null;

      return {
        availability: context.availability,
        pullRequests,
        activePullRequest,
        fetchedAt: new Date().toISOString(),
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          availability: {
            kind: "error",
            message: error.detail,
          },
          ...emptySnapshot,
        }),
      ),
    );
  });

  const getPullRequestInbox: GitWorkspaceShape["getPullRequestInbox"] = Effect.fn(
    "GitWorkspace.getPullRequestInbox",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    const filters = normalizePullRequestFilters(input.filters);
    const appliedFilters = normalizePullRequestFiltersOutput(filters);
    const fetchedAt = new Date().toISOString();
    return yield* Effect.gen(function* () {
      const context = yield* resolveGitHubContext(input.cwd, "getPullRequestInbox");
      const emptySnapshot = {
        repository: context.repository,
        labels: [],
        pullRequests: [],
        nextCursor: null,
        appliedFilters,
        fetchedAt,
      } as const;

      if (context.availability.kind !== "available" || context.repository === null) {
        return {
          availability: context.availability,
          ...emptySnapshot,
        };
      }

      const [owner = "", name = ""] = context.repository.split("/", 2);
      if (owner.length === 0 || name.length === 0) {
        return {
          availability: {
            kind: "error",
            message: "GitHub repository identity could not be resolved for this workspace.",
          },
          ...emptySnapshot,
        };
      }

      const pageSize = Math.min(Math.max(input.pageSize ?? PULL_REQUEST_PAGE_SIZE, 1), 50);
      const graphQlQuery = [
        "query($owner: String!, $name: String!, $searchQuery: String!, $first: Int!, $after: String) {",
        "  repository(owner: $owner, name: $name) {",
        "    labels(first: 100, orderBy: { field: NAME, direction: ASC }) {",
        "      nodes { id name color description }",
        "    }",
        "  }",
        "  search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {",
        "    pageInfo { hasNextPage endCursor }",
        "    nodes {",
        "      ... on PullRequest {",
        "        number",
        "        title",
        "        url",
        "        state",
        "        isDraft",
        "        reviewDecision",
        "        baseRefName",
        "        headRefName",
        "        createdAt",
        "        updatedAt",
        "        author {",
        "          login",
        "          avatarUrl",
        "          ... on User { name }",
        "        }",
        "        repository { nameWithOwner }",
        "        labels(first: 20) { nodes { id name color description } }",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n");
      const searchQuery = buildPullRequestSearchQuery(context.repository, filters);
      const graphQlPayload = JSON.stringify({
        query: graphQlQuery,
        variables: {
          owner,
          name,
          searchQuery,
          first: pageSize,
          ...(input.cursor ? { after: input.cursor } : {}),
        },
      });

      const graphQlResult = yield* gitHubCli
        .execute({
          cwd: input.cwd,
          args: ["api", "graphql", "--input", "-"],
          stdin: graphQlPayload,
          timeoutMs: 20_000,
        })
        .pipe(
          Effect.mapError((error) =>
            gitHubWorkspaceError("getPullRequestInbox", error.detail, error),
          ),
        );

      const graphQlData = yield* parseGraphQlData(
        "getPullRequestInbox",
        "GitHub CLI returned invalid GraphQL JSON.",
        graphQlResult.stdout,
      );
      const repositoryRecord =
        graphQlData.repository && typeof graphQlData.repository === "object"
          ? (graphQlData.repository as Record<string, unknown>)
          : {};
      const labels = Array.isArray((repositoryRecord.labels as { nodes?: unknown })?.nodes)
        ? (repositoryRecord.labels as { nodes: ReadonlyArray<unknown> }).nodes
            .map(normalizeRepositoryLabel)
            .filter((value): value is GitHubRepositoryLabel => value !== null)
        : [];
      const searchRecord =
        graphQlData.search && typeof graphQlData.search === "object"
          ? (graphQlData.search as Record<string, unknown>)
          : {};
      const rawPullRequests = Array.isArray(searchRecord.nodes)
        ? searchRecord.nodes
            .map((value) => normalizePullRequestSummary(value, context.repository!))
            .filter((value): value is GitHubPullRequestSummary => value !== null)
        : [];
      const pageInfo =
        searchRecord.pageInfo && typeof searchRecord.pageInfo === "object"
          ? (searchRecord.pageInfo as Record<string, unknown>)
          : {};

      return {
        availability: context.availability,
        repository: context.repository,
        labels,
        pullRequests: sortPullRequestSummaries(rawPullRequests, filters.sort),
        nextCursor:
          Boolean(pageInfo.hasNextPage) && trimToNull(pageInfo.endCursor)
            ? ensureNonEmpty(pageInfo.endCursor, "")
            : null,
        appliedFilters,
        fetchedAt,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          availability: {
            kind: "error",
            message: error.detail,
          },
          repository: null,
          labels: [],
          pullRequests: [],
          nextCursor: null,
          appliedFilters,
          fetchedAt,
        }),
      ),
    );
  });

  const getPullRequestDetail: GitWorkspaceShape["getPullRequestDetail"] = Effect.fn(
    "GitWorkspace.getPullRequestDetail",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    yield* ensureGitHubContext(input.cwd, "getPullRequestDetail", input.repository);
    const pullRequest = yield* loadPullRequestDetailSnapshot({
      operation: "getPullRequestDetail",
      cwd: input.cwd,
      repository: input.repository,
      number: input.number,
    });
    return {
      pullRequest,
      fetchedAt: new Date().toISOString(),
    };
  });

  const getWorkflowOverview: GitWorkspaceShape["getWorkflowOverview"] = Effect.fn(
    "GitWorkspace.getWorkflowOverview",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    const fetchedAt = new Date().toISOString();
    return yield* Effect.gen(function* () {
      const availabilityState = yield* loadGitHubAvailability(input.cwd, "getWorkflowOverview");
      const emptyOverview = (params: {
        repository: string | null;
        targetLabel: string;
        isStale?: boolean;
        unavailableReason?: string | null;
      }) => ({
        availability: availabilityState.availability,
        target: input.target,
        repository: params.repository,
        targetLabel: params.targetLabel,
        resolvedSha: null,
        isStale: params.isStale ?? false,
        unavailableReason: params.unavailableReason ?? null,
        checks: [],
        runs: [],
        fetchedAt,
      });

      if (availabilityState.availability.kind !== "available") {
        return emptyOverview({
          repository: input.target.kind === "pull_request" ? input.target.repository : null,
          targetLabel:
            input.target.kind === "pull_request"
              ? `${input.target.repository}#${input.target.number}`
              : `${input.target.remoteName}/${input.target.branch}`,
          unavailableReason: availabilityState.availability.message,
        });
      }

      let repository: string | null = null;
      let targetLabel = "";
      let resolvedSha: string | null = null;
      let isStale = false;
      let unavailableReason: string | null = null;

      if (input.target.kind === "pull_request") {
        repository = input.target.repository;
        targetLabel = `${input.target.repository}#${input.target.number}`;
        const pullRequest = yield* loadPullRequestDetailSnapshot({
          operation: "getWorkflowOverview",
          cwd: input.cwd,
          repository: input.target.repository,
          number: input.target.number,
        });
        resolvedSha = pullRequest.headSha === "unknown" ? null : pullRequest.headSha;
        unavailableReason = resolvedSha === null ? "Pull request head SHA is unavailable." : null;
      } else {
        targetLabel = `${input.target.remoteName}/${input.target.branch}`;
        repository = yield* resolveRepositoryFromRemoteName(input.cwd, input.target.remoteName);
        if (repository === null) {
          return emptyOverview({
            repository: null,
            targetLabel,
            unavailableReason: `GitHub repository for ${targetLabel} could not be resolved.`,
          });
        }
        const remoteRef = yield* resolveRemoteRefHeadSha(
          input.cwd,
          input.target.remoteName,
          input.target.branch,
        );
        resolvedSha = remoteRef.resolvedSha;
        isStale = remoteRef.isStale;
        unavailableReason = remoteRef.unavailableReason;
      }

      if (!repository || !resolvedSha) {
        return emptyOverview({
          repository,
          targetLabel,
          isStale,
          unavailableReason,
        });
      }

      const [checks, runs] = yield* Effect.all(
        [
          loadChecksForHeadSha({
            operation: "getWorkflowOverview",
            cwd: input.cwd,
            repository,
            headSha: resolvedSha,
          }),
          loadWorkflowRuns({
            operation: "getWorkflowOverview",
            cwd: input.cwd,
            repository,
            headSha: resolvedSha,
          }),
        ],
        { concurrency: "unbounded" },
      );

      return {
        availability: availabilityState.availability,
        target: input.target,
        repository,
        targetLabel,
        resolvedSha,
        isStale,
        unavailableReason,
        checks,
        runs,
        fetchedAt,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          availability: {
            kind: "error",
            message: error.detail,
          },
          target: input.target,
          repository: input.target.kind === "pull_request" ? input.target.repository : null,
          targetLabel:
            input.target.kind === "pull_request"
              ? `${input.target.repository}#${input.target.number}`
              : `${input.target.remoteName}/${input.target.branch}`,
          resolvedSha: null,
          isStale: false,
          unavailableReason: error.detail,
          checks: [],
          runs: [],
          fetchedAt,
        }),
      ),
    );
  });

  const addPullRequestComment: GitWorkspaceShape["addPullRequestComment"] = Effect.fn(
    "GitWorkspace.addPullRequestComment",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    const body = input.body.trim();
    if (body.length === 0) {
      return yield* Effect.fail(
        gitHubWorkspaceError("addPullRequestComment", "Comment body must not be empty."),
      );
    }

    yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: ["pr", "comment", "--repo", input.repository, String(input.number), "--body", body],
        timeoutMs: 20_000,
      })
      .pipe(
        Effect.mapError((error) =>
          gitHubWorkspaceError("addPullRequestComment", error.detail, error),
        ),
      );
    return {
      updatedAt: new Date().toISOString(),
    };
  });

  const submitPullRequestReview: GitWorkspaceShape["submitPullRequestReview"] = Effect.fn(
    "GitWorkspace.submitPullRequestReview",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    const baseArgs = ["pr", "review", "--repo", input.repository, String(input.number)];
    const eventArgs =
      input.event === "approve"
        ? ["--approve"]
        : input.event === "request_changes"
          ? ["--request-changes"]
          : ["--comment"];
    const body = trimToNull(input.body);
    if (input.event === "comment" && !body) {
      return yield* Effect.fail(
        gitHubWorkspaceError(
          "submitPullRequestReview",
          "A review comment body is required for comment-only reviews.",
        ),
      );
    }
    yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: [...baseArgs, ...eventArgs, ...(body ? ["--body", body] : [])],
        timeoutMs: 20_000,
      })
      .pipe(
        Effect.mapError((error) =>
          gitHubWorkspaceError("submitPullRequestReview", error.detail, error),
        ),
      );
    return {
      updatedAt: new Date().toISOString(),
    };
  });

  return {
    getRecentGraph,
    getGitHubWorkspace,
    getPullRequestInbox,
    getPullRequestDetail,
    getWorkflowOverview,
    addPullRequestComment,
    submitPullRequestReview,
  } satisfies GitWorkspaceShape;
});

export const GitWorkspaceLive = Layer.effect(GitWorkspace, makeGitWorkspace);
