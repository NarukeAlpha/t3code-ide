# JetBrains Analysis Panel

## Summary

Add a project/worktree-scoped Analysis panel to T3 Code that can detect and run JetBrains analysis tooling on command.

The feature is focused entirely on JetBrains tooling:

- Qodana CLI
- IntelliJ/JetBrains IDE command-line inspections via `inspect.sh`
- Rider/ReSharper command-line inspections via `InspectCode`

Package-manager vulnerability commands such as Bun, npm, pnpm, or OSV are intentionally out of scope unless they are surfaced through a JetBrains tool.

## Product Goals

- Let users run JetBrains code analysis against the repository they are actively working on in T3 Code.
- Prefer the active thread worktree as the analysis target, falling back to the project root when no worktree exists.
- Show only analysis tools that are currently runnable for the active target.
- Run analysis as structured jobs, not as raw terminal writes.
- Persist per-project run history and findings.
- Keep generated result artifacts out of tracked repository changes.

## UI Placement

Add an Analysis button to the chat header near the existing Terminal and Diff controls.

The button opens a right-side Analysis panel using the same responsive behavior as the current diff panel:

- Inline right sidebar on wider screens.
- Right sheet on narrower screens.
- Route/search state controls whether the panel is open.

The panel should contain:

- A detected tool list.
- The latest run state.
- Per-project/worktree run history.
- Finding summaries grouped by severity and tool.
- A detail view for the selected run.
- Artifact links for raw logs, SARIF, JSON, or HTML reports.

The first version should not overload the existing Project Actions menu. Project Actions are useful for saved terminal-backed commands, while this feature needs tool detection, structured job state, persisted findings, and report parsing.

## Route State

Generalize the existing right-panel route state from a diff-specific shape to a panel selector.

Recommended search shape:

```ts
{
  panel?: "diff" | "analysis";
  diffTurnId?: TurnId;
  diffFilePath?: string;
  analysisRunId?: AnalysisRunId;
}
```

Compatibility:

- Continue accepting `diff=1` during migration.
- When opening Diff, write `panel=diff`.
- When opening Analysis, write `panel=analysis`.
- Strip panel-specific params when switching panels.

## Contracts

Add `packages/contracts/src/analysis.ts`.

### Tool Types

```ts
type AnalysisToolKind = "qodana" | "jetbrains-ide-inspect" | "rider-inspectcode";

type AnalysisToolAvailability = "available" | "unavailable";

interface AnalysisTool {
  id: string;
  kind: AnalysisToolKind;
  label: string;
  availability: AnalysisToolAvailability;
  executablePath: string | null;
  version: string | null;
  targetCwd: string;
  commandPreview: string | null;
  unavailableReason?: string;
}
```

The UI should normally render only `available` tools. The server may still return unavailable tools for diagnostics or an optional empty state.

### Run Types

```ts
type AnalysisRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface AnalysisRun {
  id: AnalysisRunId;
  projectId: ProjectId;
  threadId: ThreadId | null;
  toolId: string;
  toolKind: AnalysisToolKind;
  targetCwd: string;
  status: AnalysisRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  summary: AnalysisRunSummary | null;
}

interface AnalysisRunSummary {
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findingCount: number;
}
```

### Finding Types

```ts
type AnalysisFindingSeverity = "error" | "warning" | "info" | "weak-warning" | "unknown";

interface AnalysisFinding {
  id: string;
  runId: AnalysisRunId;
  severity: AnalysisFindingSeverity;
  ruleId: string | null;
  ruleName: string | null;
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  helpUrl: string | null;
  fingerprint: string;
}
```

### Artifact Types

```ts
type AnalysisArtifactKind = "sarif" | "json" | "html" | "log" | "raw";

interface AnalysisArtifact {
  id: string;
  runId: AnalysisRunId;
  kind: AnalysisArtifactKind;
  path: string;
  label: string;
}
```

## RPC API

Add environment-scoped RPC methods:

- `analysis.listTools`
- `analysis.listRuns`
- `analysis.startRun`
- `analysis.cancelRun`
- `analysis.subscribe`

Suggested payloads:

```ts
interface AnalysisTargetInput {
  projectId: ProjectId;
  threadId?: ThreadId;
  projectCwd: string;
  worktreePath?: string | null;
}

interface AnalysisListToolsInput extends AnalysisTargetInput {}

interface AnalysisListRunsInput {
  projectId: ProjectId;
  targetCwd?: string;
  limit?: number;
}

interface AnalysisStartRunInput extends AnalysisTargetInput {
  toolId: string;
}

interface AnalysisCancelRunInput {
  runId: AnalysisRunId;
}
```

Add these methods to `EnvironmentApi` so local and remote environments both run analysis in the environment that owns the project.

## Server Architecture

Add a new server service:

```ts
ProjectAnalysisService;
```

Responsibilities:

