---
name: release-merge-skill
description: Reusable playbook for merging multiple active feature or plugin branches into release without closing their PRs to main.
---

# Release Merge Skill

Use this when `release` needs to absorb the current origin state of several open PR branches, while those PRs must stay open against `main`.

## Goal

Merge selected feature branches into `release` one at a time, keep the source PRs open, and leave `main` untouched.

## Guardrails

- Do not close, retarget, or merge the source PRs on GitHub.
- Do not rewrite the source branches unless explicitly requested.
- Treat `release` as the integration branch.
- Assume manual conflict resolution will be required when multiple branches touch shared IPC, WebSocket, or chat-shell surfaces.
- Before calling the work done, run:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
- Never use `bun test`; use `bun run test` only if tests are explicitly needed.

## Discovery Workflow

1. Confirm the current branch is `release` and the worktree is clean.
2. List open PRs targeting `main`.
3. Identify which PR heads are intended for the release merge.
4. Compare each PR head against `release`.
5. Separate:
   - unique feature surfaces
   - shared conflict surfaces
6. Dry-run all candidate merge orders in a temporary worktree before touching `release`.

## Useful Commands

```powershell
git status --short --branch
git branch -a --list
git log --oneline --decorate --graph --max-count=40 --all
git diff --name-only release..origin/<branch>
git diff --stat release..origin/<branch> -- <path>
git rev-list --left-right --count release...origin/<branch>
```

To simulate merge order safely:

```powershell
git worktree add --detach .tmp-merge-check release
```

Then inside the temporary worktree:

```powershell
git switch --force-create merge-sim release
git merge --no-ff --no-edit origin/<branch>
```

Abort failed simulations:

```powershell
git merge --abort
```

Remove the temporary worktree when done:

```powershell
git worktree remove --force .tmp-merge-check
```

## How To Choose Merge Order

Prefer an order that minimizes the first manual conflict set, not the order that feels most “logical”.

Heuristics:

- Put the most shared infrastructure branch in the middle if it reduces first-pass conflicts.
- Avoid merging two branches back-to-back if they both heavily rewrite the same UI shell file.
- If every order conflicts, choose the order with the smallest second-step conflict set and resolve forward on `release`.

## Current Repository Findings

For the current open plugin-style branches:

- `feature/project-actions-plan`
- `t3code/reset-feature-branch`
- `t3code/Git-Implementation`

The stable shared conflict surface is:

- `apps/server/src/ws.ts`
- `packages/contracts/src/ipc.ts`

An additional UI conflict appears when combining project-actions and database work:

- `apps/web/src/components/ChatView.tsx`

### Unique Surfaces By Branch

(Verify at the time of merging)

`feature/project-actions-plan`

- `apps/server/src/project/*`
- `apps/web/src/components/ProjectScriptsControl.tsx`
- `apps/web/src/hooks/useProjectActionRunner.ts`
- `apps/web/src/lib/projectReactQuery.ts`
- `packages/contracts/src/project.ts`

`t3code/reset-feature-branch`

- `apps/server/src/database/*`
- `apps/server/src/persistence/Migrations/026_ProjectDatabaseConnections.ts`
- `apps/web/src/components/database/*`
- `apps/web/src/lib/databaseReactQuery.ts`
- `packages/contracts/src/database.ts`

`t3code/Git-Implementation`

- `apps/server/src/git/*`
- `apps/server/src/processRunner.ts`
- `apps/web/src/components/GitActionsControl.tsx`
- `apps/web/src/components/GitRepositoryWorkspaceDialog.tsx`
- `apps/web/src/lib/gitReactQuery.ts`
- `packages/contracts/src/git.ts`
- `packages/contracts/src/github.ts`

## Recommended Order For The Current Branch Set

Use:

1. `feature/project-actions-plan`
2. `t3code/Git-Implementation`
3. `t3code/reset-feature-branch`

Reason:

- Every tested order conflicts on the second merge.
- Placing `t3code/Git-Implementation` in the middle keeps the first conflict set to:
  - `apps/server/src/ws.ts`
  - `packages/contracts/src/ipc.ts`
- This avoids introducing `apps/web/src/components/ChatView.tsx` into the first merge-resolution pass.

## Merge Procedure On release

1. Verify `release` is checked out and clean.
2. Merge the first selected branch into `release`.
3. Merge the second branch.
4. Resolve conflicts by composing behavior, not by picking one side wholesale.
5. Commit the merge resolution on `release`.
6. Merge the third branch.
7. Resolve remaining conflicts the same way.
8. Run formatting, lint, and typecheck.
9. Inspect the resulting diff and commit graph.

## Conflict Resolution Rules

For `packages/contracts/src/ipc.ts`:

- Keep all new contract imports that are still valid.
- Preserve all new API namespaces and methods.
- Ensure method names remain consistent with `apps/server/src/ws.ts` and web callers.

For `apps/server/src/ws.ts`:

- Keep all newly added RPC handlers.
- Preserve shared instrumentation and `observeRpcEffect` behavior.
- Check that every new IPC contract method has a matching server handler.
- Watch for import collisions and duplicated switch keys.

For `apps/web/src/components/ChatView.tsx`:

- Preserve layout or rendering changes needed by both features.
- Verify chat-shell state, side panels, and action controls still mount in the right order.
- Recheck imports after resolving JSX conflicts.

## Validation Checklist

- `bun fmt`
- `bun lint`
- `bun typecheck`
- Manually inspect:
  - provider session startup paths
  - WebSocket method registration
  - contract exports used by the web app
  - new sidebar/panel entry points

## Completion Criteria

The merge is complete only when:

- `release` contains the selected branch content
- the original PRs to `main` remain open
- conflicts were resolved intentionally
- `bun fmt`, `bun lint`, and `bun typecheck` all pass
