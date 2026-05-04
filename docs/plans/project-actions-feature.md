# Project Actions Feature Plan

Status: Draft  
Branch baseline: `feature/upstream-sync-ide-expansion`  
Merged branch head: `bbfbe598`  
Merged upstream head: `9df3c640`  
Prepared: `2026-04-18`

## Purpose

This document defines the project actions feature as an implementation-grade plan for the current fork. It covers saved actions, detected default actions, package manifest integration, project-language defaults, keybindings, and terminal execution. The design goal is to extend the existing action system with the smallest possible merge surface so future upstream rebases and merges stay tractable.

The feature must remain centered on the current Actions control in the chat header. It must not introduce a parallel runner system, a separate route, or a second persistence model.

## Current State

The current implementation already has the correct high-level seam layout:

- Header entry point: `apps/web/src/components/ProjectScriptsControl.tsx`
- Runtime execution: `apps/web/src/hooks/useProjectActionRunner.ts`
- Detected defaults: `apps/server/src/project/Layers/ProjectDetectedScriptCatalog.ts`
- Web query wrapper: `apps/web/src/lib/projectReactQuery.ts`
- Shared contract surface: `packages/contracts/src/project.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/ipc.ts`

The current behavior baseline is:

- `Add action` and `Package Scripts` are separate user actions.
- Saved actions still use the persisted `ProjectScript` model.
- Detected entries are read-only source-derived rows that can be run directly.
- `Save as action` promotes a detected row into the normal saved action form with prefilled values.
- JS/TS package scripts come from `package.json`.
- Additional root-level defaults currently exist for Zig, Gradle, Go, Rust, and .NET.
- Action execution goes through the thread terminal system and reuses or creates terminals based on current thread terminal state.

## Product Goals

- Keep a single project action system.
- Keep the current header Actions surface as the only persistent entry point.
- Keep `Add action` and `Package Scripts` as clearly separate concerns.
- Allow projects to expose useful default actions without requiring user configuration.
- Preserve existing saved-action behavior, including keybindings and worktree-creation actions.
- Make detected actions promotion cheap and obvious.
- Bind feature work to as few files and contracts as possible.

## Success Criteria

- A project can expose saved actions and detected actions through the same header control.
- The Actions surface behaves deterministically based on project state.
- Detected rows are stable, source-labeled, and root-scoped.
- Running a detected action uses the same terminal execution semantics as running a saved action.
- Promoting a detected action into a saved action preserves the current saved-action UX.
- Changes are concentrated in the existing actions UI, one runtime hook, one detector service, and the existing contracts.

## Non-Goals

- No new route or sidebar for actions.
- No second persistence model besides `ProjectScript`.
- No generalized task-runner platform beyond the current actions feature.
- No background task orchestration, task history UI, or task cancellation protocol.
- No remote service registry for action providers.
- No expansion into workspace-global actions or environment-global actions.

## Minimal-Surface Strategy

### Primary touch points

- `apps/web/src/components/ProjectScriptsControl.tsx`
  - Owns all actions UI behavior.
  - Must remain the only persistent action entry point.
- `apps/web/src/hooks/useProjectActionRunner.ts`
  - Owns terminal targeting, terminal creation policy, and runtime env injection.
  - Must remain the only shared execution path for saved and detected actions.
- `apps/server/src/project/Layers/ProjectDetectedScriptCatalog.ts`
  - Owns source detection, ordering, warning emission, and cache invalidation.
  - Must remain the only server detector for project-derived default actions.

### Secondary touch points

- `apps/web/src/lib/projectReactQuery.ts`
  - Query wrapper only. No feature logic beyond API wiring and copy.
- `packages/contracts/src/project.ts`
  - Shared detector row shape and result shape.
- `packages/contracts/src/rpc.ts`
  - Existing `projects.listDetectedScripts` method mapping.
- `packages/contracts/src/ipc.ts`
  - Existing `projects.listDetectedScripts` API exposure.
- `apps/web/src/components/ChatView.tsx`
  - Only to wire detected action execution into the shared action runner.

### Explicit no-touch zones

- Provider runtime and provider settings
- Orchestration engine and projection model
- Route structure
- Terminal protocol contract
- Git feature surfaces
- Global environment connection settings

These areas should only be touched if a concrete bug forces it. They are not part of the core actions feature surface.

## Public Interfaces

### Shared contracts

