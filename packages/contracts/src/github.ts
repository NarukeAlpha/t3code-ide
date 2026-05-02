import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitHostingProvider } from "./git.ts";

export const GitHubWorkspaceAvailabilityKind = Schema.Literals([
  "available",
  "unsupported_host",
  "gh_unavailable",
  "gh_unauthenticated",
  "error",
]);
export type GitHubWorkspaceAvailabilityKind = typeof GitHubWorkspaceAvailabilityKind.Type;

export const GitHubWorkspaceAvailability = Schema.Struct({
  kind: GitHubWorkspaceAvailabilityKind,
  message: TrimmedNonEmptyString,
  hostingProvider: Schema.optional(GitHostingProvider),
});
export type GitHubWorkspaceAvailability = typeof GitHubWorkspaceAvailability.Type;

export const GitHubActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  avatarUrl: Schema.optional(Schema.String),
});
export type GitHubActor = typeof GitHubActor.Type;

export const GitHubReviewState = Schema.Literals([
  "commented",
  "approved",
  "changes_requested",
  "dismissed",
  "pending",
]);
export type GitHubReviewState = typeof GitHubReviewState.Type;

export const GitHubPullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: Schema.String,
  author: Schema.NullOr(GitHubActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitHubPullRequestComment = typeof GitHubPullRequestComment.Type;

export const GitHubPullRequestReview = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: Schema.String,
  author: Schema.NullOr(GitHubActor),
  state: GitHubReviewState,
  body: Schema.String,
  submittedAt: Schema.NullOr(IsoDateTime),
});
export type GitHubPullRequestReview = typeof GitHubPullRequestReview.Type;

const GitHubPullRequestSnapshotShape = {
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  body: Schema.String,
  author: Schema.NullOr(GitHubActor),
  reviewDecision: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  comments: Schema.Array(GitHubPullRequestComment),
  reviews: Schema.Array(GitHubPullRequestReview),
} as const;

export const GitHubPullRequestSnapshot = Schema.Struct(GitHubPullRequestSnapshotShape);
export type GitHubPullRequestSnapshot = typeof GitHubPullRequestSnapshot.Type;

export const GitHubPullRequestLocator = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type GitHubPullRequestLocator = typeof GitHubPullRequestLocator.Type;

export const GitHubCheckBucket = Schema.Literals(["pass", "fail", "pending", "skipping", "cancel"]);
export type GitHubCheckBucket = typeof GitHubCheckBucket.Type;

export const GitHubCheckSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  workflow: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  event: Schema.optional(TrimmedNonEmptyString),
  link: Schema.optional(Schema.String),
  state: TrimmedNonEmptyString,
  bucket: GitHubCheckBucket,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GitHubCheckSummary = typeof GitHubCheckSummary.Type;

export const GitHubWorkflowJob = Schema.Struct({
  id: NonNegativeInt,
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  conclusion: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  url: Schema.String,
});
export type GitHubWorkflowJob = typeof GitHubWorkflowJob.Type;

export const GitHubWorkflowRun = Schema.Struct({
  id: NonNegativeInt,
  name: TrimmedNonEmptyString,
  workflowName: Schema.NullOr(TrimmedNonEmptyString),
  event: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  conclusion: Schema.NullOr(TrimmedNonEmptyString),
  headBranch: Schema.NullOr(TrimmedNonEmptyString),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  attempt: Schema.optional(NonNegativeInt),
  url: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  jobs: Schema.Array(GitHubWorkflowJob),
});
export type GitHubWorkflowRun = typeof GitHubWorkflowRun.Type;

export const GitHubWorkspaceInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitHubWorkspaceInput = typeof GitHubWorkspaceInput.Type;

export const GitHubPullRequestInboxState = Schema.Literals(["open", "closed", "merged", "all"]);
export type GitHubPullRequestInboxState = typeof GitHubPullRequestInboxState.Type;

export const GitHubPullRequestReviewFilter = Schema.Literals([
  "any",
  "review_required",
  "approved",
  "changes_requested",
  "commented",
  "no_decision",
]);
export type GitHubPullRequestReviewFilter = typeof GitHubPullRequestReviewFilter.Type;

export const GitHubPullRequestDraftFilter = Schema.Literals(["any", "draft", "ready"]);
export type GitHubPullRequestDraftFilter = typeof GitHubPullRequestDraftFilter.Type;

export const GitHubPullRequestSort = Schema.Literals(["updated", "created", "number"]);
export type GitHubPullRequestSort = typeof GitHubPullRequestSort.Type;

export const GitHubRepositoryLabel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
});
export type GitHubRepositoryLabel = typeof GitHubRepositoryLabel.Type;

