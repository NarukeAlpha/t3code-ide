import type {
  EnvironmentId,
  GitGraphRef,
  GitRecentGraphResult,
  GitHubCheckSummary,
  GitHubPullRequestDetail,
  GitHubPullRequestFilters,
  GitHubPullRequestInboxSnapshot,
  GitHubPullRequestSummary,
  GitHubWorkflowOverview,
  GitHubWorkflowRun,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ExternalLinkIcon,
  FilterIcon,
  GitCommitIcon,
  ListFilterIcon,
  LoaderIcon,
  MessageSquareIcon,
  PlayCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  TagIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  gitAddPullRequestCommentMutationOptions,
  gitHubPullRequestDetailQueryOptions,
  gitHubPullRequestInboxQueryOptions,
  gitHubWorkflowOverviewQueryOptions,
  gitRecentGraphQueryOptions,
} from "~/lib/gitReactQuery";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
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
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
  countRecentGraphCommits,
  workspacePullRequestKey,
} from "./GitRepositoryWorkspaceDialog.logic";

type RepositoryWorkspaceTab = "graph" | "pull_requests" | "workflows";

interface GitRepositoryWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  cwd: string | null;
}

const GRAPH_CELL_WIDTH_PX = 18;
const GRAPH_ROW_HEIGHT_PX = 28;
const GRAPH_NODE_RADIUS_PX = 4.5;
const GRAPH_STROKE_WIDTH_PX = 1.75;
const GRAPH_LANE_COLORS = [
  "#2f9e44",
  "#1971c2",
  "#e8590c",
  "#ae3ec9",
  "#d6336c",
  "#099268",
  "#1098ad",
  "#f08c00",
] as const;
const DEFAULT_GRAPH_LIMIT = 300;
const MAX_GRAPH_LIMIT = 500;
const DEFAULT_PULL_REQUEST_PAGE_SIZE = 25;
const PULL_REQUEST_PAGE_SIZE_INCREMENT = 25;

const DEFAULT_PULL_REQUEST_FILTERS: GitHubPullRequestFilters = {
  search: "",
  state: "open",
  review: "any",
  author: "",
  assignee: "",
  baseBranch: "",
  headBranch: "",
  labels: [],
  draft: "any",
  sort: "updated",
};

function resolveDefaultBranchName(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value : "main";
}

function isDefaultThreadBranch(headBranch: string | null | undefined, defaultBranch: string) {
  if (!headBranch || headBranch.trim().length === 0) {
    return true;
  }
  return headBranch === defaultBranch;
}

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
  if (ref.type === "branch") {
    return ref.current ? "success" : "outline";
  }
  return (
    {
      head: "default",
      worktree: "info",
      remote: "secondary",
      tag: "warning",
    } as const
  )[ref.type];
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