- Resolve the effective target cwd.
- Detect JetBrains tools for that target.
- Start, stream, cancel, and persist runs.
- Parse known result formats into normalized findings.
- Persist artifacts under an ignored analysis directory.

Recommended modules:

- `apps/server/src/analysis/Services/ProjectAnalysisService.ts`
- `apps/server/src/analysis/Layers/ProjectAnalysisService.ts`
- `apps/server/src/analysis/toolDetection.ts`
- `apps/server/src/analysis/commands.ts`
- `apps/server/src/analysis/parsers.ts`
- `apps/server/src/analysis/artifacts.ts`

## Target Resolution

For every run:

1. Use `thread.worktreePath` when present.
2. Otherwise use the project root.
3. Pass the canonical project root separately for metadata and artifact organization.

This keeps analysis aligned with what the agent and user are currently editing.

## Tool Detection

Detection should be target-aware and environment-aware.

### Qodana

Available when:

- `qodana` is on `PATH`.
- The active target looks analyzable by Qodana.

Detection details:

- Prefer repo `qodana.yaml` / `qodana.yml` when present.
- Otherwise infer a likely linter from project files.
- Do not require Docker up front because Qodana can run in different modes, but capture Docker availability as diagnostic metadata.
- If `QODANA_TOKEN` is missing, show only configurations that can run without it. Do not show paid/cloud-only features as runnable.

Command shape:

```sh
qodana scan \
  --project-dir <targetCwd> \
  --results-dir <artifactRoot>/qodana/results \
  --report-dir <artifactRoot>/qodana/report \
  --cache-dir <artifactRoot>/qodana/cache \
  --print-problems
```

### IntelliJ/JetBrains IDE Inspect

Available when:

- A JetBrains IDE `inspect.sh` is found.
- A usable inspection profile exists or the project profile can be used with `-e`.

Detection locations:

- ToolBox-generated IDE app paths on macOS.
- Standard JetBrains app bundle paths.
- Explicit future setting/env override, for example `T3CODE_JETBRAINS_INSPECT_PATH`.

Command shape:

```sh
<inspect.sh> <targetCwd> <profile> <artifactRoot>/idea-inspect -format json -v0
```

If the IDE refuses to run because another instance is active, treat the tool as unavailable for the current refresh and show the reason in diagnostics.

### Rider InspectCode

Available when:

- The target contains exactly one clear `.sln`, or the user/project config identifies one.
- `jb inspectcode`, `InspectCode`, or another configured InspectCode executable is available.

Command shape:

```sh
jb inspectcode <solution.sln> -o=<artifactRoot>/rider-inspectcode.sarif.json
```

If multiple `.sln` files exist, mark Rider as unavailable until a solution selector/config is added.

## Running Jobs

Runs should use `spawn`, not PTY-backed terminals.

Job behavior:

- Stream stdout/stderr into the analysis subscription.
- Persist bounded logs to the artifact directory.
- Capture exit code and signal.
- Support cancellation by killing the process tree.
- Parse result files after process exit.
- Mark a run as `failed` when the tool invocation fails or result parsing fails.
- Mark a run as `completed` with findings when the tool exits successfully.

Use a per-target concurrency limit:

- One active analysis run per target cwd.
- Starting a second run should either reject with a structured error or require explicit cancellation of the first run.

## Artifact Storage

Store generated files under the analyzed checkout:

```txt
<targetCwd>/.t3code/jetbrains-analysis/<runId>/
```

Expected contents:

- `stdout.log`
- `stderr.log`
- tool-native report files
- normalized findings JSON
- optional HTML report

Ignore artifacts by adding this entry to the target repository's Git ignore mechanism:

```gitignore
.t3code/jetbrains-analysis/
```

Preferred implementation:

- If `<targetCwd>` is inside a Git worktree, add the entry to `.git/info/exclude` for that worktree.
- Do not modify the target repository's tracked `.gitignore` without an explicit later product decision.
- If the target is not a Git repo, still write artifacts under `.t3code/jetbrains-analysis/`.

## Persistence

Persist run metadata and normalized findings in the T3 Code server database.

Add migrations:

- `analysis_runs`
- `analysis_findings`
- `analysis_artifacts`

Suggested `analysis_runs` columns:

- `run_id`
- `project_id`
- `thread_id`
- `tool_id`
- `tool_kind`
- `target_cwd`
- `artifact_root`
- `status`
- `command_json`
- `started_at`
- `completed_at`
- `exit_code`
- `error_message`
- `summary_json`

Suggested `analysis_findings` columns:

- `finding_id`
- `run_id`
- `severity`
- `rule_id`
- `rule_name`
- `message`
- `file_path`
- `line`
- `column`
- `end_line`
- `end_column`
- `help_url`
- `fingerprint`
- `raw_json`

Suggested `analysis_artifacts` columns:

