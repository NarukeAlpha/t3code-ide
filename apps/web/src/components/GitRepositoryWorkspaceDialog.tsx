import type {
  EnvironmentId,
  GitGraphRef,
  GitRecentGraphResult,
  GitHubCheckSummary,
  GitHubPullRequestReviewEvent,
  GitHubWorkspacePullRequest,
  GitHubWorkspaceSnapshot,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitIcon,
  LoaderIcon,
  MessageSquareIcon,
  PlayCircleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  gitAddPullRequestCommentMutationOptions,
  gitHubWorkspaceQueryOptions,
  gitRecentGraphQueryOptions,
  gitSubmitPullRequestReviewMutationOptions,
} from "~/lib/gitReactQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
  countRecentGraphCommits,
  resolveActiveWorkspacePullRequest,
  workspacePullRequestKey,
} from "./GitRepositoryWorkspaceDialog.logic";

type RepositoryWorkspaceTab = "graph" | "pull_request" | "checks";

interface GitRepositoryWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  cwd: string | null;
}

const GRAPH_CELL_WIDTH_PX = 14;
const GRAPH_LANE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#f97316",
] as const;

function graphLaneColor(lane: number) {
  return GRAPH_LANE_COLORS[lane % GRAPH_LANE_COLORS.length] ?? GRAPH_LANE_COLORS[0];
}

function graphRefSortKey(type: GitGraphRef["type"]) {
  switch (type) {
    case "head":
      return 0;
    case "worktree":
      return 1;
    case "branch":
      return 2;
    case "remote":
      return 3;
    case "tag":
      return 4;
  }
}

function gitRefBadgeVariant(ref: GitGraphRef) {
  switch (ref.type) {
    case "head":
      return "default";
    case "worktree":
      return "info";
    case "branch":
      return ref.current ? "success" : "outline";
    case "remote":
      return "secondary";
    case "tag":
      return "warning";
  }
}

function checkBucketVariant(bucket: GitHubCheckSummary["bucket"]) {
  switch (bucket) {
    case "pass":
      return "success";
    case "fail":
      return "destructive";
    case "cancel":
      return "warning";
    case "skipping":
      return "secondary";
    case "pending":
    default:
      return "info";
  }
}

function workflowStateVariant(input: { status: string; conclusion: string | null }) {
  const conclusion = input.conclusion?.toLowerCase();
  const status = input.status.toLowerCase();
  if (conclusion === "success") {
    return "success";
  }
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required") {
    return "destructive";
  }
  if (conclusion === "cancelled" || conclusion === "neutral") {
    return "warning";
  }
  if (status === "completed") {
    return "secondary";
  }
  return "info";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortSha(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "unknown";
}

