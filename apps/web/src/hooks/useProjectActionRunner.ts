import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  TerminalOpenInput,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useCallback } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { randomUUID } from "~/lib/utils";
import { DEFAULT_THREAD_TERMINAL_ID, type Project, type Thread } from "../types";

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

interface RunnableProjectAction {
  readonly name: string;
  readonly command: string;
  readonly scriptId?: string | null;
}

interface RunProjectActionOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly worktreePath?: string | null;
  readonly preferNewTerminal?: boolean;
  readonly rememberAsLastInvoked?: boolean;
}

interface ProjectActionTerminalState {
  readonly activeTerminalId: string | null;
  readonly terminalIds: readonly string[];
  readonly runningTerminalIds: readonly string[];
}

interface UseProjectActionRunnerInput {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeThread: Pick<Thread, "worktreePath"> | undefined;
  readonly activeProject: Pick<Project, "id" | "cwd"> | undefined;
  readonly terminalState: ProjectActionTerminalState;
  readonly setTerminalLaunchContext: (input: {
    threadId: ThreadId;
    cwd: string;
    worktreePath: string | null;
  }) => void;
  readonly setTerminalOpen: (open: boolean) => void;
  readonly storeNewTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  readonly storeSetActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  readonly requestTerminalFocus: () => void;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
  readonly rememberLastInvokedScript?: (projectId: ProjectId, scriptId: string) => void;
}

export function useProjectActionRunner(input: UseProjectActionRunnerInput) {
  return useCallback(
    async (action: RunnableProjectAction, options?: RunProjectActionOptions) => {
      const api = readEnvironmentApi(input.environmentId);
      if (!api || !input.activeThreadId || !input.activeProject || !input.activeThread) return;

      if (
        options?.rememberAsLastInvoked !== false &&
        action.scriptId &&
        input.rememberLastInvokedScript
      ) {
        input.rememberLastInvokedScript(input.activeProject.id, action.scriptId);
      }

      const targetWorktreePath = options?.worktreePath ?? input.activeThread.worktreePath ?? null;
      const targetCwd =
        options?.cwd ??
        projectScriptCwd({
          project: { cwd: input.activeProject.cwd },
          worktreePath: targetWorktreePath,
        });
      const baseTerminalId =
        input.terminalState.activeTerminalId ||
        input.terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = input.terminalState.runningTerminalIds.includes(baseTerminalId);
      const shouldCreateNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      input.setTerminalLaunchContext({
        threadId: input.activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      input.setTerminalOpen(true);

      if (!input.activeThreadRef) {
        return;
      }

      if (shouldCreateNewTerminal) {
        input.storeNewTerminal(input.activeThreadRef, targetTerminalId);
      } else {
        input.storeSetActiveTerminal(input.activeThreadRef, targetTerminalId);
      }
      input.requestTerminalFocus();

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: input.activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: input.activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: input.activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: input.activeThreadId,
          terminalId: targetTerminalId,
          data: `${action.command}\r`,
        });
      } catch (error) {
        input.setThreadError(
          input.activeThreadId,
          error instanceof Error ? error.message : `Failed to run action "${action.name}".`,
        );
      }
    },
    [input],
  );
}
