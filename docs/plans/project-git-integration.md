# Project Git Integration Plan

Status: Draft  
Branch baseline: `feature/upstream-sync-ide-expansion`  
Merged branch head: `bbfbe598`  
Merged upstream head: `9df3c640`  
Prepared: `2026-04-18`

## Purpose

This document defines the project-scoped git feature as an implementation-grade plan for the current fork. It covers the existing Git header control, stacked local git actions, repository graph visualization, GitHub PR/review/comment/check integration, and the thread/project/worktree bindings those features depend on.

This plan is intentionally GitHub-first. It should preserve narrow seams for future forge support, but it must not introduce a generic host abstraction now if that increases merge surface.

## Current State

The current feature already has the right high-level boundaries:

- Header entry point: `apps/web/src/components/GitActionsControl.tsx`
- Repository workspace UI: `apps/web/src/components/GitRepositoryWorkspaceDialog.tsx`
- Git workspace service: `apps/server/src/git/Services/GitWorkspace.ts`
- Git workspace implementation: `apps/server/src/git/Layers/GitWorkspace.ts`
- Shared contract surfaces:
  - `packages/contracts/src/git.ts`
  - `packages/contracts/src/github.ts`

Existing behavior already spans two domains:

- Local git state and actions
  - status
  - branch awareness
  - commit / push / create PR stacked actions
  - worktree-related context
  - recent graph data
- GitHub-hosted state
  - pull request metadata
  - top-level comments
  - review submission
  - checks
  - workflow runs and jobs

The feature must stay built on these seams instead of introducing a second git UI surface.

## Product Goals

- Keep the current Git control as the only persistent entry point.
- Keep local git state and GitHub workspace state unified in one feature area.
- Preserve the current stacked-action flow for commit/push/PR work.
- Provide repository graph, PR, and checks in one project-scoped workspace dialog.
- Keep GitHub integration explicit and reliable.
- Bind project git integration to as few places as possible.

## Success Criteria

- A user can do the project-scoped local git actions they already expect from the Git header control.
- A user can open one repository workspace and inspect graph, PR state, and checks.
- Graph data remains local-git-derived.
- PR/comment/review/check data remains GitHub-derived.
- GitHub unavailability is handled explicitly rather than leaking generic failures into the UI.
- Feature work remains concentrated in the Git UI and Git workspace service layers.

## Non-Goals

- No generic forge abstraction across GitHub, GitLab, and Bitbucket.
- No new top-level navigation entry point besides the Git control.
- No route-based repository workspace.
- No inline diff-hunk review comment system.
- No merge/squash/rebase UI from the repository workspace unless explicitly designed later.
- No background sync engine outside the current React query and status refresh model.

## Minimal-Surface Strategy

### Primary touch points

- `apps/web/src/components/GitActionsControl.tsx`
  - Owns the Git header interaction model.
  - Must remain the only persistent entry point.
- `apps/web/src/components/GitRepositoryWorkspaceDialog.tsx`
  - Owns the repository workspace presentation.
  - Must remain the single modal surface for graph, PR, and checks.
- `apps/server/src/git/Layers/GitWorkspace.ts`
  - Owns graph retrieval and GitHub workspace retrieval/writes.
  - Must remain the primary server seam for repository workspace data.

### Secondary touch points

- `apps/web/src/components/GitActionsControl.logic.ts`
  - Menu logic, quick-action rules, dialog copy decisions.
- `apps/web/src/components/GitRepositoryWorkspaceDialog.logic.ts`
  - Client graph rendering helpers and PR selection helpers.
- `apps/server/src/git/Layers/GitManager.ts`
  - Stacked actions and higher-level git flow orchestration.
- `apps/server/src/git/Layers/GitHubCli.ts`
  - Structured GitHub CLI execution and error normalization.
- `packages/contracts/src/git.ts`
  - Local git and graph contracts.
- `packages/contracts/src/github.ts`
  - GitHub workspace contracts.

### Explicit no-touch zones

- Provider runtime and model picker surfaces
- Orchestration domain rules unrelated to git
- Composer behavior
- Project actions feature surfaces
- Route structure
- Terminal protocol