- `artifact_id`
- `run_id`
- `kind`
- `path`
- `label`

Retention:

- Keep the latest 20 runs per project by default.
- Delete database rows and artifact directories for older runs.
- Never delete user files outside `.t3code/jetbrains-analysis/`.

## Result Parsing

Normalize findings from:

- SARIF for Qodana when available.
- Qodana JSON/result files when SARIF is not available.
- IntelliJ inspection JSON output.
- Rider InspectCode SARIF or XML/JSON output, depending on the actual CLI output format used.

Parser behavior:

- Preserve tool-native raw issue payload in `raw_json`.
- Generate stable fingerprints from tool kind, rule id, file path, range, and message.
- Store file paths relative to target cwd when possible.
- Keep parser failures visible as run errors with artifact links to raw output.

## Analysis Panel UI Details

Header:

- Title: `Analysis`
- Refresh detection button
- Close button

Tool area:

- Show available tools only.
- Each tool row shows name, version if known, command preview, and Run button.
- If no tools are available, show a diagnostic empty state with missing requirements.

Run area:

- Show current active run with progress state and elapsed time.
- Show Cancel button for running jobs.
- Show live stdout/stderr tail in a collapsible log region.

Findings:

- Summary counters: errors, warnings, info.
- Filter by severity.
- List findings in a dense table.
- Clicking a finding opens the file in the preferred editor at line/column when possible.

History:

- Show recent runs for the active project/worktree.
- Selecting a run loads its findings and artifacts.
- Clearly label the target path so users can distinguish project-root runs from worktree runs.

## Integration Points

Server:

- Add analysis layer to `RuntimeDependenciesLive`.
- Add analysis RPC handlers in `apps/server/src/ws.ts`.
- Add persistence layer/repository for analysis runs.

Contracts:

- Export analysis schemas from `packages/contracts/src/index.ts`.
- Add RPC entries to `packages/contracts/src/rpc.ts`.
- Add API methods to `packages/contracts/src/ipc.ts`.

Web:

- Add analysis API mapping in `apps/web/src/environmentApi.ts`.
- Add `analysisRouteSearch.ts`.
- Add `AnalysisPanel.tsx` and `AnalysisPanelShell.tsx`.
- Update chat route right-panel orchestration to support `panel=analysis`.
- Add Analysis toggle to `ChatHeader`.

## Tests

Contract tests:

- Decode `AnalysisTool`, `AnalysisRun`, `AnalysisFinding`, and stream events.
- Validate max lengths and nullable fields.

Detector tests:

- Qodana available/unavailable.
- IDE `inspect.sh` available/unavailable.
- Rider available with one `.sln`.
- Rider unavailable with no `.sln`.
- Rider unavailable with multiple `.sln` files.
- Token/Docker/profile diagnostics are stable.

Runner tests:

- Starts a process with expected cwd and env.
- Streams stdout/stderr events.
- Cancels a running process.
- Persists completed run.
- Persists failed run.
- Enforces one active run per target.

Parser tests:

- SARIF findings normalize correctly.
- IntelliJ inspection JSON normalizes correctly.
- Parser errors become structured run failures.

Artifact tests:

- Creates `.t3code/jetbrains-analysis/<runId>/`.
- Adds `.t3code/jetbrains-analysis/` to `.git/info/exclude` when possible.
- Does not modify tracked `.gitignore`.
- Prunes older run artifacts without deleting unrelated files.

UI tests:

- Analysis button opens the right panel.
- Empty state renders when no JetBrains tools are runnable.
- Available tools render with Run actions.
- Starting a run shows running state.
- Completed run shows findings and artifacts.
- Persisted runs appear after remount/bootstrap.

Required verification:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

## Rollout Plan

1. Add contracts, persistence migration, and server service skeleton.
2. Implement tool detection and `analysis.listTools`.
3. Add Analysis panel shell and route state.
4. Implement structured run lifecycle and subscription events.
5. Add artifact storage and ignore handling.
6. Add parsers for Qodana/IDEA/Rider output.
7. Add persisted run history and finding detail UI.
8. Add pruning and polish.

## Open Follow-Ups

- Add project-level configuration for preferred Qodana linter, inspection profile, or Rider solution path.
- Decide whether custom non-JetBrains analysis commands should be a separate feature or an extension of Project Actions.
- Decide whether failed/unavailable tools should be visible behind an advanced diagnostics toggle.
- Decide whether analysis findings should be attachable to prompts as structured context.

## References

- IntelliJ IDEA command-line inspector: https://www.jetbrains.com/help/idea/command-line-code-inspector.html
- JetBrains Rider InspectCode: https://www.jetbrains.com/help/rider/InspectCode.html
- Qodana CLI and local analysis: https://www.jetbrains.com/help/qodana/about-qodana.html
- Qodana configuration: https://www.jetbrains.com/help/qodana/docker-image-configuration.html
