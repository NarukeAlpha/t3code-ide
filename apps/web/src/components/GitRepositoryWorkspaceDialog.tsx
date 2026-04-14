import type {
  EnvironmentId,
  GitGraphNode,
  GitGraphRef,
  GitRecentGraphResult,
  GitHubCheckSummary,
  GitHubPullRequestReviewEvent,
  GitHubWorkspaceSnapshot,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
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
import { useEffect, useMemo, useState } from "react";

import {
  gitAddPullRequestCommentMutationOptions,
  gitHubWorkspaceQueryOptions,
  gitRecentGraphQueryOptions,
  gitSubmitPullRequestReviewMutationOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
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
import { Textarea } from "~/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { toastManager } from "~/components/ui/toast";

type RepositoryWorkspaceTab = "graph" | "pull_request" | "checks";

interface GitRepositoryWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  cwd: string | null;
}

const GRAPH_ROW_HEIGHT = 24;
const GRAPH_NODE_Y = GRAPH_ROW_HEIGHT / 2;
const GRAPH_LANE_WIDTH = 14;
const GRAPH_LANE_OFFSET = 12;

type GraphRow = {
  readonly node: GitGraphNode;
  readonly lanesBefore: ReadonlyArray<string>;
  readonly lanesAfter: ReadonlyArray<string>;
  readonly nodeLane: number;
  readonly hadExistingLane: boolean;
};

function laneX(lane: number) {
  return GRAPH_LANE_OFFSET + lane * GRAPH_LANE_WIDTH;
}

function buildGraphRows(nodes: ReadonlyArray<GitGraphNode>) {
  let lanes: string[] = [];
  let maxLaneCount = 1;
  const rows: GraphRow[] = [];

  for (const node of nodes) {
    const existingLane = lanes.indexOf(node.oid);
    const lanesBefore = existingLane === -1 ? [node.oid, ...lanes] : [...lanes];
    const nodeLane = lanesBefore.indexOf(node.oid);
    const lanesAfter = lanesBefore.filter((oid) => oid !== node.oid);

    node.parentOids.forEach((parentOid, index) => {
      const existingParentIndex = lanesAfter.indexOf(parentOid);
      if (existingParentIndex !== -1) {
        lanesAfter.splice(existingParentIndex, 1);
      }
      const insertAt = Math.min(nodeLane + index, lanesAfter.length);
      lanesAfter.splice(insertAt, 0, parentOid);
    });

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
  const { rows, maxLaneCount } = useMemo(() => buildGraphRows(graph.nodes), [graph.nodes]);
  const graphWidth = Math.max(72, GRAPH_LANE_OFFSET * 2 + (maxLaneCount - 1) * GRAPH_LANE_WIDTH);

  if (rows.length === 0) {
    return (
      <Empty className="min-h-[22rem]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCommitIcon />
          </EmptyMedia>
          <EmptyTitle>No commits to render</EmptyTitle>
          <EmptyDescription>This repository does not have visible commits yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-2">
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
        <span>{graph.nodes.length} commits</span>
        {graph.truncated ? <span>Showing the most recent slice only.</span> : null}
      </div>
      <div className="overflow-x-auto rounded-lg border bg-muted/24">
        <div className="min-w-[46rem] divide-y">
          {rows.map((row) => {
            const refs = refsByOid.get(row.node.oid) ?? [];
            return (
              <div
                key={row.node.oid}
                className="grid grid-cols-[7rem_minmax(0,1fr)] items-stretch gap-3 px-3 py-1.5"
              >
                <div className="flex items-center">
                  <svg
                    aria-hidden="true"
                    className="overflow-visible"
                    height={GRAPH_ROW_HEIGHT}
                    width={graphWidth}
                  >
                    {row.lanesBefore.map((oid, laneIndex) => {
                      if (oid === row.node.oid) {
                        return null;
                      }
                      const nextLane = row.lanesAfter.indexOf(oid);
                      if (nextLane === -1) {
                        return null;
                      }
                      return (
                        <line
                          key={`${row.node.oid}-${oid}`}
                          x1={laneX(laneIndex)}
                          x2={laneX(nextLane)}
                          y1={0}
                          y2={GRAPH_ROW_HEIGHT}
                          className="stroke-border"
                          strokeWidth={1.5}
                        />
                      );
                    })}
                    {row.hadExistingLane ? (
                      <line
                        x1={laneX(row.nodeLane)}
                        x2={laneX(row.nodeLane)}
                        y1={0}
                        y2={GRAPH_NODE_Y}
                        className="stroke-border"
                        strokeWidth={1.5}
                      />
                    ) : null}
                    {row.node.parentOids.map((parentOid) => {
                      const parentLane = row.lanesAfter.indexOf(parentOid);
                      if (parentLane === -1) {
                        return null;
                      }
                      return (
                        <line
                          key={`${row.node.oid}-${parentOid}`}
                          x1={laneX(row.nodeLane)}
                          x2={laneX(parentLane)}
                          y1={GRAPH_NODE_Y}
                          y2={GRAPH_ROW_HEIGHT}
                          className={cn(row.node.isHead ? "stroke-primary" : "stroke-border")}
                          strokeWidth={1.5}
                        />
                      );
                    })}
                    <circle
                      cx={laneX(row.nodeLane)}
                      cy={GRAPH_NODE_Y}
                      r={row.node.isMergeCommit ? 4.5 : 4}
                      className={cn(
                        row.node.isHead
                          ? "fill-primary stroke-primary"
                          : "fill-foreground stroke-foreground",
                      )}
                      strokeWidth={1.5}
                    />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium text-sm">{row.node.subject}</span>
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
                    <span>{row.node.shortOid}</span>
                    <span>{row.node.authorName}</span>
                    <span>{formatDateTime(row.node.authoredAt)}</span>
                    {row.node.parentOids.length > 0 ? (
                      <span>
                        {row.node.parentOids.length} parent
                        {row.node.parentOids.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WorkspaceAvailabilityEmpty({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
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

function PullRequestPanel({
  workspace,
  onRefresh,
  onSubmitComment,
  onSubmitReview,
  isCommentPending,
  isReviewPending,
}: {
  workspace: GitHubWorkspaceSnapshot;
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
  }, [workspace.fetchedAt, workspace.pullRequest?.number]);

  if (workspace.availability.kind !== "available") {
    return (
      <WorkspaceAvailabilityEmpty
        title="GitHub PR Features Unavailable"
        description={workspace.availability.message}
        icon={<ShieldAlertIcon />}
      />
    );
  }

  if (!workspace.pullRequest) {
    return (
      <WorkspaceAvailabilityEmpty
        title="No Open Pull Request"
        description="The current branch does not have an open GitHub pull request."
        icon={<GitBranchIcon />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/20 p-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">#{workspace.pullRequest.number}</Badge>
            <Badge variant={workspace.pullRequest.isDraft ? "warning" : "success"}>
              {workspace.pullRequest.isDraft ? "Draft" : workspace.pullRequest.state}
            </Badge>
            {workspace.pullRequest.reviewDecision ? (
              <Badge variant="secondary">{workspace.pullRequest.reviewDecision}</Badge>
            ) : null}
          </div>
          <div className="font-semibold text-lg leading-tight">{workspace.pullRequest.title}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
            <span>
              {workspace.pullRequest.baseBranch} ← {workspace.pullRequest.headBranch}
            </span>
            {workspace.pullRequest.author ? (
              <span>@{workspace.pullRequest.author.login}</span>
            ) : null}
            <span>Updated {formatDateTime(workspace.pullRequest.updatedAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isCommentPending || isReviewPending}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
          <Button render={<a href={workspace.pullRequest.url} rel="noreferrer" target="_blank" />}>
            <ExternalLinkIcon />
            Open on GitHub
          </Button>
        </div>
      </div>

      {workspace.pullRequest.body.trim().length > 0 ? (
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-2 font-medium text-sm">Description</div>
          <pre className="whitespace-pre-wrap break-words text-sm">
            {workspace.pullRequest.body}
          </pre>
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
          {workspace.pullRequest.comments.length === 0 ? (
            <div className="text-muted-foreground text-sm">No top-level comments.</div>
          ) : (
            <div className="space-y-3">
              {workspace.pullRequest.comments.map((comment) => (
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
          {workspace.pullRequest.reviews.length === 0 ? (
            <div className="text-muted-foreground text-sm">No submitted reviews.</div>
          ) : (
            <div className="space-y-3">
              {workspace.pullRequest.reviews.map((review) => (
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
  );
}

function ChecksPanel({
  workspace,
  onRefresh,
}: {
  workspace: GitHubWorkspaceSnapshot;
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

  if (!workspace.pullRequest) {
    return (
      <WorkspaceAvailabilityEmpty
        title="No Open Pull Request"
        description="Checks and workflow runs are shown for the current branch's open pull request."
        icon={<PlayCircleIcon />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted-foreground text-sm">
          Updated {formatDateTime(workspace.fetchedAt)}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-lg border bg-background p-4">
          <div className="font-medium text-sm">PR Checks</div>
          {workspace.checks.length === 0 ? (
            <div className="text-muted-foreground text-sm">No checks reported for this PR.</div>
          ) : (
            <div className="space-y-2">
              {workspace.checks.map((check) => (
                <div
                  key={`${check.name}-${check.startedAt ?? "na"}`}
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
          {workspace.runs.length === 0 ? (
            <div className="text-muted-foreground text-sm">
              No workflow runs were found for the current PR head SHA.
            </div>
          ) : (
            <div className="space-y-3">
              {workspace.runs.map((run) => (
                <div key={run.id} className="rounded-md border bg-muted/16 p-3">
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
    </div>
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
    if (!cwd || !workspaceQuery.data?.pullRequest) {
      return;
    }
    await commentMutation.mutateAsync({
      cwd,
      number: workspaceQuery.data.pullRequest.number,
      body: body.trim(),
    });
    toastManager.add({
      type: "success",
      title: "Comment added",
      description: "The pull request comment was posted successfully.",
    });
  };

  const handleSubmitReview = async (event: GitHubPullRequestReviewEvent, body: string) => {
    if (!cwd || !workspaceQuery.data?.pullRequest) {
      return;
    }
    await reviewMutation.mutateAsync({
      cwd,
      number: workspaceQuery.data.pullRequest.number,
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
        onRefresh={() => void handleRefreshWorkspace()}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-6xl">
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
        <DialogPanel className="min-h-[34rem]">{renderTabBody()}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