Git integration may reference thread/worktree context, but it should not expand into those systems.

## Public Interfaces

### Local git contracts

Current `packages/contracts/src/git.ts` surface relevant to this feature:

- `GitStatusResult`
- `GitRunStackedActionInput`
- `GitRunStackedActionResult`
- `GitActionProgressEvent`
- `GitRecentGraphInput`
- `GitRecentGraphResult`
- hosting provider metadata
- branch/worktree/reference types

### GitHub workspace contracts

Current `packages/contracts/src/github.ts` surface relevant to this feature:

- `GitHubWorkspaceAvailability`
- `GitHubWorkspaceSnapshot`
- `GitHubWorkspacePullRequest`
- `GitHubPullRequestLocator`
- `GitHubCheckSummary`
- `GitHubWorkflowRun`
- `GitHubWorkflowJob`
- `GitHubPullRequestCommentInput`
- `GitHubPullRequestReviewInput`
- `GitHubWorkspaceWriteResult`

### Server service surface

Current `apps/server/src/git/Services/GitWorkspace.ts` surface:

- `getRecentGraph`
- `getGitHubWorkspace`
- `addPullRequestComment`
- `submitPullRequestReview`

This service boundary should remain the main server aggregation seam for repository workspace work.

## UX Specification

### Header control

The Git control remains in the chat header and continues to own:

- quick action resolution
- dropdown menu composition
- stacked action dialogs
- repository workspace launch

There must not be a second persistent GitHub button, repository button, or graph button.

### Quick action behavior

Quick action behavior continues to derive from current git status:

- commit when dirty
- push when ahead and eligible
- PR creation when ahead and no open PR
- PR view when an open PR exists
- disabled hint states when unavailable or blocked

The quick action should stay local-status-driven. It should not depend on loading the full repository workspace.

### Stacked action flow

The existing stacked-action path remains the default local git action flow:

- commit
- push
- create PR
- combined commit/push/PR paths

These flows stay rooted in `GitActionsControl` and `GitManager`.

### Repository workspace modal

The repository workspace remains a modal launched from the Git dropdown.

Tabs:

- `Graph`
- `Pull Request`
- `Checks`

The modal is project/repository scoped and should remain independent from route state.

### Graph tab

- Uses local git data only.
- Shows recent graph rows and refs.
- Shows worktree/branch/tag/ref badges.
- Does not require GitHub availability.
- Must remain useful even when the remote host is unsupported or unavailable.

### Pull Request tab

- GitHub-first
- Shows the currently active PR context
- Supports switching PR context when multiple PRs are returned
- Shows:
  - PR identity
  - review state
  - comments
  - reviews
  - comment composer
  - review submission controls

### Checks tab

- GitHub-first
- Shows checks, workflow runs, and jobs for the active PR context
- Polls while visible and while the window is visible
- Supports manual refresh

### GitHub availability states

The workspace must handle:

- unsupported host
- `gh` unavailable
- `gh` unauthenticated
- general GitHub workspace error

These states should be explicit UI states, not generic stack traces or silent empty panels.

## Data Flow

### Local git flow

1. `GitActionsControl` reads current git status from the existing web status path.
2. Quick action and menu state are derived locally in the web layer.
3. Stacked actions are submitted through the existing git mutation/query layer.
4. Status is refreshed after mutations.

### Graph flow

1. `GitRepositoryWorkspaceDialog` requests `gitRecentGraphQueryOptions`.
2. Web API calls `GitWorkspace.getRecentGraph`.
3. Server reads local git data and returns graph rows plus topology.
4. Client logic renders lanes, refs, and row presentation.

### GitHub workspace flow

1. `GitRepositoryWorkspaceDialog` requests `gitHubWorkspaceQueryOptions`.
2. Web API calls `GitWorkspace.getGitHubWorkspace`.
3. Server gathers:

- hosting/availability state
- discovered PR context
- PR metadata
- comments and reviews
- checks
- workflow runs/jobs

4. The dialog resolves the active PR context client-side.

### GitHub write flow