function WorkspaceAvailabilityEmpty({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <Empty className="min-h-[22rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RepositoryWorkspaceTabShell({
  toolbar,
  children,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-muted/10">
      {toolbar ? <div className="border-b bg-background/80 px-4 py-3">{toolbar}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  );
}

function PullRequestContextToolbar({
  workspace,
  activePullRequest,
  selectedPullRequestKey,
  onSelectedPullRequestKeyChange,
  onRefresh,
}: {
  workspace: GitHubWorkspaceSnapshot;
  activePullRequest: GitHubWorkspacePullRequest | null;
  selectedPullRequestKey: string | null;
  onSelectedPullRequestKeyChange: (key: string | null) => void;
  onRefresh: () => void;
}) {
  const pullRequestItems = useMemo(
    () =>
      workspace.pullRequests.map((pullRequest) => ({
        value: workspacePullRequestKey(pullRequest),
        label: `${pullRequest.repository}#${pullRequest.number}`,
      })),
    [workspace.pullRequests],
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {workspace.pullRequests.length > 1 ? (
          <Select
            value={
              selectedPullRequestKey ??
              workspacePullRequestKey(activePullRequest ?? workspace.pullRequests[0]!)
            }
            onValueChange={onSelectedPullRequestKeyChange}
            items={pullRequestItems}
          >
            <SelectTrigger className="max-w-[24rem]" size="sm" aria-label="Pull request context">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                <SelectGroupLabel>Pull Request Context</SelectGroupLabel>
                {workspace.pullRequests.map((pullRequest) => (
                  <SelectItem
                    key={workspacePullRequestKey(pullRequest)}
                    value={workspacePullRequestKey(pullRequest)}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span className="truncate">{pullRequest.repository}</span>
                      <Badge variant="outline" size="sm">
                        #{pullRequest.number}
                      </Badge>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
        ) : activePullRequest ? (
          <>
            <Badge variant="outline">{activePullRequest.repository}</Badge>
            <Badge variant="secondary">#{activePullRequest.number}</Badge>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-muted-foreground text-sm">
          Updated {formatDateTime(workspace.fetchedAt)}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function GitGraph({ graph }: { graph: GitRecentGraphResult }) {
  const refsByOid = useMemo(() => {
    const grouped = new Map<string, GitGraphRef[]>();
    for (const ref of graph.refs) {
      const current = grouped.get(ref.targetOid) ?? [];
      current.push(ref);
      grouped.set(ref.targetOid, current);
    }
    for (const refs of grouped.values()) {
      refs.sort((left, right) => graphRefSortKey(left.type) - graphRefSortKey(right.type));
    }
    return grouped;
  }, [graph.refs]);
  const commitCount = useMemo(() => countRecentGraphCommits(graph), [graph]);

  if (graph.rows.length === 0) {
    return (
      <WorkspaceAvailabilityEmpty
        title="No commits to render"
        description="This repository does not have visible commits yet."
        icon={<GitCommitIcon />}
      />
    );
  }

  const graphPrefixWidth = Math.max(graph.maxColumns, 1) * GRAPH_CELL_WIDTH_PX;

  return (
    <RepositoryWorkspaceTabShell
      toolbar={
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          {graph.topology.headBranch ? (
            <Badge variant="outline" size="sm">
              HEAD: {graph.topology.headBranch}
            </Badge>
          ) : (
            <Badge variant="warning" size="sm">
              Detached HEAD
            </Badge>
          )}
          {graph.topology.defaultBranch ? (
            <Badge variant="secondary" size="sm">
              Default: {graph.topology.defaultBranch}
            </Badge>
          ) : null}
          <span>{commitCount} commits</span>
          {graph.truncated ? <span>Showing the most recent slice only.</span> : null}
        </div>
      }
    >
      <div className="overflow-x-auto">
        <div className="min-w-[48rem] space-y-0.5">
          {graph.rows.map((row) => {
            const refs = row.commit ? (refsByOid.get(row.commit.oid) ?? []) : [];
            const cellsByColumn = new Map(row.cells.map((cell) => [cell.column, cell]));
            const columns = Array.from(
              { length: Math.max(graph.maxColumns, 1) },
              (_, graphColumn) => graphColumn,
            );

            return (
              <div
                key={row.id}
                className="grid items-start gap-3"
                style={{ gridTemplateColumns: `${graphPrefixWidth}px minmax(0,1fr)` }}
              >
                <div className="font-mono text-[13px] leading-6">
                  {columns.map((graphColumn) => {
                    const cell = cellsByColumn.get(graphColumn);
                    return (
                      <span
                        key={`${row.id}-${graphColumn}`}
                        className="inline-block text-center"
                        style={{
                          width: `${GRAPH_CELL_WIDTH_PX}px`,
                          color: cell ? graphLaneColor(cell.lane ?? 0) : undefined,
                        }}
                      >
                        {cell?.glyph ?? " "}
                      </span>
                    );
                  })}
                </div>
                {row.commit ? (
                  <div className="min-w-0 py-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium text-sm">{row.commit.subject}</span>
                      {refs.map((ref) => (
                        <Badge
                          key={ref.id}
                          size="sm"
                          variant={gitRefBadgeVariant(ref)}
                          className="shrink-0"
                        >
                          {ref.label}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                      <span>{row.commit.shortOid}</span>
                      <span>{row.commit.authorName}</span>
                      <span>{formatDateTime(row.commit.authoredAt)}</span>
                      {row.commit.parentOids.length > 0 ? (
                        <span>
                          {row.commit.parentOids.length} parent
                          {row.commit.parentOids.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </RepositoryWorkspaceTabShell>
  );
}

function PullRequestPanel({
  workspace,
  pullRequest,
  divergenceNotice,
  selectedPullRequestKey,
  onSelectedPullRequestKeyChange,
  onRefresh,
  onSubmitComment,
  onSubmitReview,
  isCommentPending,
  isReviewPending,
}: {
  workspace: GitHubWorkspaceSnapshot;
  pullRequest: GitHubWorkspacePullRequest | null;
  divergenceNotice: string | null;
  selectedPullRequestKey: string | null;
  onSelectedPullRequestKeyChange: (key: string | null) => void;
  onRefresh: () => void;
  onSubmitComment: (body: string) => Promise<void>;
  onSubmitReview: (event: GitHubPullRequestReviewEvent, body: string) => Promise<void>;
  isCommentPending: boolean;
  isReviewPending: boolean;
}) {
  const [commentBody, setCommentBody] = useState("");
  const [reviewBody, setReviewBody] = useState("");

  useEffect(() => {
    setCommentBody("");
    setReviewBody("");
  }, [pullRequest?.repository, pullRequest?.number]);

  if (workspace.availability.kind !== "available") {
    return (
      <WorkspaceAvailabilityEmpty
        title="GitHub PR Features Unavailable"
        description={workspace.availability.message}
        icon={<ShieldAlertIcon />}
      />
    );
  }

  if (!pullRequest) {
    return (
      <WorkspaceAvailabilityEmpty
        title="No Matching Pull Requests"
        description="No pull requests were found for the current branch context."
        icon={<GitBranchIcon />}
      />
    );
  }

  return (
    <RepositoryWorkspaceTabShell
      toolbar={
        <div className="space-y-3">
          <PullRequestContextToolbar
            workspace={workspace}
            activePullRequest={pullRequest}
            selectedPullRequestKey={selectedPullRequestKey}
            onSelectedPullRequestKeyChange={onSelectedPullRequestKeyChange}
            onRefresh={onRefresh}
          />
          {divergenceNotice ? (
            <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-amber-950 dark:text-amber-100">{divergenceNotice}</div>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/20 p-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{pullRequest.repository}</Badge>
              <Badge variant="outline">#{pullRequest.number}</Badge>
              <Badge variant={pullRequest.isDraft ? "warning" : "success"}>
                {pullRequest.isDraft ? "Draft" : pullRequest.state}
              </Badge>
              {pullRequest.reviewDecision ? (
                <Badge variant="secondary">{pullRequest.reviewDecision}</Badge>
              ) : null}
            </div>
            <div className="font-semibold text-lg leading-tight">{pullRequest.title}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
              <span>
                {pullRequest.baseBranch} ← {pullRequest.headBranch}
              </span>
              {pullRequest.author ? <span>@{pullRequest.author.login}</span> : null}
              <span>Updated {formatDateTime(pullRequest.updatedAt)}</span>
            </div>
          </div>
          <Button render={<a href={pullRequest.url} rel="noreferrer" target="_blank" />}>
            <ExternalLinkIcon />
            Open on GitHub
          </Button>
        </div>

        {pullRequest.body.trim().length > 0 ? (
          <div className="rounded-lg border bg-background p-4">
            <div className="mb-2 font-medium text-sm">Description</div>
            <pre className="whitespace-pre-wrap break-words text-sm">{pullRequest.body}</pre>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border bg-background p-4">
            <div className="font-medium text-sm">Add Comment</div>
            <Textarea
              rows={6}
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder="Leave a top-level pull request comment"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={isCommentPending || commentBody.trim().length === 0}
                onClick={() => void onSubmitComment(commentBody)}
              >
                {isCommentPending ? <LoaderIcon className="animate-spin" /> : <MessageSquareIcon />}
                Comment
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-background p-4">
            <div className="font-medium text-sm">Submit Review</div>
            <Textarea
              rows={6}
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
              placeholder="Optional review summary"
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={isReviewPending || reviewBody.trim().length === 0}
                onClick={() => void onSubmitReview("comment", reviewBody)}
              >
                {isReviewPending ? <LoaderIcon className="animate-spin" /> : <MessageSquareIcon />}
                Comment
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isReviewPending}
                onClick={() => void onSubmitReview("request_changes", reviewBody)}
              >
                <ShieldAlertIcon />
                Request Changes
              </Button>
              <Button
                size="sm"
                disabled={isReviewPending}
                onClick={() => void onSubmitReview("approve", reviewBody)}
              >
                <ShieldCheckIcon />
                Approve
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border bg-background p-4">
            <div className="font-medium text-sm">Comments</div>
            {pullRequest.comments.length === 0 ? (
              <div className="text-muted-foreground text-sm">No top-level comments.</div>
            ) : (
              <div className="space-y-3">
                {pullRequest.comments.map((comment) => (
                  <div key={comment.id} className="rounded-md border bg-muted/16 p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline" size="sm">
                        {comment.author ? `@${comment.author.login}` : "Unknown author"}
                      </Badge>
                      <span className="text-muted-foreground">
                        {formatDateTime(comment.updatedAt)}
                      </span>
                      <a
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        href={comment.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-sm">{comment.body}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border bg-background p-4">
            <div className="font-medium text-sm">Reviews</div>
            {pullRequest.reviews.length === 0 ? (
              <div className="text-muted-foreground text-sm">No submitted reviews.</div>
            ) : (
              <div className="space-y-3">
                {pullRequest.reviews.map((review) => (
                  <div key={review.id} className="rounded-md border bg-muted/16 p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline" size="sm">
                        {review.author ? `@${review.author.login}` : "Unknown reviewer"}
                      </Badge>
                      <Badge variant="secondary" size="sm">
                        {review.state}
                      </Badge>
                      {review.submittedAt ? (
                        <span className="text-muted-foreground">
                          {formatDateTime(review.submittedAt)}
                        </span>
                      ) : null}
                      <a
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        href={review.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    </div>
                    {review.body.trim().length > 0 ? (
                      <pre className="whitespace-pre-wrap break-words text-sm">{review.body}</pre>
                    ) : (
                      <div className="text-muted-foreground text-sm">No review body.</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </RepositoryWorkspaceTabShell>
  );
}

function ChecksPanel({
  workspace,
  pullRequest,
  divergenceNotice,
  selectedPullRequestKey,
  onSelectedPullRequestKeyChange,
  onRefresh,
}: {
  workspace: GitHubWorkspaceSnapshot;
  pullRequest: GitHubWorkspacePullRequest | null;
  divergenceNotice: string | null;
  selectedPullRequestKey: string | null;
  onSelectedPullRequestKeyChange: (key: string | null) => void;
  onRefresh: () => void;
}) {
  if (workspace.availability.kind !== "available") {
    return (
      <WorkspaceAvailabilityEmpty
        title="GitHub Checks Unavailable"
        description={workspace.availability.message}
        icon={<ShieldAlertIcon />}
      />
    );
  }

  if (!pullRequest) {
    return (
      <WorkspaceAvailabilityEmpty
        title="No Matching Pull Requests"
        description="Checks and workflow runs are shown for the active pull request context."
        icon={<PlayCircleIcon />}
      />
    );
  }

  return (
    <RepositoryWorkspaceTabShell
      toolbar={
        <div className="space-y-3">
          <PullRequestContextToolbar
            workspace={workspace}
            activePullRequest={pullRequest}
            selectedPullRequestKey={selectedPullRequestKey}
            onSelectedPullRequestKeyChange={onSelectedPullRequestKeyChange}
            onRefresh={onRefresh}
          />
          {divergenceNotice ? (
            <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-amber-950 dark:text-amber-100">{divergenceNotice}</div>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <div className="font-medium text-sm">PR Checks</div>
          {pullRequest.checks.length === 0 ? (
            <div className="text-muted-foreground text-sm">No checks reported for this PR.</div>
          ) : (
            <div className="space-y-2">
              {pullRequest.checks.map((check) => (
                <div
                  key={`${pullRequest.repository}-${pullRequest.number}-${check.name}-${check.startedAt ?? "na"}`}
                  className="rounded-md border bg-muted/16 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={checkBucketVariant(check.bucket)} size="sm">
                      {check.bucket}
                    </Badge>
                    <span className="font-medium text-sm">{check.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                    <span>{check.state}</span>
                    {check.workflow ? <span>{check.workflow}</span> : null}
                    {check.event ? <span>{check.event}</span> : null}
                    {check.completedAt ? <span>{formatDateTime(check.completedAt)}</span> : null}
                    {check.link ? (
                      <a
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        href={check.link}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    ) : null}
                  </div>
                  {check.description ? (
                    <div className="mt-1 text-muted-foreground text-xs">{check.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-lg border bg-background p-4">
          <div className="font-medium text-sm">Workflow Runs</div>
          {pullRequest.runs.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No workflow runs were found for the current PR head SHA.
            </div>
          ) : (
            <div className="space-y-3">
              {pullRequest.runs.map((run) => (
                <div
                  key={`${pullRequest.repository}-${pullRequest.number}-${run.id}`}
                  className="rounded-md border bg-muted/16 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={workflowStateVariant(run)} size="sm">
                          {run.conclusion ?? run.status}
                        </Badge>
                        <span className="font-medium text-sm">{run.name}</span>
                        {run.workflowName ? (
                          <span className="text-muted-foreground text-xs">{run.workflowName}</span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                        <span>{run.event}</span>
                        {run.headBranch ? <span>{run.headBranch}</span> : null}
                        {run.attempt ? <span>Attempt {run.attempt}</span> : null}
                        {run.startedAt ? <span>{formatDateTime(run.startedAt)}</span> : null}
                      </div>
                    </div>
                    <a
                      className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                      href={run.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </div>
                  <div className="mt-3 space-y-2">
                    {run.jobs.length === 0 ? (
                      <div className="text-muted-foreground text-xs">No job details returned.</div>
                    ) : (
                      run.jobs.map((job) => (
                        <div
                          key={job.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-sm">{job.name}</div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                              <span>{job.status}</span>
                              {job.conclusion ? <span>{job.conclusion}</span> : null}
                              {job.startedAt ? <span>{formatDateTime(job.startedAt)}</span> : null}
                            </div>
                          </div>
                          <a
                            className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                            href={job.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open
                            <ExternalLinkIcon className="size-3" />
                          </a>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </RepositoryWorkspaceTabShell>
  );
}

export function GitRepositoryWorkspaceDialog({
  open,
  onOpenChange,
  environmentId,
  cwd,
}: GitRepositoryWorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<RepositoryWorkspaceTab>("graph");
  const [selectedPullRequestKey, setSelectedPullRequestKey] = useState<string | null>(null);
  const [isWindowVisible, setIsWindowVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const handleVisibilityChange = () => {
      setIsWindowVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const graphQuery = useQuery({
    ...gitRecentGraphQueryOptions({
      environmentId,
      cwd,
      enabled: open,
    }),
  });

  const workspaceQuery = useQuery({
    ...gitHubWorkspaceQueryOptions({
      environmentId,
      cwd,
      enabled: open,
    }),
    refetchInterval: open && activeTab === "checks" && isWindowVisible ? 15_000 : false,
  });

  const activePullRequest = useMemo(
    () => resolveActiveWorkspacePullRequest(workspaceQuery.data ?? null, selectedPullRequestKey),
    [selectedPullRequestKey, workspaceQuery.data],
  );

  const divergenceNotice = useMemo(() => {
    if (!graphQuery.data?.topology.headOid || !activePullRequest) {
      return null;
    }
    if (graphQuery.data.topology.headOid === activePullRequest.headSha) {
      return null;
    }
    return `Local HEAD ${shortSha(graphQuery.data.topology.headOid)} differs from this PR head ${shortSha(activePullRequest.headSha)}. Pull request details and checks reflect the remote PR head, not unpublished local commits.`;
  }, [activePullRequest, graphQuery.data]);

  const commentMutation = useMutation(
    gitAddPullRequestCommentMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const reviewMutation = useMutation(
    gitSubmitPullRequestReviewMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );

  const handleRefreshWorkspace = async () => {
    await workspaceQuery.refetch();
  };

  const handleSubmitComment = async (body: string) => {
    if (!cwd || !activePullRequest) {
      return;
    }
    await commentMutation.mutateAsync({
      cwd,
      repository: activePullRequest.repository,
      number: activePullRequest.number,
      body: body.trim(),
    });
    toastManager.add({
      type: "success",
      title: "Comment added",
      description: "The pull request comment was posted successfully.",
    });
  };

  const handleSubmitReview = async (event: GitHubPullRequestReviewEvent, body: string) => {
    if (!cwd || !activePullRequest) {
      return;
    }
    await reviewMutation.mutateAsync({
      cwd,
      repository: activePullRequest.repository,
      number: activePullRequest.number,
      event,
      ...(body.trim().length > 0 ? { body: body.trim() } : {}),
    });
    toastManager.add({
      type: "success",
      title:
        event === "approve"
          ? "Review approved"
          : event === "request_changes"
            ? "Changes requested"
            : "Review comment added",
    });
  };

  const renderTabBody = () => {
    if (!cwd || !environmentId) {
      return (
        <WorkspaceAvailabilityEmpty
          title="Repository Workspace Unavailable"
          description="A connected environment is required to inspect repository state."
          icon={<AlertCircleIcon />}
        />
      );
    }

    if (activeTab === "graph") {
      if (graphQuery.isLoading) {
        return (
          <WorkspaceAvailabilityEmpty
            title="Loading Graph"
            description="Fetching the recent commit graph for this repository."
            icon={<LoaderIcon className="animate-spin" />}
          />
        );
      }
      if (graphQuery.error) {
        return (
          <WorkspaceAvailabilityEmpty
            title="Unable To Load Graph"
            description={graphQuery.error.message}
            icon={<AlertCircleIcon />}
          />
        );
      }
      if (!graphQuery.data) {
        return null;
      }
      return <GitGraph graph={graphQuery.data} />;
    }

    if (workspaceQuery.isLoading) {
      return (
        <WorkspaceAvailabilityEmpty
          title="Loading GitHub Workspace"
          description="Fetching PR, checks, and workflow details from GitHub."
          icon={<LoaderIcon className="animate-spin" />}
        />
      );
    }

    if (workspaceQuery.error) {
      return (
        <WorkspaceAvailabilityEmpty
          title="Unable To Load GitHub Workspace"
          description={workspaceQuery.error.message}
          icon={<AlertCircleIcon />}
        />
      );
    }

    if (!workspaceQuery.data) {
      return null;
    }

    if (activeTab === "pull_request") {
      return (
        <PullRequestPanel
          workspace={workspaceQuery.data}
          pullRequest={activePullRequest}
          divergenceNotice={divergenceNotice}
          selectedPullRequestKey={selectedPullRequestKey}
          onSelectedPullRequestKeyChange={setSelectedPullRequestKey}
          onRefresh={() => void handleRefreshWorkspace()}
          onSubmitComment={(body) => handleSubmitComment(body)}
          onSubmitReview={(event, body) => handleSubmitReview(event, body)}
          isCommentPending={commentMutation.isPending}
          isReviewPending={reviewMutation.isPending}
        />
      );
    }

    return (
      <ChecksPanel
        workspace={workspaceQuery.data}
        pullRequest={activePullRequest}
        divergenceNotice={divergenceNotice}
        selectedPullRequestKey={selectedPullRequestKey}
        onSelectedPullRequestKeyChange={setSelectedPullRequestKey}
        onRefresh={() => void handleRefreshWorkspace()}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-h-[84vh] max-w-5xl">
        <DialogHeader className="pb-4">
          <DialogTitle>Repository Workspace</DialogTitle>
          <DialogDescription>
            Explore the recent graph, inspect the current pull request, and monitor GitHub checks
            without leaving the existing Git controls.
          </DialogDescription>
          <ToggleGroup
            aria-label="Repository workspace tabs"
            className="mt-2"
            value={[activeTab]}
            onValueChange={(value) => {
              const nextValue = value[0];
              if (nextValue) {
                setActiveTab(nextValue as RepositoryWorkspaceTab);
              }
            }}
          >
            <ToggleGroupItem value="graph">Graph</ToggleGroupItem>
            <ToggleGroupItem value="pull_request">Pull Request</ToggleGroupItem>
            <ToggleGroupItem value="checks">Checks</ToggleGroupItem>
          </ToggleGroup>
        </DialogHeader>
        <DialogPanel className="min-h-[36rem] max-h-[68vh] overflow-hidden">
          {renderTabBody()}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