function pullRequestStateVariant(input: {
  state: GitHubPullRequestSummary["state"];
  isDraft: boolean;
}) {
  if (input.isDraft) {
    return "warning";
  }
  switch (input.state) {
    case "merged":
      return "success";
    case "closed":
      return "secondary";
    case "open":
    default:
      return "outline";
  }
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

function formatReviewDecision(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizePullRequestFilterValue(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function countActivePullRequestFilters(
  filters: GitHubPullRequestFilters,
  resetFilters: GitHubPullRequestFilters,
) {
  const currentLabels = [...(filters.labels ?? [])].toSorted();
  const defaultLabels = [...(resetFilters.labels ?? [])].toSorted();

  return [
    normalizePullRequestFilterValue(filters.search) !==
      normalizePullRequestFilterValue(resetFilters.search),
    (filters.state ?? "open") !== (resetFilters.state ?? "open"),
    (filters.review ?? "any") !== (resetFilters.review ?? "any"),
    normalizePullRequestFilterValue(filters.author) !==
      normalizePullRequestFilterValue(resetFilters.author),
    normalizePullRequestFilterValue(filters.assignee) !==
      normalizePullRequestFilterValue(resetFilters.assignee),
    normalizePullRequestFilterValue(filters.baseBranch) !==
      normalizePullRequestFilterValue(resetFilters.baseBranch),
    normalizePullRequestFilterValue(filters.headBranch) !==
      normalizePullRequestFilterValue(resetFilters.headBranch),
    currentLabels.join("\u0000") !== defaultLabels.join("\u0000"),
    (filters.draft ?? "any") !== (resetFilters.draft ?? "any"),
    (filters.sort ?? "updated") !== (resetFilters.sort ?? "updated"),
  ].filter(Boolean).length;
}

function buildPullRequestFilterSummary(filters: GitHubPullRequestFilters) {
  const summary: string[] = [];
  const search = normalizePullRequestFilterValue(filters.search);
  const author = normalizePullRequestFilterValue(filters.author);
  const assignee = normalizePullRequestFilterValue(filters.assignee);
  const baseBranch = normalizePullRequestFilterValue(filters.baseBranch);
  const headBranch = normalizePullRequestFilterValue(filters.headBranch);
  const labels = filters.labels ?? [];

  if (headBranch) {
    summary.push(`Head ${headBranch}`);
  } else if (baseBranch) {
    summary.push(`Base ${baseBranch}`);
  }
  if (search) {
    summary.push(`Search ${search}`);
  }
  if (author) {
    summary.push(`Author ${author}`);
  }
  if (assignee) {
    summary.push(`Assignee ${assignee}`);
  }
  if (labels.length > 0) {
    summary.push(labels.length === 1 ? `1 label` : `${labels.length} labels`);
  }
  if ((filters.state ?? "open") !== "open") {
    summary.push(`State ${filters.state ?? "open"}`);
  }
  if ((filters.review ?? "any") !== "any") {
    summary.push(formatReviewDecision(filters.review) ?? "Review");
  }
  if ((filters.draft ?? "any") !== "any") {
    summary.push(filters.draft === "draft" ? "Draft only" : "Ready only");
  }
  if ((filters.sort ?? "updated") !== "updated") {
    summary.push(`Sort ${filters.sort ?? "updated"}`);
  }

  return summary;
}

function resolveTimelineSortValue(value: string | null | undefined) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function groupWorkflowRuns(runs: ReadonlyArray<GitHubWorkflowRun>) {
  const groups = new Map<string, GitHubWorkflowRun[]>();
  for (const run of runs) {
    const groupKey = run.workflowName ?? run.name;
    const current = groups.get(groupKey) ?? [];
    current.push(run);
    groups.set(groupKey, current);
  }

  return Array.from(groups.entries()).map(([name, workflowRuns]) => ({
    name,
    runs: workflowRuns,
  }));
}

function summarizeWorkflowBuckets(checks: ReadonlyArray<GitHubCheckSummary>) {
  return checks.reduce(
    (summary, check) => {
      switch (check.bucket) {
        case "fail":
          summary.fail += 1;
          break;
        case "pending":
          summary.pending += 1;
          break;
        case "pass":
          summary.pass += 1;
          break;
        case "cancel":
        case "skipping":
          summary.other += 1;
          break;
      }
      return summary;
    },
    { fail: 0, pending: 0, pass: 0, other: 0 },
  );
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
      {toolbar ? <div className="border-b bg-background/85 px-4 py-3">{toolbar}</div> : null}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function FilterSelect({
  ariaLabel,
  value,
  onValueChange,
  items,
}: {
  ariaLabel: string;
  value: string;
  onValueChange: (value: string | null) => void;
  items: ReadonlyArray<{ label: string; value: string }>;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onValueChange(nextValue);
        }
      }}
      items={items}
    >
      <SelectTrigger aria-label={ariaLabel} className="min-w-[8rem]" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function GitGraphRowSvg({
  row,
  maxColumns,
}: {
  row: GitRecentGraphResult["rows"][number];
  maxColumns: number;
}) {
  const columns = Math.max(maxColumns, 1);
  const width = columns * GRAPH_CELL_WIDTH_PX;
  const height = GRAPH_ROW_HEIGHT_PX;
  const midY = height / 2;
  const stroke = GRAPH_STROKE_WIDTH_PX;

  const elements: ReactNode[] = [];
  for (const cell of row.cells) {
    const cx = cell.column * GRAPH_CELL_WIDTH_PX + GRAPH_CELL_WIDTH_PX / 2;
    const color = graphLaneColor(cell.lane ?? 0);
    const key = `${row.id}-${cell.column}-${cell.glyph}`;

    switch (cell.glyph) {
      case "|":
        elements.push(
          <line
            key={key}
            x1={cx}
            y1={0}
            x2={cx}
            y2={height}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />,
        );
        break;
      case "/":
        elements.push(
          <line
            key={key}
            x1={cx + GRAPH_CELL_WIDTH_PX / 2}
            y1={0}
            x2={cx - GRAPH_CELL_WIDTH_PX / 2}
            y2={height}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />,
        );
        break;
      case "\\":
        elements.push(
          <line
            key={key}
            x1={cx - GRAPH_CELL_WIDTH_PX / 2}
            y1={0}
            x2={cx + GRAPH_CELL_WIDTH_PX / 2}
            y2={height}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />,
        );
        break;
      case "_":
      case "-":
        elements.push(
          <line
            key={key}
            x1={cx - GRAPH_CELL_WIDTH_PX / 2}
            y1={midY}
            x2={cx + GRAPH_CELL_WIDTH_PX / 2}
            y2={midY}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />,
        );
        break;
      case "*":
      case "o":
      case "O": {
        const hasParent = (row.commit?.parentOids.length ?? 0) > 0;
        elements.push(
          <line
            key={`${key}-up`}
            x1={cx}
            y1={0}
            x2={cx}
            y2={midY}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />,
        );
        if (hasParent) {
          elements.push(
            <line
              key={`${key}-down`}
              x1={cx}
              y1={midY}
              x2={cx}
              y2={height}
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
            />,
          );
        }
        elements.push(
          <circle
            key={`${key}-node`}
            cx={cx}
            cy={midY}
            r={GRAPH_NODE_RADIUS_PX}
            fill={color}
            stroke="var(--background)"
            strokeWidth={1.25}
          />,
        );
        break;
      }
      default:
        break;
    }
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block" }}
    >
      {elements}
    </svg>
  );
}

function GitGraphPanel({
  graph,
  selectedCommitOid,
  onSelectedCommitOidChange,
  isRefreshing,
  onRefresh,
  canLoadOlder,
  onLoadOlder,
}: {
  graph: GitRecentGraphResult;
  selectedCommitOid: string | null;
  onSelectedCommitOidChange: (oid: string) => void;
  isRefreshing: boolean;
  onRefresh: () => void;
  canLoadOlder: boolean;
  onLoadOlder: () => void;
}) {
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
  const selectedCommit =
    graph.rows.find((row) => row.commit?.oid === selectedCommitOid)?.commit ??
    graph.rows.find((row) => row.commit !== null)?.commit ??
    null;

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
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
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
              <Badge variant="outline" size="sm">
                {commitCount} commits
              </Badge>
              {graph.truncated ? (
                <Badge variant="warning" size="sm">
                  Showing the recent slice
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {canLoadOlder ? (
                <Button size="sm" variant="outline" onClick={onLoadOlder}>
                  Load older commits
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onRefresh}>
                {isRefreshing ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
                Refresh
              </Button>
            </div>
          </div>
          {selectedCommit ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{selectedCommit.subject}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                  <span>{selectedCommit.authorName}</span>
                  <span>{formatDateTime(selectedCommit.authoredAt)}</span>
                  <span>{selectedCommit.parentOids.length} parent(s)</span>
                </div>
              </div>
              <Badge variant="outline">{shortSha(selectedCommit.oid)}</Badge>
            </div>
          ) : null}
        </div>
      }
    >
      <div className="h-full overflow-auto px-4 py-4">
        <div className="min-w-[56rem]">
          {graph.rows.map((row) => {
            const refs = row.commit ? (refsByOid.get(row.commit.oid) ?? []) : [];
            const isSelected = row.commit?.oid === selectedCommit?.oid;

            return (
              <div
                key={row.id}
                className={`grid items-stretch gap-3 rounded-md px-2 ${
                  row.commit ? "cursor-pointer hover:bg-muted/24" : ""
                } ${isSelected ? "bg-muted/36 ring-1 ring-border" : ""}`}
                onClick={() => {
                  if (row.commit) {
                    onSelectedCommitOidChange(row.commit.oid);
                  }
                }}
                style={{ gridTemplateColumns: `${graphPrefixWidth}px minmax(0,1fr)` }}
              >
                <GitGraphRowSvg row={row} maxColumns={graph.maxColumns} />
                {row.commit ? (
                  <div
                    className="flex min-w-0 flex-col justify-center"
                    style={{ minHeight: `${GRAPH_ROW_HEIGHT_PX}px` }}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium text-sm">{row.commit.subject}</span>
                      {refs.map((ref) => (
                        <Badge key={ref.id} size="sm" variant={gitRefBadgeVariant(ref)}>
                          {ref.label}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                      <span>{row.commit.shortOid}</span>
                      <span>{row.commit.authorName}</span>
                      <span>{formatDateTime(row.commit.authoredAt)}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ minHeight: `${GRAPH_ROW_HEIGHT_PX}px` }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </RepositoryWorkspaceTabShell>
  );
}

function PullRequestFiltersToolbar({
  filters,
  resetFilters,
  labelOptions,
  onFiltersChange,
  onRefresh,
  isRefreshing,
}: {
  filters: GitHubPullRequestFilters;
  resetFilters: GitHubPullRequestFilters;
  labelOptions: ReadonlyArray<{
    id: string;
    name: string;
    color: string;
  }>;
  onFiltersChange: (patch: Partial<GitHubPullRequestFilters>) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  const selectedLabels = filters.labels ?? [];
  const [isFiltersDialogOpen, setIsFiltersDialogOpen] = useState(false);
  const activeFilterCount = useMemo(
    () => countActivePullRequestFilters(filters, resetFilters),
    [filters, resetFilters],
  );
  const summary = useMemo(() => buildPullRequestFilterSummary(filters), [filters]);
  const toggleLabel = (labelName: string) => {
    const checked = selectedLabels.includes(labelName);
    const nextLabels = checked
      ? selectedLabels.filter((selectedLabel) => selectedLabel !== labelName)
      : [...selectedLabels, labelName];
    onFiltersChange({ labels: nextLabels });
  };

  return (
    <>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <FilterIcon className="size-4" />
              Pull request scope
            </div>
            {summary.length === 0 ? (
              <Badge variant="outline" size="sm">
                Default scope
              </Badge>
            ) : (
              summary.map((item) => (
                <Badge key={item} variant="outline" size="sm">
                  {item}
                </Badge>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRefresh}>
              {isRefreshing ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={() => setIsFiltersDialogOpen(true)}>
              <ListFilterIcon />
              Filters
              {activeFilterCount > 0 ? (
                <Badge className="ml-1" variant="secondary" size="sm">
                  {activeFilterCount}
                </Badge>
              ) : null}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onFiltersChange({ ...resetFilters })}>
              Reset filters
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={isFiltersDialogOpen} onOpenChange={setIsFiltersDialogOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Pull Request Filters</DialogTitle>
            <DialogDescription>
              Adjust the repository inbox scope without changing the surrounding workspace layout.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="max-h-[70vh]">
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="font-medium text-sm">Search</div>
                  <Input
                    placeholder="Search title or #number"
                    size="sm"
                    type="search"
                    value={filters.search ?? ""}
                    onChange={(event) => onFiltersChange({ search: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">State</div>
                  <FilterSelect
                    ariaLabel="Pull request state"
                    value={filters.state ?? "open"}
                    onValueChange={(value) =>
                      onFiltersChange({
                        state: value as NonNullable<GitHubPullRequestFilters["state"]>,
                      })
                    }
                    items={[
                      { label: "Open", value: "open" },
                      { label: "Closed", value: "closed" },
                      { label: "Merged", value: "merged" },
                      { label: "All", value: "all" },
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Review</div>
                  <FilterSelect
                    ariaLabel="Pull request review"
                    value={filters.review ?? "any"}
                    onValueChange={(value) =>
                      onFiltersChange({
                        review: value as NonNullable<GitHubPullRequestFilters["review"]>,
                      })
                    }
                    items={[
                      { label: "Any Review", value: "any" },
                      { label: "Review Required", value: "review_required" },
                      { label: "Approved", value: "approved" },
                      { label: "Changes Requested", value: "changes_requested" },
                      { label: "Commented", value: "commented" },
                      { label: "No Decision", value: "no_decision" },
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Draft State</div>
                  <FilterSelect
                    ariaLabel="Pull request draft state"
                    value={filters.draft ?? "any"}
                    onValueChange={(value) =>
                      onFiltersChange({
                        draft: value as NonNullable<GitHubPullRequestFilters["draft"]>,
                      })
                    }
                    items={[
                      { label: "Any Draft State", value: "any" },
                      { label: "Draft", value: "draft" },
                      { label: "Ready", value: "ready" },
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Sort</div>
                  <FilterSelect
                    ariaLabel="Pull request sort"
                    value={filters.sort ?? "updated"}
                    onValueChange={(value) =>
                      onFiltersChange({
                        sort: value as NonNullable<GitHubPullRequestFilters["sort"]>,
                      })
                    }
                    items={[
                      { label: "Updated", value: "updated" },
                      { label: "Created", value: "created" },
                      { label: "Number", value: "number" },
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Author</div>
                  <Input
                    placeholder="Author"
                    size="sm"
                    value={filters.author ?? ""}
                    onChange={(event) => onFiltersChange({ author: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Assignee</div>
                  <Input
                    placeholder="Assignee"
                    size="sm"
                    value={filters.assignee ?? ""}
                    onChange={(event) => onFiltersChange({ assignee: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Base Branch</div>
                  <Input
                    placeholder="Base branch"
                    size="sm"
                    value={filters.baseBranch ?? ""}
                    onChange={(event) => onFiltersChange({ baseBranch: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <div className="font-medium text-sm">Head Branch</div>
                  <Input
                    placeholder="Head branch"
                    size="sm"
                    value={filters.headBranch ?? ""}
                    onChange={(event) => onFiltersChange({ headBranch: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <TagIcon className="size-4 text-muted-foreground" />
                  Labels
                </div>
                {labelOptions.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-3 py-4 text-muted-foreground text-sm">
                    No labels found for this repository.
                  </div>
                ) : (
                  <ScrollArea className="max-h-48 rounded-lg border bg-muted/10" scrollbarGutter>
                    <div className="flex flex-wrap gap-2 p-3">
                      {labelOptions.map((label) => {
                        const checked = selectedLabels.includes(label.name);
                        return (
                          <Button
                            key={label.id}
                            size="sm"
                            variant={checked ? "secondary" : "outline"}
                            onClick={() => toggleLabel(label.name)}
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: `#${label.color}` }}
                            />
                            {label.name}
                          </Button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onFiltersChange({ ...resetFilters })}
            >
              Reset filters
            </Button>
            <Button size="sm" onClick={() => setIsFiltersDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function PullRequestInboxList({
  pullRequests,
  selectedPullRequest,
  onSelectPullRequest,
  onLoadMore,
  hasMore,
}: {
  pullRequests: ReadonlyArray<GitHubPullRequestSummary>;
  selectedPullRequest: GitHubPullRequestSummary | null;
  onSelectPullRequest: (pullRequest: GitHubPullRequestSummary) => void;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-r bg-background">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ListFilterIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">Pull Requests</span>
          <Badge variant="outline">{pullRequests.length}</Badge>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollbarGutter>
        {pullRequests.length === 0 ? (
          <div className="p-4 text-muted-foreground text-sm">
            No pull requests match the current filters.
          </div>
        ) : (
          <div className="divide-y">
            {pullRequests.map((pullRequest) => {
              const isSelected =
                selectedPullRequest &&
                workspacePullRequestKey(selectedPullRequest) ===
                  workspacePullRequestKey(pullRequest);

              return (
                <button
                  key={workspacePullRequestKey(pullRequest)}
                  className={`flex w-full flex-col items-start gap-2 px-4 py-3 text-left ${
                    isSelected ? "bg-muted/36" : "hover:bg-muted/20"
                  }`}
                  type="button"
                  onClick={() => onSelectPullRequest(pullRequest)}
                >
                  <div className="flex w-full flex-wrap items-center gap-2">
                    <Badge variant="outline">{pullRequest.repository}</Badge>
                    <Badge variant="secondary">#{pullRequest.number}</Badge>
                    <Badge
                      variant={pullRequestStateVariant({
                        state: pullRequest.state,
                        isDraft: pullRequest.isDraft,
                      })}
                    >
                      {pullRequest.isDraft ? "Draft" : pullRequest.state}
                    </Badge>
                    {formatReviewDecision(pullRequest.reviewDecision) ? (
                      <Badge variant="secondary">
                        {formatReviewDecision(pullRequest.reviewDecision)}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="line-clamp-2 font-medium text-sm leading-5">
                    {pullRequest.title}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                    {pullRequest.author ? <span>@{pullRequest.author.login}</span> : null}
                    <span>
                      {pullRequest.baseBranch}
                      {" <- "}
                      {pullRequest.headBranch}
                    </span>
                    <span>Updated {formatDateTime(pullRequest.updatedAt)}</span>
                  </div>
                  {pullRequest.labels.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {pullRequest.labels.slice(0, 3).map((label) => (
                        <Badge key={label.id} variant="outline" size="sm">
                          {label.name}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
      {hasMore ? (
        <div className="border-t px-4 py-3">
          <Button className="w-full" size="sm" variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PullRequestDetailPane({
  pullRequest,
  detailState,
  onSubmitComment,
  isCommentPending,
}: {
  pullRequest: GitHubPullRequestSummary | null;
  detailState:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: GitHubPullRequestDetail };
  onSubmitComment: (body: string) => Promise<void>;
  isCommentPending: boolean;
}) {
  const [commentBody, setCommentBody] = useState("");

  useEffect(() => {
    setCommentBody("");
  }, [pullRequest?.repository, pullRequest?.number]);

  if (!pullRequest) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <WorkspaceAvailabilityEmpty
          title="No Pull Request Selected"
          description="Pick a pull request from the inbox to inspect details and add comments."
          icon={<SearchIcon />}
        />
      </div>
    );
  }

  if (detailState.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <WorkspaceAvailabilityEmpty
          title="Loading Pull Request"
          description={`Fetching ${pullRequest.repository}#${pullRequest.number}.`}
          icon={<LoaderIcon className="animate-spin" />}
        />
      </div>
    );
  }

  if (detailState.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <WorkspaceAvailabilityEmpty
          title="Unable To Load Pull Request"
          description={detailState.message}
          icon={<AlertCircleIcon />}
        />
      </div>
    );
  }

  if (detailState.kind !== "ready") {
    return null;
  }

  const detail = detailState.detail.pullRequest;
  const timeline = [
    {
      id: `description-${detail.repository}-${detail.number}`,
      kind: "description" as const,
      label: "Description",
      author: detail.author,
      body: detail.body,
      url: detail.url,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    },
    ...detail.comments.map((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment" as const,
      label: "Comment",
      author: comment.author,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    ...detail.reviews.map((review) => ({
      id: `review-${review.id}`,
      kind: "review" as const,
      label: formatReviewDecision(review.state) ?? "Review",
      author: review.author,
      body: review.body,
      url: review.url,
      createdAt: review.submittedAt ?? detail.updatedAt,
      updatedAt: review.submittedAt,
      state: review.state,
    })),
  ].toSorted(
    (left, right) =>
      resolveTimelineSortValue(left.createdAt) - resolveTimelineSortValue(right.createdAt),
  );

  return (
    <ScrollArea className="h-full" scrollbarGutter>
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-background p-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{detail.repository}</Badge>
              <Badge variant="secondary">#{detail.number}</Badge>
              <Badge
                variant={pullRequestStateVariant({
                  state: detail.state,
                  isDraft: detail.isDraft,
                })}
              >
                {detail.isDraft ? "Draft" : detail.state}
              </Badge>
              {formatReviewDecision(detail.reviewDecision) ? (
                <Badge variant="secondary">{formatReviewDecision(detail.reviewDecision)}</Badge>
              ) : null}
            </div>
            <div className="font-semibold text-lg leading-tight">{detail.title}</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
              <span>
                {detail.baseBranch}
                {" <- "}
                {detail.headBranch}
              </span>
              {detail.author ? <span>@{detail.author.login}</span> : null}
              <span>Updated {formatDateTime(detail.updatedAt)}</span>
              <Badge variant="outline">{shortSha(detail.headSha)}</Badge>
            </div>
          </div>
          <Button render={<a href={detail.url} rel="noreferrer" target="_blank" />}>
            <ExternalLinkIcon />
            Open on GitHub
          </Button>
        </div>

        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 font-medium text-sm">Timeline</div>
          <div className="relative space-y-4 pl-6 before:absolute before:top-0 before:left-[0.4375rem] before:h-full before:w-px before:bg-border">
            {timeline.map((entry) => (
              <div key={entry.id} className="relative">
                <span className="absolute top-5 -left-6 inline-flex size-3 rounded-full border bg-background" />
                <div className="rounded-lg border bg-muted/16 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" size="sm">
                      {entry.author ? `@${entry.author.login}` : "Unknown author"}
                    </Badge>
                    <Badge
                      variant={
                        entry.kind === "review"
                          ? "secondary"
                          : entry.kind === "description"
                            ? "outline"
                            : "info"
                      }
                      size="sm"
                    >
                      {entry.label}
                    </Badge>
                    <span className="text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
                    <a
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      href={entry.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </div>
                  {entry.body.trim().length > 0 ? (
                    <pre className="whitespace-pre-wrap break-words text-sm">{entry.body}</pre>
                  ) : entry.kind === "description" ? (
                    <div className="text-muted-foreground text-sm">No description provided.</div>
                  ) : (
                    <div className="text-muted-foreground text-sm">No message provided.</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

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
      </div>
    </ScrollArea>
  );
}

function PullRequestsPanel({
  isLoading,
  error,
  inbox,
  pullRequestFilters,
  resetFilters,
  selectedPullRequest,
  detailState,
  onFiltersChange,
  onRefresh,
  onLoadMore,
  onSelectPullRequest,
  onSubmitComment,
  isCommentPending,
  isRefreshing,
}: {
  isLoading: boolean;
  error: Error | null;
  inbox: GitHubPullRequestInboxSnapshot | undefined;
  pullRequestFilters: GitHubPullRequestFilters;
  resetFilters: GitHubPullRequestFilters;
  selectedPullRequest: GitHubPullRequestSummary | null;
  detailState:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: GitHubPullRequestDetail };
  onFiltersChange: (patch: Partial<GitHubPullRequestFilters>) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelectPullRequest: (pullRequest: GitHubPullRequestSummary) => void;
  onSubmitComment: (body: string) => Promise<void>;
  isCommentPending: boolean;
  isRefreshing: boolean;
}) {
  const labelOptions = inbox?.labels ?? [];

  if (isLoading) {
    return (
      <WorkspaceAvailabilityEmpty
        title="Loading Pull Requests"
        description="Fetching the repository pull request inbox."
        icon={<LoaderIcon className="animate-spin" />}
      />
    );
  }

  if (error) {
    return (
      <WorkspaceAvailabilityEmpty
        title="Unable To Load Pull Requests"
        description={error.message}
        icon={<AlertCircleIcon />}
      />
    );
  }

  if (!inbox) {
    return null;
  }

  if (inbox.availability.kind !== "available") {
    return (
      <WorkspaceAvailabilityEmpty
        title={
          inbox.availability.kind === "gh_unavailable"
            ? "gh cli not detected"
            : "GitHub Pull Requests Unavailable"
        }
        description={inbox.availability.message}
        icon={<ShieldAlertIcon />}
      />
    );
  }

  return (
    <RepositoryWorkspaceTabShell
      toolbar={
        <PullRequestFiltersToolbar
          filters={pullRequestFilters}
          resetFilters={resetFilters}
          labelOptions={labelOptions}
          onFiltersChange={onFiltersChange}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
        />
      }
    >
      <div className="grid h-full min-h-0 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <PullRequestInboxList
          pullRequests={inbox.pullRequests}
          selectedPullRequest={selectedPullRequest}
          onSelectPullRequest={onSelectPullRequest}
          onLoadMore={onLoadMore}
          hasMore={inbox.nextCursor !== null}
        />
        <PullRequestDetailPane
          pullRequest={selectedPullRequest}
          detailState={detailState}
          onSubmitComment={onSubmitComment}
          isCommentPending={isCommentPending}
        />
      </div>
    </RepositoryWorkspaceTabShell>
  );
}

function WorkflowSummaryBadges({ workflow }: { workflow: GitHubWorkflowOverview }) {
  const summary = summarizeWorkflowBuckets(workflow.checks);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="destructive">Failing {summary.fail}</Badge>
      <Badge variant="info">Pending {summary.pending}</Badge>
      <Badge variant="success">Passing {summary.pass}</Badge>
      <Badge variant="secondary">Other {summary.other}</Badge>
    </div>
  );
}

function WorkflowsPanel({
  workflow,
  isLoading,
  error,
  isRefreshing,
  hasSelectedPullRequest,
  onRefresh,
  onClearSelection,
}: {
  workflow: GitHubWorkflowOverview | undefined;
  isLoading: boolean;
  error: Error | null;
  isRefreshing: boolean;
  hasSelectedPullRequest: boolean;
  onRefresh: () => void;
  onClearSelection: () => void;
}) {
  if (isLoading) {
    return (
      <WorkspaceAvailabilityEmpty
        title="Loading Workflows"
        description="Resolving the current workflow target and its checks."
        icon={<LoaderIcon className="animate-spin" />}
      />
    );
  }

  if (error) {
    return (
      <WorkspaceAvailabilityEmpty
        title="Unable To Load Workflows"
        description={error.message}
        icon={<AlertCircleIcon />}
      />
    );
  }

  if (!workflow) {
    return null;
  }

  if (workflow.availability.kind !== "available") {
    return (
      <WorkspaceAvailabilityEmpty
        title={
          workflow.availability.kind === "gh_unavailable"
            ? "gh cli not detected"
            : "GitHub Workflows Unavailable"
        }
        description={workflow.availability.message}
        icon={<ShieldAlertIcon />}
      />
    );
  }

  if (!workflow.resolvedSha && workflow.unavailableReason) {
    return (
      <WorkspaceAvailabilityEmpty
        title="Workflow Target Unavailable"
        description={workflow.unavailableReason}
        icon={<PlayCircleIcon />}
      />
    );
  }

  const groupedRuns = groupWorkflowRuns(workflow.runs);

  return (
    <RepositoryWorkspaceTabShell
      toolbar={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{workflow.targetLabel}</Badge>
              {workflow.repository ? (
                <Badge variant="secondary">{workflow.repository}</Badge>
              ) : null}
              {workflow.resolvedSha ? (
                <Badge variant="outline">{shortSha(workflow.resolvedSha)}</Badge>
              ) : null}
              {workflow.isStale ? <Badge variant="warning">Stale local ref</Badge> : null}
              <span className="text-muted-foreground text-sm">
                Updated {formatDateTime(workflow.fetchedAt)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {hasSelectedPullRequest ? (
                <Button size="sm" variant="ghost" onClick={onClearSelection}>
                  Clear PR selection
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onRefresh}>
                {isRefreshing ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
                Refresh
              </Button>
            </div>
          </div>
          <WorkflowSummaryBadges workflow={workflow} />
        </div>
      }
    >
      <div className="grid h-full min-h-0 gap-4 px-4 py-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ScrollArea className="min-h-0 rounded-lg border bg-background" scrollbarGutter>
          <div className="space-y-3 p-4">
            <div className="font-medium text-sm">Checks</div>
            {workflow.checks.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                No checks were reported for this target.
              </div>
            ) : (
              <div className="space-y-2">
                {workflow.checks.map((check) => (
                  <div
                    key={`${check.name}-${check.completedAt ?? check.startedAt ?? "na"}`}
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
        </ScrollArea>

        <ScrollArea className="min-h-0 rounded-lg border bg-background" scrollbarGutter>
          <div className="space-y-3 p-4">
            <div className="font-medium text-sm">Workflow Runs</div>
            {groupedRuns.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                No workflow runs were found for this target SHA.
              </div>
            ) : (
              <div className="space-y-4">
                {groupedRuns.map((group) => (
                  <div key={group.name} className="space-y-3">
                    <div className="font-medium text-sm">{group.name}</div>
                    {group.runs.map((run) => (
                      <div key={run.id} className="rounded-md border bg-muted/16 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={workflowStateVariant(run)} size="sm">
                                {run.conclusion ?? run.status}
                              </Badge>
                              <span className="font-medium text-sm">{run.name}</span>
                              {run.attempt ? (
                                <span className="text-muted-foreground text-xs">
                                  Attempt {run.attempt}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                              <span>{run.event}</span>
                              {run.headBranch ? <span>{run.headBranch}</span> : null}
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
                            <div className="text-muted-foreground text-xs">
                              No job details returned.
                            </div>
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
                                    {job.startedAt ? (
                                      <span>{formatDateTime(job.startedAt)}</span>
                                    ) : null}
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
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
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
  const [graphLimit, setGraphLimit] = useState(DEFAULT_GRAPH_LIMIT);
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(null);
  const [pullRequestFilters, setPullRequestFilters] = useState<GitHubPullRequestFilters>({
    ...DEFAULT_PULL_REQUEST_FILTERS,
  });
  const [pullRequestPageSize, setPullRequestPageSize] = useState(DEFAULT_PULL_REQUEST_PAGE_SIZE);
  const [selectedPullRequest, setSelectedPullRequest] = useState<GitHubPullRequestSummary | null>(
    null,
  );
  const [hasAppliedInitialBranchScope, setHasAppliedInitialBranchScope] = useState(false);
  const [hasAutoSelectedBranchPullRequest, setHasAutoSelectedBranchPullRequest] = useState(false);
  const [isGhCliDialogOpen, setIsGhCliDialogOpen] = useState(false);
  const [isWindowVisible, setIsWindowVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const pullRequestLabelsDependency = useMemo(
    () => JSON.stringify(pullRequestFilters.labels ?? []),
    [pullRequestFilters.labels],
  );

  useEffect(() => {
    if (open) {
      setActiveTab("graph");
      setGraphLimit(DEFAULT_GRAPH_LIMIT);
      setSelectedCommitOid(null);
      setPullRequestFilters({ ...DEFAULT_PULL_REQUEST_FILTERS });
      setPullRequestPageSize(DEFAULT_PULL_REQUEST_PAGE_SIZE);
      setSelectedPullRequest(null);
      setHasAppliedInitialBranchScope(false);
      setHasAutoSelectedBranchPullRequest(false);
    }
  }, [open]);

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

  useEffect(() => {
    setPullRequestPageSize(DEFAULT_PULL_REQUEST_PAGE_SIZE);
  }, [
    pullRequestFilters.search,
    pullRequestFilters.state,
    pullRequestFilters.review,
    pullRequestFilters.author,
    pullRequestFilters.assignee,
    pullRequestFilters.baseBranch,
    pullRequestFilters.headBranch,
    pullRequestFilters.draft,
    pullRequestFilters.sort,
    pullRequestLabelsDependency,
  ]);

  const graphQuery = useQuery({
    ...gitRecentGraphQueryOptions({
      environmentId,
      cwd,
      limit: graphLimit,
      enabled: open,
    }),
  });

  const threadDefaultBranch = resolveDefaultBranchName(graphQuery.data?.topology.defaultBranch);
  const threadHeadBranch = graphQuery.data?.topology.headBranch ?? null;
  const threadUsesDefaultBranch = isDefaultThreadBranch(threadHeadBranch, threadDefaultBranch);
  const resetPullRequestFilters = useMemo(
    () =>
      threadUsesDefaultBranch
        ? {
            ...DEFAULT_PULL_REQUEST_FILTERS,
            baseBranch: threadDefaultBranch,
          }
        : {
            ...DEFAULT_PULL_REQUEST_FILTERS,
            headBranch: threadHeadBranch ?? "",
          },
    [threadDefaultBranch, threadHeadBranch, threadUsesDefaultBranch],
  );

  useEffect(() => {
    if (!open || hasAppliedInitialBranchScope) {
      return;
    }
    if (!graphQuery.data && !graphQuery.error) {
      return;
    }

    if (graphQuery.data) {
      setPullRequestFilters(resetPullRequestFilters);
    }

    setHasAppliedInitialBranchScope(true);
  }, [
    graphQuery.data,
    graphQuery.error,
    hasAppliedInitialBranchScope,
    open,
    resetPullRequestFilters,
  ]);

  useEffect(() => {
    if (!graphQuery.data) {
      return;
    }
    const nextSelectedCommit =
      graphQuery.data.rows.find((row) => row.commit?.oid === selectedCommitOid)?.commit ??
      graphQuery.data.rows.find((row) => row.commit !== null)?.commit ??
      null;
    if (nextSelectedCommit && nextSelectedCommit.oid !== selectedCommitOid) {
      setSelectedCommitOid(nextSelectedCommit.oid);
    }
  }, [graphQuery.data, selectedCommitOid]);

  const pullRequestInboxQuery = useQuery({
    ...gitHubPullRequestInboxQueryOptions({
      environmentId,
      cwd,
      filters: pullRequestFilters,
      pageSize: pullRequestPageSize,
      enabled: open && activeTab === "pull_requests" && hasAppliedInitialBranchScope,
    }),
  });

  useEffect(() => {
    if (!selectedPullRequest || !pullRequestInboxQuery.data) {
      return;
    }
    const refreshedSelection = pullRequestInboxQuery.data.pullRequests.find(
      (pullRequest) =>
        workspacePullRequestKey(pullRequest) === workspacePullRequestKey(selectedPullRequest),
    );
    if (!refreshedSelection) {
      setSelectedPullRequest(null);
      return;
    }
    if (
      refreshedSelection.repository !== selectedPullRequest.repository ||
      refreshedSelection.number !== selectedPullRequest.number ||
      refreshedSelection.updatedAt !== selectedPullRequest.updatedAt
    ) {
      setSelectedPullRequest(refreshedSelection);
    }
  }, [pullRequestInboxQuery.data, selectedPullRequest]);

  useEffect(() => {
    if (
      activeTab !== "pull_requests" ||
      threadUsesDefaultBranch ||
      selectedPullRequest !== null ||
      hasAutoSelectedBranchPullRequest ||
      !pullRequestInboxQuery.data
    ) {
      return;
    }

    const [firstPullRequest] = pullRequestInboxQuery.data.pullRequests;
    if (firstPullRequest) {
      setSelectedPullRequest(firstPullRequest);
    }
    setHasAutoSelectedBranchPullRequest(true);
  }, [
    activeTab,
    hasAutoSelectedBranchPullRequest,
    pullRequestInboxQuery.data,
    selectedPullRequest,
    threadUsesDefaultBranch,
  ]);

  const pullRequestDetailQuery = useQuery({
    ...gitHubPullRequestDetailQueryOptions({
      environmentId,
      cwd,
      repository: selectedPullRequest?.repository ?? null,
      number: selectedPullRequest?.number ?? null,
      enabled: open && activeTab === "pull_requests" && selectedPullRequest !== null,
    }),
  });

  const workflowTarget = useMemo(
    () =>
      selectedPullRequest
        ? {
            kind: "pull_request" as const,
            repository: selectedPullRequest.repository,
            number: selectedPullRequest.number,
          }
        : {
            kind: "remote_ref" as const,
            remoteName: "origin",
            branch: threadUsesDefaultBranch ? threadDefaultBranch : (threadHeadBranch ?? "main"),
          },
    [selectedPullRequest, threadDefaultBranch, threadHeadBranch, threadUsesDefaultBranch],
  );

  const workflowOverviewQuery = useQuery({
    ...gitHubWorkflowOverviewQueryOptions({
      environmentId,
      cwd,
      target: workflowTarget,
      enabled: open && activeTab === "workflows" && hasAppliedInitialBranchScope,
      refetchInterval: open && activeTab === "workflows" && isWindowVisible ? 15_000 : false,
    }),
  });

  const commentMutation = useMutation(
    gitAddPullRequestCommentMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );

  const ghCliUnavailableMessage = useMemo(() => {
    if (activeTab === "pull_requests") {
      return pullRequestInboxQuery.data?.availability.kind === "gh_unavailable"
        ? pullRequestInboxQuery.data.availability.message
        : null;
    }
    if (activeTab === "workflows") {
      return workflowOverviewQuery.data?.availability.kind === "gh_unavailable"
        ? workflowOverviewQuery.data.availability.message
        : null;
    }
    return null;
  }, [
    activeTab,
    pullRequestInboxQuery.data?.availability.kind,
    pullRequestInboxQuery.data?.availability.message,
    workflowOverviewQuery.data?.availability.kind,
    workflowOverviewQuery.data?.availability.message,
  ]);

  useEffect(() => {
    if (!open || !ghCliUnavailableMessage) {
      setIsGhCliDialogOpen(false);
      return;
    }
    setIsGhCliDialogOpen(true);
  }, [ghCliUnavailableMessage, open]);

  const detailState = useMemo(() => {
    if (!selectedPullRequest) {
      return { kind: "idle" } as const;
    }
    if (pullRequestDetailQuery.isLoading) {
      return { kind: "loading" } as const;
    }
    if (pullRequestDetailQuery.error) {
      return { kind: "error", message: pullRequestDetailQuery.error.message } as const;
    }
    if (!pullRequestDetailQuery.data) {
      return { kind: "loading" } as const;
    }
    return { kind: "ready", detail: pullRequestDetailQuery.data } as const;
  }, [
    pullRequestDetailQuery.data,
    pullRequestDetailQuery.error,
    pullRequestDetailQuery.isLoading,
    selectedPullRequest,
  ]);

  const handlePullRequestFiltersChange = (patch: Partial<GitHubPullRequestFilters>) => {
    setPullRequestFilters((current) => ({
      ...current,
      ...patch,
    }));
  };

  const handleSubmitComment = async (body: string) => {
    if (!cwd || !selectedPullRequest) {
      return;
    }
    await commentMutation.mutateAsync({
      cwd,
      repository: selectedPullRequest.repository,
      number: selectedPullRequest.number,
      body: body.trim(),
    });
    toastManager.add({
      type: "success",
      title: "Comment added",
      description: "The pull request comment was posted successfully.",
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
      return (
        <GitGraphPanel
          graph={graphQuery.data}
          selectedCommitOid={selectedCommitOid}
          onSelectedCommitOidChange={setSelectedCommitOid}
          isRefreshing={graphQuery.isFetching}
          onRefresh={() => void graphQuery.refetch()}
          canLoadOlder={graphQuery.data.truncated && graphLimit < MAX_GRAPH_LIMIT}
          onLoadOlder={() => setGraphLimit(MAX_GRAPH_LIMIT)}
        />
      );
    }

    if (activeTab === "pull_requests") {
      if (!hasAppliedInitialBranchScope) {
        return (
          <WorkspaceAvailabilityEmpty
            title="Loading Pull Requests"
            description="Resolving the current thread branch before loading pull requests."
            icon={<LoaderIcon className="animate-spin" />}
          />
        );
      }
      return (
        <PullRequestsPanel
          isLoading={pullRequestInboxQuery.isLoading}
          error={pullRequestInboxQuery.error}
          inbox={pullRequestInboxQuery.data}
          pullRequestFilters={pullRequestFilters}
          resetFilters={resetPullRequestFilters}
          selectedPullRequest={selectedPullRequest}
          detailState={detailState}
          onFiltersChange={handlePullRequestFiltersChange}
          onRefresh={() => void pullRequestInboxQuery.refetch()}
          onLoadMore={() =>
            setPullRequestPageSize((current) => current + PULL_REQUEST_PAGE_SIZE_INCREMENT)
          }
          onSelectPullRequest={setSelectedPullRequest}
          onSubmitComment={handleSubmitComment}
          isCommentPending={commentMutation.isPending}
          isRefreshing={pullRequestInboxQuery.isFetching}
        />
      );
    }

    if (!hasAppliedInitialBranchScope) {
      return (
        <WorkspaceAvailabilityEmpty
          title="Loading Workflows"
          description="Resolving the current thread branch before loading workflows."
          icon={<LoaderIcon className="animate-spin" />}
        />
      );
    }

    return (
      <WorkflowsPanel
        workflow={workflowOverviewQuery.data}
        isLoading={workflowOverviewQuery.isLoading}
        error={workflowOverviewQuery.error}
        isRefreshing={workflowOverviewQuery.isFetching}
        hasSelectedPullRequest={selectedPullRequest !== null}
        onRefresh={() => void workflowOverviewQuery.refetch()}
        onClearSelection={() => {
          setSelectedPullRequest(null);
          setHasAutoSelectedBranchPullRequest(true);
        }}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-h-[84vh] max-w-7xl">
        <DialogHeader className="pb-4">
          <DialogTitle>Repository Workspace</DialogTitle>
          <DialogDescription>
            Explore the local graph, work through the repository PR inbox, and monitor workflows
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
            <ToggleGroupItem value="pull_requests">Pull Requests</ToggleGroupItem>
            <ToggleGroupItem value="workflows">Workflows</ToggleGroupItem>
          </ToggleGroup>
        </DialogHeader>
        <DialogPanel className="h-[70vh] min-h-[40rem] overflow-hidden" scrollFade={false}>
          {renderTabBody()}
        </DialogPanel>
      </DialogPopup>

      <Dialog open={isGhCliDialogOpen} onOpenChange={setIsGhCliDialogOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>gh cli not detected</DialogTitle>
            <DialogDescription>
              {ghCliUnavailableMessage ??
                "Install GitHub CLI and make sure `gh` is available on PATH to use pull requests and workflows."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter variant="bare">
            <Button size="sm" onClick={() => setIsGhCliDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Dialog>
  );
}
