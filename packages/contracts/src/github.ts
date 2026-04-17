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

export const GitHubPullRequestSnapshot = Schema.Struct({
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
});
export type GitHubPullRequestSnapshot = typeof GitHubPullRequestSnapshot.Type;

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

export const GitHubWorkspaceSnapshot = Schema.Struct({
  availability: GitHubWorkspaceAvailability,
  pullRequest: Schema.NullOr(GitHubPullRequestSnapshot),
  checks: Schema.Array(GitHubCheckSummary),
  runs: Schema.Array(GitHubWorkflowRun),
  fetchedAt: IsoDateTime,
});
export type GitHubWorkspaceSnapshot = typeof GitHubWorkspaceSnapshot.Type;

export const GitHubPullRequestCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
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