1. Comment/review actions originate in the repository workspace dialog.
2. The dialog uses dedicated mutations.
3. Server calls `GitWorkspace.addPullRequestComment` or `GitWorkspace.submitPullRequestReview`.
4. The query is invalidated/refetched and the UI updates from fresh workspace data.

## Project and Thread Binding Rules

- The Git feature is bound to the current project repository cwd.
- Thread context still matters for:
  - worktree path
  - branch state
  - status refresh targeting
  - PR/worktree thread preparation flows
- The repository workspace itself should not own route state or thread creation rules.
- `GitActionsControl` remains the binding point between thread context and repository operations.

## Error Handling and Failure Modes

- Non-repository cwd
  - show unavailable/disabled states in Git UI
- Detached HEAD
  - local actions gated appropriately
- branch behind upstream
  - push/create-PR paths gated appropriately
- no upstream remote
  - explicit push/PR disabled reasons
- unsupported host
  - graph works, GitHub tabs show explicit unsupported-host state
- `gh` missing
  - GitHub tabs show explicit remediation state
- `gh` not authenticated
  - GitHub tabs show explicit remediation state
- PR context ambiguity
  - selector chooses one active context and allows user override
- local HEAD diverges from PR head SHA
  - show explicit divergence notice
- no checks or no workflow runs
  - show empty states, not errors

## Implementation Plan

### Phase 1: Keep the entry point narrow

- All persistent user entry stays in `GitActionsControl`.
- Do not add new header controls or side panels.

### Phase 2: Preserve the service seam

- Keep repository workspace aggregation in `GitWorkspace`.
- Avoid leaking GitHub CLI logic directly into web-facing layers.

### Phase 3: Separate local and hosted data cleanly

- Local graph/status contracts remain in `git.ts`.
- Hosted PR/check contracts remain in `github.ts`.
- Do not collapse them into one over-broad contract type.

### Phase 4: Keep GitHub-first assumptions explicit

- Keep GitHub-only write behavior in the workspace tabs.
- Use availability gating to avoid pretending the feature is host-agnostic.

### Phase 5: Minimize merge surface

- Prefer extending `GitActionsControl`, `GitRepositoryWorkspaceDialog`, and `GitWorkspace`.
- Avoid touching provider, orchestration, or composer layers unless a hard dependency forces it.

## Test Plan

### Local git action tests

- quick action selection for:
  - dirty branch
  - clean ahead branch
  - clean up-to-date branch
  - open PR branch
  - behind branch
  - detached HEAD
- menu composition and disabled reasons
- stacked action request shaping
- default branch safety prompts

### Graph tests

- graph row parsing
- recent graph truncation
- ref and badge mapping
- merge row stability
- lane rendering stability
- color and continuity behavior in the dialog

### GitHub workspace tests

- supported host with `gh` available
- unsupported host
- `gh` missing
- `gh` unauthenticated
- single PR context
- multiple PR context selection
- divergence notice when local HEAD differs from PR head
- empty checks
- empty workflow runs
- populated checks and jobs

### GitHub write tests

- comment submission request shape
- review submission request shape
- workspace refresh after write
- error handling on failed writes

### Integration tests

- repository workspace opens from the Git control
- graph tab works without GitHub availability
- PR/check tabs reflect GitHub availability state correctly
- thread/worktree-bound git actions still update branch context correctly after actions

## Acceptance Criteria

- The Git header control remains the only persistent project git entry point.
- Local git actions and GitHub workspace features remain part of one coherent feature area.
- The graph view works without hosted GitHub access.
- PR/comments/reviews/checks are explicitly GitHub-scoped and availability-gated.
- The repository workspace stays modal-based and route-independent.
- The implementation remains centered on the existing Git UI and `GitWorkspace` server seam.
- `bun fmt`, `bun lint`, and `bun typecheck` pass after implementation.

## Merge-Risk Notes

- Prefer changes in:
  - `GitActionsControl`
  - `GitRepositoryWorkspaceDialog`
  - `GitWorkspace`
- Avoid broad edits in `ChatView`, provider layers, and orchestration layers.
- Treat `GitHubCli` as an adapter boundary, not a place for feature policy.
- If future host support is needed, add it behind the existing availability and workspace service seams instead of refactoring the entire feature to a generic forge model up front.