Current contract surface in `packages/contracts/src/project.ts`:

- `DetectedProjectScriptSource`
  - `package_json`
  - `zig`
  - `gradle`
  - `go`
  - `rust`
  - `dotnet`
- `DetectedProjectScript`
  - `id`
  - `source`
  - `displayName`
  - `badgeLabel`
  - `detail`
  - `command`
  - `originPath`
- `ListDetectedProjectScriptsInput`
  - `cwd`
- `ListDetectedProjectScriptsResult`
  - `scripts`
  - `warnings`

### RPC and web API

- `projects.listDetectedScripts`
  - Declared in `packages/contracts/src/rpc.ts`
  - Exposed to the browser in `packages/contracts/src/ipc.ts`
  - Consumed from `apps/web/src/environmentApi.ts`

No new RPC group should be introduced for this feature. All detected project defaults must remain under the existing project RPC namespace.

## UX Specification

### Header behavior

The action control remains the header surface rendered by `ChatHeader`.

Behavior must stay:

- If saved actions exist:
  - Primary button runs the preferred action.
  - Dropdown lists saved actions first.
  - Dropdown then exposes `Package Scripts…` if detected rows exist.
  - Dropdown always exposes `Add action`.
- If no saved actions exist but detected rows exist:
  - Show a single `Actions` menu button.
  - Menu contains `Package Scripts…` and `Add action`.
- If neither saved nor detected actions exist:
  - Show only `Add action`.

### Add action flow

- `Add action` opens only the saved action form.
- The saved action form continues to own:
  - name
  - command
  - icon
  - optional keybinding
  - `runOnWorktreeCreate`
- Editing an existing saved action reuses the same form.

### Package Scripts flow

- `Package Scripts…` opens only the detected action modal.
- The modal title stays `Package Scripts`.
- This label remains even though non-JS project defaults are included.
- The modal must show:
  - row title from `displayName`
  - source badge from `badgeLabel`
  - secondary detail text from `detail`
  - command preview
  - `Run`
  - `Save as action`
- The modal keeps the current bounded scroll behavior so large detection lists do not stretch the dialog.

### Save as action flow

- `Save as action` closes the detected-actions modal and reopens the saved-action form.
- The reopened form must be the normal saved-action form, not an inline edit state.
- Prefill rules:
  - `command` = detected row `command`
  - `icon` = `play`
  - `runOnWorktreeCreate` = `false`
  - `keybinding` = empty
  - `name`:
    - `package_json` uses the row `displayName`
    - all non-`package_json` rows use `${badgeLabel} ${displayName}`

### Keybinding behavior

- Saved actions continue to own keybindings.
- Detected rows do not get direct keybindings.
- A detected row only becomes keybindable after promotion into a saved action.

### Terminal execution behavior

The only runtime path is `useProjectActionRunner`.

Execution rules:

- If the active thread has an idle terminal, reuse it.
- If the active terminal is busy, create a new terminal tab.
- Use the thread-specific terminal drawer state as the source of truth.
- Use `projectScriptRuntimeEnv` for runtime env injection.
- Preserve worktree-aware execution behavior.
- Continue to remember the last invoked saved action by project when applicable.
- Detected rows never become the “last invoked saved action” directly.

## Detection Specification

### Detection scope

- Root-only
- Read-only
- Environment-backed
- Server-side only

The browser must never parse manifests or probe the filesystem directly for this feature.

### Ordering

Returned rows must remain stable and deterministic:

1. `package.json` scripts in manifest order
2. Zig defaults
3. Gradle defaults
4. Go defaults
5. Rust defaults
6. .NET defaults

### Current root markers

- `package.json`
- `build.zig`
- `gradlew`
- `build.gradle`
- `build.gradle.kts`
- `go.mod`
- `Cargo.toml`
- `.cargo/config.toml`
- root `*.sln`
- root `*.csproj`

### Current default commands

- JS/TS package scripts
  - all scripts within `package.json`
- Zig
  - `zig build`
- Gradle
  - `./gradlew build` or `gradle build`
  - `./gradlew test` or `gradle test`
- Go
  - `go build`
  - `go run .`
  - `go test`
- Rust
  - `cargo build`
  - `cargo test`
- .NET
  - `dotnet build`
  - `dotnet test`
  - `dotnet msbuild`

### Warning rules

Warnings are non-blocking informational rows rendered in the modal.

Examples:

- `package.json` parse failure
- invalid `scripts` shape
- non-string script values skipped

Warnings must never prevent non-JS defaults from being returned.

### Caching and invalidation

The detector cache is keyed by `cwd` and a filesystem-derived signature.

The signature must include:

- root marker stats
- lockfile stats
- relevant `.sln` / `.csproj` root entries

Cache invalidation must stay server-side and cheap. No browser-managed detection cache should be introduced.

## Data Flow

### Browser

1. `ProjectScriptsControl` requests detected rows through `projectDetectedScriptsQueryOptions`.
2. The web query calls `environmentApi.projects.listDetectedScripts`.
3. The UI renders saved actions and detected rows separately.
4. `Run` delegates to the detected action callback from `ChatView`.
5. `Save as action` transitions into the saved action form.

### Server

1. The project RPC handler receives `cwd`.
2. `ProjectDetectedScriptCatalog.list` performs root detection and returns rows plus warnings.
3. The result is validated by the shared schema before reaching the browser.

### Persistence

- Saved actions continue to persist through the existing `ProjectScript` path.
- Detected rows are not persisted.
- Promotion creates a normal saved action using the existing persistence path.

## Edge Cases and Failure Modes

- Missing environment or missing project cwd
  - Query disabled or returns the current unavailable error.
- Invalid `package.json`
  - Warning shown.
  - Other supported default rows still appear.
- Empty detection result
  - Show the empty state in the Package Scripts dialog.
- Nested project markers only
  - Must not produce detected rows.
- Busy current terminal
  - New terminal is created.
- Detached or worktree-backed thread context
  - Execution still resolves cwd and runtime env from the current thread/project context.
- Duplicate-looking saved action names
  - Non-JS promotion prefixes the name to reduce collisions.

## Implementation Plan

### Phase 1: Detection core

- Keep all detection logic in `ProjectDetectedScriptCatalog`.
- Keep the detector generic and row-shaped.
- Do not move detection logic into the web layer.

### Phase 2: Actions UI

- Keep all action-surface branching in `ProjectScriptsControl`.
- Keep `Add action` and `Package Scripts` fully separate.
- Keep the label `Package Scripts`.

### Phase 3: Execution path

- Route all execution through `useProjectActionRunner`.
- Avoid any per-source execution path branching in the UI.

### Phase 4: Persistence and promotion

- Promotion must keep using the existing saved action flow.
- Do not introduce a second draft model or special-case persistence API.

## Test Plan

### Server detection tests

- package manager precedence:
  - `packageManager` field
  - lockfile fallback
  - `npm` fallback
- package manifest ordering preserved
- root-only marker handling
- Gradle wrapper-first behavior
- invalid `package.json` still allows non-JS defaults
- `.cargo/config.toml` root detection
- `.sln` / `.csproj` prioritization
- cache reuse and cache invalidation
- BigInt-safe stat signature handling

### Web behavior tests

- header menu composition for:
  - saved only
  - detected only
  - both
  - neither
- `Add action` opens only the saved action form
- `Package Scripts` opens only the detected modal
- `Save as action` closes detected modal and reopens the saved action form
- source-prefixed prefill naming for non-`package_json` rows
- source badges and detail text render correctly
- package modal stays scroll-bounded

### Runtime tests

- saved action execution reuses idle terminal
- detected action execution reuses idle terminal
- busy terminal causes new terminal creation
- runtime env includes project/worktree values
- saved action invocation updates last-invoked tracking
- detected action invocation does not directly overwrite saved-action preference

## Acceptance Criteria

- The Actions header surface remains the single source of truth for project actions.
- Users can distinguish saved actions from detected rows by entry point and modal behavior.
- Detected rows are stable, source-labeled, and non-editable.
- Promotion to saved action is fast and preserves the current saved-action UX.
- All detection is server-side and root-scoped.
- No additional persistence model, route, or RPC namespace is introduced.
- `bun fmt`, `bun lint`, and `bun typecheck` pass after implementation.

## Merge-Risk Notes

- Keep feature logic concentrated in the three primary touch points.
- Prefer adapters and helpers over expanding `ChatView`.
- Do not move detection or execution logic into provider, orchestration, or route layers.
- If future work needs more ecosystems, add them in `ProjectDetectedScriptCatalog` first before touching UI behavior.
- If the label ever changes from `Package Scripts`, treat it as separate UI copy work, not as a detector or persistence refactor.