export const GitHubPullRequestFilters = Schema.Struct({
  search: Schema.optional(Schema.String),
  state: Schema.optional(GitHubPullRequestInboxState),
  review: Schema.optional(GitHubPullRequestReviewFilter),
  author: Schema.optional(Schema.String),
  assignee: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  draft: Schema.optional(GitHubPullRequestDraftFilter),
  sort: Schema.optional(GitHubPullRequestSort),
});
export type GitHubPullRequestFilters = typeof GitHubPullRequestFilters.Type;

export const GitHubPullRequestSummary = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  author: Schema.NullOr(GitHubActor),
  reviewDecision: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  labels: Schema.Array(GitHubRepositoryLabel),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GitHubPullRequestSummary = typeof GitHubPullRequestSummary.Type;

export const GitHubPullRequestInboxInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  filters: Schema.optional(GitHubPullRequestFilters),
  cursor: Schema.optional(TrimmedNonEmptyString),
  pageSize: Schema.optional(PositiveInt),
});
export type GitHubPullRequestInboxInput = typeof GitHubPullRequestInboxInput.Type;

export const GitHubPullRequestInboxSnapshot = Schema.Struct({
  availability: GitHubWorkspaceAvailability,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  labels: Schema.Array(GitHubRepositoryLabel),
  pullRequests: Schema.Array(GitHubPullRequestSummary),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  appliedFilters: GitHubPullRequestFilters,
  fetchedAt: IsoDateTime,
});
export type GitHubPullRequestInboxSnapshot = typeof GitHubPullRequestInboxSnapshot.Type;

export const GitHubPullRequestDetailInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type GitHubPullRequestDetailInput = typeof GitHubPullRequestDetailInput.Type;

export const GitHubPullRequestDetail = Schema.Struct({
  pullRequest: GitHubPullRequestSnapshot,
  fetchedAt: IsoDateTime,
});
export type GitHubPullRequestDetail = typeof GitHubPullRequestDetail.Type;

export const GitHubWorkspacePullRequest = Schema.Struct({
  ...GitHubPullRequestSnapshotShape,
  checks: Schema.Array(GitHubCheckSummary),
  runs: Schema.Array(GitHubWorkflowRun),
});
export type GitHubWorkspacePullRequest = typeof GitHubWorkspacePullRequest.Type;

export const GitHubWorkspaceSnapshot = Schema.Struct({
  availability: GitHubWorkspaceAvailability,
  pullRequests: Schema.Array(GitHubWorkspacePullRequest),
  activePullRequest: Schema.NullOr(GitHubPullRequestLocator),
  fetchedAt: IsoDateTime,
});
export type GitHubWorkspaceSnapshot = typeof GitHubWorkspaceSnapshot.Type;

export const GitHubWorkflowTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("remote_ref"),
    remoteName: TrimmedNonEmptyString,
    branch: TrimmedNonEmptyString,
  }),
]);
export type GitHubWorkflowTarget = typeof GitHubWorkflowTarget.Type;

export const GitHubWorkflowOverviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  target: GitHubWorkflowTarget,
});
export type GitHubWorkflowOverviewInput = typeof GitHubWorkflowOverviewInput.Type;

export const GitHubWorkflowOverview = Schema.Struct({
  availability: GitHubWorkspaceAvailability,
  target: GitHubWorkflowTarget,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  targetLabel: TrimmedNonEmptyString,
  resolvedSha: Schema.NullOr(TrimmedNonEmptyString),
  isStale: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  checks: Schema.Array(GitHubCheckSummary),
  runs: Schema.Array(GitHubWorkflowRun),
  fetchedAt: IsoDateTime,
});
export type GitHubWorkflowOverview = typeof GitHubWorkflowOverview.Type;

export const GitHubPullRequestCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  body: TrimmedNonEmptyString,
});
export type GitHubPullRequestCommentInput = typeof GitHubPullRequestCommentInput.Type;

export const GitHubPullRequestReviewEvent = Schema.Literals([
  "approve",
  "request_changes",
  "comment",
]);
export type GitHubPullRequestReviewEvent = typeof GitHubPullRequestReviewEvent.Type;

export const GitHubPullRequestReviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  event: GitHubPullRequestReviewEvent,
  body: Schema.optional(Schema.String),
});
export type GitHubPullRequestReviewInput = typeof GitHubPullRequestReviewInput.Type;

export const GitHubWorkspaceWriteResult = Schema.Struct({
  updatedAt: IsoDateTime,
});
export type GitHubWorkspaceWriteResult = typeof GitHubWorkspaceWriteResult.Type;

export class GitHubWorkspaceError extends Schema.TaggedErrorClass<GitHubWorkspaceError>()(
  "GitHubWorkspaceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `GitHub workspace failed in ${this.operation}: ${this.detail}`;
  }
}
