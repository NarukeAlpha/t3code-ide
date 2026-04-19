import type {
  DetectedProjectScript,
  EnvironmentId,
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  BugIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";
import { useEffect, useRef } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { projectDetectedScriptsQueryOptions } from "~/lib/projectReactQuery";
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "~/projectScripts";
import { useProjectActionsDialogStore } from "~/projectActionsDialogStore";
import { shortcutLabelForCommand } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Group, GroupSeparator } from "./ui/group";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
}

interface ProjectScriptDialogDraft {
  editingScriptId: string | null;
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string;
}

interface ProjectScriptsControlProps {
  environmentId: EnvironmentId;
  projectCwd: string | null;
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onRunDetectedScript: (script: DetectedProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

type ProjectActionsDialogTab = "custom" | "packageScripts";
const PACKAGE_SCRIPTS_VISIBLE_COUNT = 5;
const PACKAGE_SCRIPT_CARD_HEIGHT_REM = 5.75;
const PACKAGE_SCRIPT_CARD_GAP_REM = 0.75;
const PACKAGE_SCRIPT_LIST_MAX_HEIGHT = `${PACKAGE_SCRIPTS_VISIBLE_COUNT * PACKAGE_SCRIPT_CARD_HEIGHT_REM + (PACKAGE_SCRIPTS_VISIBLE_COUNT - 1) * PACKAGE_SCRIPT_CARD_GAP_REM}rem`;

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

function keybindingFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(navigator.platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

function detectedScriptActionName(script: DetectedProjectScript): string {
  if (script.source === "package_json") {
    return script.displayName;
  }
  return `${script.badgeLabel} ${script.displayName}`;
}

export default function ProjectScriptsControl({
  environmentId,
  projectCwd,
  scripts,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onRunDetectedScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const addScriptFormId = React.useId();
  const openRequestId = useProjectActionsDialogStore((store) => store.openRequestId);
  const preferredOpenTarget = useProjectActionsDialogStore((store) => store.preferredTab);
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTab, setDialogTab] = useState<ProjectActionsDialogTab>("custom");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const handledOpenRequestIdRef = useRef(0);
  const pendingCustomDialogDraftRef = useRef<ProjectScriptDialogDraft | null>(null);
  const detectedScriptsQuery = useQuery(
    projectDetectedScriptsQueryOptions({
      environmentId,
      cwd: projectCwd,
      enabled: projectCwd !== null,
    }),
  );

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const detectedScripts = detectedScriptsQuery.data?.scripts ?? [];
  const detectedScriptWarnings = detectedScriptsQuery.data?.warnings ?? [];
  const hasDetectedScripts = detectedScripts.length > 0;
  const isEditing = editingScriptId !== null;
  const isPackageScriptsDialog = dialogTab === "packageScripts";
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const applyDialogDraft = useCallback((draft: ProjectScriptDialogDraft) => {
    setEditingScriptId(draft.editingScriptId);
    setName(draft.name);
    setCommand(draft.command);
    setIcon(draft.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(draft.runOnWorktreeCreate);
    setKeybinding(draft.keybinding);
    setValidationError(null);
    setDialogTab("custom");
  }, []);

  const resetDialogDraft = useCallback(() => {
    setEditingScriptId(null);
    setDialogTab("custom");
    setName("");
    setCommand("");
    setIcon("play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(false);
    setKeybinding("");
    setValidationError(null);
    setDeleteConfirmOpen(false);
  }, []);

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      setDialogOpen(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const openAddDialog = useCallback(
    (tab: ProjectActionsDialogTab = "custom") => {
      pendingCustomDialogDraftRef.current = null;
      if (tab === "custom") {
        applyDialogDraft({
          editingScriptId: null,
          name: "",
          command: "",
          icon: "play",
          runOnWorktreeCreate: false,
          keybinding: "",
        });
      }
      setDialogTab(tab);
      setDialogOpen(true);
    },
    [applyDialogDraft],
  );

  const openPackageScriptsDialog = useCallback(() => {
    pendingCustomDialogDraftRef.current = null;
    setEditingScriptId(null);
    setValidationError(null);
    setDialogTab("packageScripts");
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback(
    (script: ProjectScript) => {
      pendingCustomDialogDraftRef.current = null;
      applyDialogDraft({
        editingScriptId: script.id,
        name: script.name,
        command: script.command,
        icon: script.icon,
        runOnWorktreeCreate: script.runOnWorktreeCreate,
        keybinding:
          keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "",
      });
      setDialogOpen(true);
    },
    [applyDialogDraft, keybindings],
  );

  const openSaveDetectedScriptDialog = useCallback(
    (script: DetectedProjectScript) => {
      const draft: ProjectScriptDialogDraft = {
        editingScriptId: null,
        name: detectedScriptActionName(script),
        command: script.command,
        icon: "play",
        runOnWorktreeCreate: false,
        keybinding: "",
      };

      if (dialogOpen && isPackageScriptsDialog) {
        pendingCustomDialogDraftRef.current = draft;
        setDialogOpen(false);
        return;
      }

      pendingCustomDialogDraftRef.current = null;
      applyDialogDraft(draft);
      setDialogOpen(true);
    },
    [applyDialogDraft, dialogOpen, isPackageScriptsDialog],
  );

  useEffect(() => {
    if (openRequestId === 0 || handledOpenRequestIdRef.current >= openRequestId) {
      return;
    }
    if (preferredOpenTarget === "auto" && projectCwd !== null && detectedScriptsQuery.isPending) {
      return;
    }

    handledOpenRequestIdRef.current = openRequestId;
    const nextTab =
      preferredOpenTarget === "auto"
        ? hasDetectedScripts
          ? "packageScripts"
          : "custom"
        : preferredOpenTarget;

    if (nextTab === "packageScripts") {
      openPackageScriptsDialog();
      return;
    }
    openAddDialog("custom");
  }, [
    detectedScriptsQuery.isPending,
    hasDetectedScripts,
    openAddDialog,
    openRequestId,
    openPackageScriptsDialog,
    preferredOpenTarget,
    projectCwd,
  ]);

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onRunScript(primaryScript)}
            title={`Run ${primaryScript.name}`}
          >
            <ScriptIcon icon={primaryScript.icon} />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              {primaryScript.name}
            </span>
          </Button>
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="Script actions" />}
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span className="truncate">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              {hasDetectedScripts ? (
                <>
                  <MenuSeparator />
                  <MenuItem className={dropdownItemClassName} onClick={openPackageScriptsDialog}>
                    <PlayIcon className="size-4" />
                    Package Scripts…
                  </MenuItem>
                </>
              ) : null}
              <MenuItem className={dropdownItemClassName} onClick={() => openAddDialog("custom")}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : hasDetectedScripts ? (
        <Menu highlightItemOnHover={false}>
          <MenuTrigger render={<Button size="xs" variant="outline" title="Project actions" />}>
            <PlayIcon className="size-3.5" />
            <span className="ml-0.5">Actions</span>
            <ChevronDownIcon className="size-3.5 opacity-70" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem className={dropdownItemClassName} onClick={openPackageScriptsDialog}>
              <PlayIcon className="size-4" />
              Package Scripts…
            </MenuItem>
            <MenuItem className={dropdownItemClassName} onClick={() => openAddDialog("custom")}>
              <PlusIcon className="size-4" />
              Add action
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <Button
          size="xs"
          variant="outline"
          onClick={() => openAddDialog("custom")}
          title="Add action"
        >
          <PlusIcon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Add action
          </span>
        </Button>
      )}

      <Dialog
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setIconPickerOpen(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          const pendingDraft = pendingCustomDialogDraftRef.current;
          if (pendingDraft) {
            pendingCustomDialogDraftRef.current = null;
            applyDialogDraft(pendingDraft);
            queueMicrotask(() => setDialogOpen(true));
            return;
          }
          resetDialogDraft();
        }}
        open={dialogOpen}
      >
        <DialogPopup className="duration-120" backdropClassName="duration-120">
          <DialogHeader>
            <DialogTitle>
              {isPackageScriptsDialog
                ? "Package Scripts"
                : isEditing
                  ? "Edit Action"
                  : "Add Action"}
            </DialogTitle>
            <DialogDescription>
              {isPackageScriptsDialog
                ? "Detected scripts are loaded from supported project files and can be run directly or promoted into saved actions."
                : "Actions are project-scoped commands you can run from the top bar or keybindings."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {!isPackageScriptsDialog ? (
              <form id={addScriptFormId} className="space-y-4" onSubmit={submitAddScript}>
                <div className="space-y-1.5">
                  <Label htmlFor="script-name">Name</Label>
                  <div className="flex items-center gap-2">
                    <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                      <PopoverTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover data-pressed:shadow-xs/5 data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                            aria-label="Choose icon"
                          />
                        }
                      >
                        <ScriptIcon icon={icon} className="size-4.5" />
                      </PopoverTrigger>
                      <PopoverPopup align="start">
                        <div className="grid grid-cols-3 gap-2">
                          {SCRIPT_ICONS.map((entry) => {
                            const isSelected = entry.id === icon;
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs ${
                                  isSelected
                                    ? "border-primary/70 bg-primary/10"
                                    : "border-border/70 hover:bg-accent/60"
                                }`}
                                onClick={() => {
                                  setIcon(entry.id);
                                  setIconPickerOpen(false);
                                }}
                              >
                                <ScriptIcon icon={entry.id} className="size-4" />
                                <span>{entry.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </PopoverPopup>
                    </Popover>
                    <Input
                      id="script-name"
                      autoFocus
                      placeholder="Test"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-keybinding">Keybinding</Label>
                  <Input
                    id="script-keybinding"
                    placeholder="Press shortcut"
                    value={keybinding}
                    readOnly
                    onKeyDown={captureKeybinding}
                  />
                  <p className="text-xs text-muted-foreground">
                    Press a shortcut. Use <code>Backspace</code> to clear.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-command">Command</Label>
                  <Textarea
                    id="script-command"
                    placeholder="bun test"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                  <span>Run automatically on worktree creation</span>
                  <Switch
                    checked={runOnWorktreeCreate}
                    onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                  />
                </label>
                {validationError && <p className="text-sm text-destructive">{validationError}</p>}
              </form>
            ) : (
              <div className="space-y-3">
                {detectedScriptsQuery.isPending ? (
                  <p className="text-sm text-muted-foreground">Loading detected scripts…</p>
                ) : null}
                {detectedScriptsQuery.error ? (
                  <p className="text-sm text-destructive">{detectedScriptsQuery.error.message}</p>
                ) : null}
                {detectedScriptWarnings.map((warning) => (
                  <p key={warning.message} className="text-xs text-muted-foreground">
                    {warning.message}
                  </p>
                ))}
                {detectedScripts.length > 0 ? (
                  <ScrollArea
                    className="rounded-lg"
                    scrollbarGutter
                    style={{ maxHeight: PACKAGE_SCRIPT_LIST_MAX_HEIGHT }}
                  >
                    <div className="space-y-3 pe-2">
                      {detectedScripts.map((script) => (
                        <div
                          key={script.id}
                          className="space-y-3 rounded-lg border border-border/70 px-3 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-medium text-sm text-foreground">
                                {script.displayName}
                              </p>
                              <div className="mt-1 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                                <Badge variant="outline" size="sm">
                                  {script.badgeLabel}
                                </Badge>
                                <span className="truncate">{script.detail}</span>
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDialogOpen(false);
                                  onRunDetectedScript(script);
                                }}
                              >
                                Run
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => openSaveDetectedScriptDialog(script)}
                              >
                                Save as action
                              </Button>
                            </div>
                          </div>
                          <div
                            className="truncate rounded-md bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground"
                            title={script.command}
                          >
                            {script.command}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : null}
                {!detectedScriptsQuery.isPending &&
                !detectedScriptsQuery.error &&
                detectedScripts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No detected scripts were found for this project.
                  </p>
                ) : null}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            {!isPackageScriptsDialog ? (
              <>
                {isEditing && (
                  <Button
                    type="button"
                    variant="destructive-outline"
                    className="mr-auto"
                    onClick={() => setDeleteConfirmOpen(true)}
                  >
                    Delete
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button form={addScriptFormId} type="submit">
                  {isEditing ? "Save changes" : "Save action"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                }}
              >
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
