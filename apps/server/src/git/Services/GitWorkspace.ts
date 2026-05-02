import { Context } from "effect";
import type { Effect } from "effect";

import type {
  GitCommandError,
  GitHubPullRequestCommentInput,
  GitHubPullRequestDetail,
  GitHubPullRequestDetailInput,
  GitHubPullRequestInboxInput,
  GitHubPullRequestInboxSnapshot,
  GitHubPullRequestReviewInput,
  GitHubWorkflowOverview,
  GitHubWorkflowOverviewInput,
  GitHubWorkspaceError,
  GitHubWorkspaceInput,
  GitHubWorkspaceSnapshot,
  GitHubWorkspaceWriteResult,
  GitRecentGraphInput,
  GitRecentGraphResult,
} from "@t3tools/contracts";

export interface GitWorkspaceShape {
  readonly getRecentGraph: (
    input: GitRecentGraphInput,
  ) => Effect.Effect<GitRecentGraphResult, GitCommandError>;
  readonly getGitHubWorkspace: (
    input: GitHubWorkspaceInput,
  ) => Effect.Effect<GitHubWorkspaceSnapshot, GitHubWorkspaceError>;
  readonly getPullRequestInbox: (
    input: GitHubPullRequestInboxInput,
  ) => Effect.Effect<GitHubPullRequestInboxSnapshot, GitHubWorkspaceError>;
  readonly getPullRequestDetail: (
    input: GitHubPullRequestDetailInput,
  ) => Effect.Effect<GitHubPullRequestDetail, GitHubWorkspaceError>;
  readonly getWorkflowOverview: (
    input: GitHubWorkflowOverviewInput,
  ) => Effect.Effect<GitHubWorkflowOverview, GitHubWorkspaceError>;
  readonly addPullRequestComment: (
    input: GitHubPullRequestCommentInput,
  ) => Effect.Effect<GitHubWorkspaceWriteResult, GitHubWorkspaceError>;
  readonly submitPullRequestReview: (
    input: GitHubPullRequestReviewInput,
  ) => Effect.Effect<GitHubWorkspaceWriteResult, GitHubWorkspaceError>;
}

export class GitWorkspace extends Context.Service<GitWorkspace, GitWorkspaceShape>()(
  "t3/git/Services/GitWorkspace",
) {}
