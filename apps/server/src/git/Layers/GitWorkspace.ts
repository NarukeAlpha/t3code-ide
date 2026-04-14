import { Cause, Effect, Exit, Layer, Path } from "effect";

import type {
  GitGraphNode,
  GitGraphRef,
  GitHubActor,
  GitHubCheckBucket,
  GitHubCheckSummary,
  GitHubPullRequestComment,
  GitHubPullRequestReview,
  GitHubReviewState,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  GitRecentGraphResult,
  GitTopologyWorktree,
} from "@t3tools/contracts";
import type { GitCommandError } from "@t3tools/contracts";
import { GitHubWorkspaceError } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitManager } from "../Services/GitManager.ts";
import { GitWorkspace, type GitWorkspaceShape } from "../Services/GitWorkspace.ts";

const DEFAULT_GRAPH_LIMIT = 200;

type GraphCommitMetadata = {
  readonly oid: string;
  readonly shortOid: string;
  readonly authoredAt: string;
  readonly authorName: string;
  readonly subject: string;
};

type GraphCommitLine = {
  readonly oid: string;
  readonly parentOids: ReadonlyArray<string>;
};

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

function normalizeCheckBucket(value: unknown): GitHubCheckBucket {
  switch (trimToNull(value)?.toLowerCase()) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "skipping":
      return "skipping";
    case "cancel":
      return "cancel";
    case "pending":
    default:
      return "pending";
  }
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

function parseGraphCommitLine(line: string): GraphCommitLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  const oid = parts[0]?.trim();
  if (!oid) {
    return null;
  }
  return {
    oid,
    parentOids: parts.slice(1),
  };
}

function parseCommitMetadataLines(stdout: string): Map<string, GraphCommitMetadata> {
  const metadata = new Map<string, GraphCommitMetadata>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [oid, shortOid, authoredAtEpoch, authorName, subject] = line.split("\u0000");
    const commitOid = trimToNull(oid);
    if (!commitOid) {
      continue;
    }
    const authoredAtSeconds = Number.parseInt(authoredAtEpoch ?? "", 10);
    const authoredAt = Number.isFinite(authoredAtSeconds)
      ? new Date(authoredAtSeconds * 1000).toISOString()
      : new Date(0).toISOString();
    metadata.set(commitOid, {
      oid: commitOid,
      shortOid: ensureNonEmpty(shortOid, commitOid.slice(0, 7)),
      authoredAt,
      authorName: ensureNonEmpty(authorName, "Unknown author"),
      subject: ensureNonEmpty(subject, "(no subject)"),
    });
  }
  return metadata;
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

