import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  TerminalOpenInput,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useCallback } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { randomUUID } from "~/lib/utils";

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const DEFAULT_THREAD_TERMINAL_ID = "terminal-main";

export interface ProjectActionTerminalState {
  readonly activeTerminalId: string;
  readonly terminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
}

export interface RunnableProjectAction {
  readonly name: string;
  readonly command: string;
  readonly rememberScriptId?: string | null;
}

export interface RunProjectActionOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly worktreePath?: string | null;
  readonly preferNewTerminal?: boolean;
  readonly rememberAsLastInvoked?: boolean;
}

interface PrepareProjectActionTerminalInput {
  readonly threadId: ThreadId;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly terminalId: string;
  readonly createNewTerminal: boolean;
}

interface UseProjectActionRunnerInput {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: { readonly id: ProjectId; readonly cwd: string } | null;
  readonly activeThreadWorktreePath: string | null;
  readonly defaultCwd: string | null;
  readonly terminalState: ProjectActionTerminalState;
  readonly prepareTerminal: (input: PrepareProjectActionTerminalInput) => void;
  readonly rememberLastInvokedScript: (projectId: ProjectId, scriptId: string) => void;
  readonly setThreadError: (threadId: ThreadId, message: string) => void;
}

export function useProjectActionRunner(input: UseProjectActionRunnerInput) {
  const {
    environmentId,
    activeThreadId,
    activeThreadRef,
    activeProject,
    activeThreadWorktreePath,
    defaultCwd,
    terminalState,
    prepareTerminal,
    rememberLastInvokedScript,
    setThreadError,
  } = input;

  return useCallback(
    async (action: RunnableProjectAction, options?: RunProjectActionOptions) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId || !activeProject) {
        return;
      }

      if (action.rememberScriptId && options?.rememberAsLastInvoked !== false) {
        rememberLastInvokedScript(activeProject.id, action.rememberScriptId);
      }

      const targetCwd = options?.cwd ?? defaultCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const createNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const targetTerminalId = createNewTerminal ? `terminal-${randomUUID()}` : baseTerminalId;
      const targetWorktreePath = options?.worktreePath ?? activeThreadWorktreePath ?? null;

      prepareTerminal({
        threadId: activeThreadId,
        threadRef: activeThreadRef,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
        terminalId: targetTerminalId,
        createNewTerminal,
      });

      const runtimeEnv = projectScriptRuntimeEnv({
        project: { cwd: activeProject.cwd },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = createNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${action.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run action "${action.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      defaultCwd,
      environmentId,
      prepareTerminal,
      rememberLastInvokedScript,
      setThreadError,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
}