function normalizeCheckSummary(value: unknown): GitHubCheckSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = trimToNull(record.name);
  const state = trimToNull(record.state);
  if (!name || !state) {
    return null;
  }
  const workflow = trimToNull(record.workflow);
  const description = trimToNull(record.description);
  const event = trimToNull(record.event);
  const link = trimToNull(record.link);
  return {
    name,
    state,
    bucket: normalizeCheckBucket(record.bucket),
    ...(workflow ? { workflow } : {}),
    ...(description ? { description } : {}),
    ...(event ? { event } : {}),
    ...(link ? { link } : {}),
    startedAt: trimToNull(record.startedAt) ? normalizeIsoDateTime(record.startedAt) : null,
    completedAt: trimToNull(record.completedAt) ? normalizeIsoDateTime(record.completedAt) : null,
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
  const path = yield* Path.Path;

  const executeOptionalGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    gitCore.execute({
      operation,
      cwd,
      args,
      allowNonZeroExit: true,
      truncateOutputAtMaxBytes: true,
      maxOutputBytes: 512 * 1024,
    });

  const resolveRepositoryNameWithOwner = Effect.fn("GitWorkspace.resolveRepositoryNameWithOwner")(
    function* (
      cwd: string,
      branch: string | null,
    ): Effect.fn.Return<string | null, GitHubWorkspaceError> {
      const preferredRemote =
        branch === null
          ? "origin"
          : ((yield* gitCore
              .readConfigValue(cwd, `branch.${branch}.remote`)
              .pipe(Effect.catch(() => Effect.succeed(null)))) ?? "origin");
      const remoteUrl =
        (yield* gitCore
          .readConfigValue(cwd, `remote.${preferredRemote}.url`)
          .pipe(Effect.catch(() => Effect.succeed(null)))) ??
        (yield* gitCore
          .readConfigValue(cwd, "remote.origin.url")
          .pipe(Effect.catch(() => Effect.succeed(null))));
      const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      if (parsed) {
        return parsed;
      }

      const repoView = yield* gitHubCli
        .execute({
          cwd,
          args: ["repo", "view", "--json", "nameWithOwner"],
          timeoutMs: 20_000,
        })
        .pipe(
          Effect.mapError((error) =>
            gitHubWorkspaceError("resolveRepositoryNameWithOwner", error.detail, error),
          ),
        );
      const decoded = yield* parseJson(
        "resolveRepositoryNameWithOwner",
        "GitHub CLI returned invalid repository metadata JSON.",
        repoView.stdout,
      );
      const repositoryNameWithOwner =
        decoded && typeof decoded === "object"
          ? trimToNull((decoded as Record<string, unknown>).nameWithOwner)
          : null;
      return repositoryNameWithOwner;
    },
  );

  const getRecentGraph: GitWorkspaceShape["getRecentGraph"] = Effect.fn(
    "GitWorkspace.getRecentGraph",
  )(function* (input): Effect.fn.Return<GitRecentGraphResult, GitCommandError> {
    const limit = input.limit ?? DEFAULT_GRAPH_LIMIT;
    const revListArgs = [
      "rev-list",
      "--parents",
      "--topo-order",
      "--all",
      `--max-count=${limit + 1}`,
    ];
    const revList = yield* gitCore.execute({
      operation: "GitWorkspace.getRecentGraph.revList",
      cwd: input.cwd,
      args: revListArgs,
      truncateOutputAtMaxBytes: true,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    const commitLines = revList.stdout
      .split("\n")
      .map(parseGraphCommitLine)
      .filter((value): value is GraphCommitLine => value !== null);
    const truncated = commitLines.length > limit;
    const selectedCommitLines = commitLines.slice(0, limit);
    const commitOids = selectedCommitLines.map((line) => line.oid);

    const metadataByOid =
      commitOids.length === 0
        ? new Map<string, GraphCommitMetadata>()
        : parseCommitMetadataLines(
            (yield* gitCore.execute({
              operation: "GitWorkspace.getRecentGraph.commitMetadata",
              cwd: input.cwd,
              args: ["show", "-s", "--format=%H%x00%h%x00%ct%x00%an%x00%s", ...commitOids],
              truncateOutputAtMaxBytes: true,
              maxOutputBytes: 2 * 1024 * 1024,
            })).stdout,
          );

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

    const nodes: GitGraphNode[] = selectedCommitLines.map((line) => {
      const metadata = metadataByOid.get(line.oid);
      return {
        oid: line.oid,
        shortOid: metadata?.shortOid ?? line.oid.slice(0, 7),
        parentOids: [...line.parentOids],
        subject: metadata?.subject ?? "(no subject)",
        authoredAt: metadata?.authoredAt ?? new Date(0).toISOString(),
        authorName: metadata?.authorName ?? "Unknown author",
        isHead: headOid === line.oid,
        isMergeCommit: line.parentOids.length > 1,
      };
    });

    return {
      nodes,
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
    const localStatus = yield* gitManager
      .localStatus({ cwd: input.cwd })
      .pipe(Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.message, error)));

    const emptySnapshot = {
      pullRequest: null,
      checks: [],
      runs: [],
      fetchedAt: new Date().toISOString(),
    } as const;

    if (!localStatus.isRepo) {
      return {
        availability: {
          kind: "error",
          message: "Git repository status is unavailable for this workspace.",
        },
        ...emptySnapshot,
      };
    }

    if (localStatus.hostingProvider?.kind !== "github") {
      return {
        availability: {
          kind: "unsupported_host",
          message:
            localStatus.hostingProvider?.name ??
            "This repository is not configured for GitHub workspace features.",
          ...(localStatus.hostingProvider ? { hostingProvider: localStatus.hostingProvider } : {}),
        },
        ...emptySnapshot,
      };
    }

    const authStatusExit = yield* Effect.exit(
      gitHubCli.execute({
        cwd: input.cwd,
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
            kind: "gh_unavailable",
            message: "GitHub CLI is required for PR and checks features.",
            hostingProvider: localStatus.hostingProvider,
          },
          ...emptySnapshot,
        };
      }
      if (isGitHubCliUnauthenticated(detail)) {
        return {
          availability: {
            kind: "gh_unauthenticated",
            message: "Authenticate GitHub CLI with `gh auth login` to use PR features.",
            hostingProvider: localStatus.hostingProvider,
          },
          ...emptySnapshot,
        };
      }
      return {
        availability: {
          kind: "error",
          message: detail,
          hostingProvider: localStatus.hostingProvider,
        },
        ...emptySnapshot,
      };
    }

    const status = yield* gitManager
      .status({ cwd: input.cwd })
      .pipe(Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.message, error)));

    if (!status.pr || status.pr.state !== "open") {
      return {
        availability: {
          kind: "available",
          message: "GitHub workspace is available.",
          hostingProvider: status.hostingProvider ?? localStatus.hostingProvider,
        },
        ...emptySnapshot,
      };
    }

    const prViewResult = yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(status.pr.number),
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
      .pipe(Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.detail, error)));
    const prRaw = yield* parseJson(
      "getWorkspace",
      "GitHub CLI returned invalid pull request JSON.",
      prViewResult.stdout,
    );
    const prRecord = prRaw && typeof prRaw === "object" ? (prRaw as Record<string, unknown>) : {};
    const pullRequest = {
      number: Number(prRecord.number ?? status.pr.number),
      title: ensureNonEmpty(prRecord.title, status.pr.title),
      url: ensureNonEmpty(prRecord.url, status.pr.url),
      state:
        trimToNull(prRecord.state)?.toLowerCase() === "merged"
          ? "merged"
          : trimToNull(prRecord.state)?.toLowerCase() === "closed"
            ? "closed"
            : "open",
      isDraft: Boolean(prRecord.isDraft),
      body: typeof prRecord.body === "string" ? prRecord.body : "",
      author: normalizeActor(prRecord.author),
      reviewDecision: trimToNull(prRecord.reviewDecision),
      baseBranch: ensureNonEmpty(prRecord.baseRefName, status.pr.baseBranch),
      headBranch: ensureNonEmpty(prRecord.headRefName, status.pr.headBranch),
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

    const checksResult = yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: [
          "pr",
          "checks",
          String(status.pr.number),
          "--json",
          "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
        ],
        timeoutMs: 20_000,
      })
      .pipe(Effect.mapError((error) => gitHubWorkspaceError("getWorkspace", error.detail, error)));
    const checksRaw = yield* parseJson(
      "getWorkspace",
      "GitHub CLI returned invalid PR checks JSON.",
      checksResult.stdout,
    );
    const checks = Array.isArray(checksRaw)
      ? checksRaw
          .map(normalizeCheckSummary)
          .filter((value): value is GitHubCheckSummary => value !== null)
      : [];

    const repositoryNameWithOwner = yield* resolveRepositoryNameWithOwner(input.cwd, status.branch);
    const runs =
      repositoryNameWithOwner && pullRequest.headSha !== "unknown"
        ? yield* Effect.gen(function* () {
            const runsResult = yield* gitHubCli
              .execute({
                cwd: input.cwd,
                args: [
                  "api",
                  `repos/${repositoryNameWithOwner}/actions/runs?head_sha=${encodeURIComponent(
                    pullRequest.headSha,
                  )}&per_page=10`,
                ],
                timeoutMs: 20_000,
              })
              .pipe(
                Effect.mapError((error) =>
                  gitHubWorkspaceError("getWorkspace", error.detail, error),
                ),
              );
            const runsRaw = yield* parseJson(
              "getWorkspace",
              "GitHub CLI returned invalid workflow runs JSON.",
              runsResult.stdout,
            );
            const runEntries =
              runsRaw &&
              typeof runsRaw === "object" &&
              Array.isArray((runsRaw as any).workflow_runs)
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
                      args: [
                        "api",
                        `repos/${repositoryNameWithOwner}/actions/runs/${runId}/jobs?per_page=50`,
                      ],
                      timeoutMs: 20_000,
                    })
                    .pipe(
                      Effect.mapError((error) =>
                        gitHubWorkspaceError("getWorkspace", error.detail, error),
                      ),
                    );
                  const jobsRaw = yield* parseJson(
                    "getWorkspace",
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
              Effect.map((values) =>
                values.filter((value): value is GitHubWorkflowRun => value !== null),
              ),
            );
          })
        : [];

    return {
      availability: {
        kind: "available",
        message: "GitHub workspace is available.",
        hostingProvider: status.hostingProvider ?? localStatus.hostingProvider,
      },
      pullRequest,
      checks,
      runs,
      fetchedAt: new Date().toISOString(),
    };
  });

  const addPullRequestComment: GitWorkspaceShape["addPullRequestComment"] = Effect.fn(
    "GitWorkspace.addPullRequestComment",
  )(function* (input): Effect.fn.Return<any, GitHubWorkspaceError> {
    yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: ["pr", "comment", String(input.number), "--body", input.body],
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
    const baseArgs = ["pr", "review", String(input.number)];
    const eventArgs =
      input.event === "approve"
        ? ["--approve"]
        : input.event === "request_changes"
          ? ["--request-changes"]
          : ["--comment"];
    const body = trimToNull(input.body);
    if (input.event === "comment" && !body) {
      return yield* gitHubWorkspaceError(
        "submitPullRequestReview",
        "A review comment body is required for comment-only reviews.",
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
    addPullRequestComment,
    submitPullRequestReview,
  } satisfies GitWorkspaceShape;
});

export const GitWorkspaceLive = Layer.effect(GitWorkspace, makeGitWorkspace);
