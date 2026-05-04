import {
  type DatabaseInspectConvexProjectResult,
  type DatabaseConnectionDraft,
  type DatabaseConnectionId,
  type EnvironmentId,
  type ProjectId,
  type SavedDatabaseConnection,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseIcon, LinkIcon, ShieldIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  databaseInspectConvexProjectQueryOptions,
  databaseScaffoldConvexHelpersMutationOptions,
  databaseTestConnectionMutationOptions,
  databaseUpsertConnectionMutationOptions,
} from "~/lib/databaseReactQuery";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

type DatabaseConnectionFormState =
  | {
      engine: "sqlite";
      connectionId: DatabaseConnectionId | null;
      label: string;
      filePath: string;
    }
  | {
      engine: "mysql" | "postgres";
      connectionId: DatabaseConnectionId | null;
      label: string;
      inputMode: "manual" | "dsn";
      host: string;
      port: string;
      database: string;
      user: string;
      password: string;
      ssl: boolean;
      dsn: string;
    }
  | {
      engine: "convex";
      connectionId: DatabaseConnectionId | null;
      label: string;
      gatewayBaseUrl: string;
      schemaFilePath: string;
      syncTarget: "dev" | "prod";
      sharedSecret: string;
    };

interface DatabaseConnectionDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connection: SavedDatabaseConnection | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (connection: SavedDatabaseConnection) => void;
}

function buildInitialFormState(
  connection: SavedDatabaseConnection | null,
): DatabaseConnectionFormState {
  if (!connection) {
    return {
      engine: "sqlite",
      connectionId: null,
      label: "",
      filePath: "",
    };
  }

  if (connection.engine === "sqlite") {
    return {
      engine: "sqlite",
      connectionId: connection.id,
      label: connection.label,
      filePath: connection.filePath,
    };
  }

  if (connection.engine === "convex") {
    return {
      engine: "convex",
      connectionId: connection.id,
      label: connection.label,
      gatewayBaseUrl: connection.gatewayBaseUrl,
      schemaFilePath: connection.schemaFilePath,
      syncTarget: connection.syncTarget,
      sharedSecret: "",
    };
  }

  return {
    engine: connection.engine,
    connectionId: connection.id,
    label: connection.label,
    inputMode: "manual",
    host: connection.host,
    port: String(connection.port),
    database: connection.database,
    user: connection.user,
    password: "",
    ssl: connection.ssl,
    dsn: "",
  };
}

function buildDraftInput(
  projectId: ProjectId,
  formState: DatabaseConnectionFormState,
): DatabaseConnectionDraft {
  if (formState.engine === "sqlite") {
    return {
      projectId,
      ...(formState.connectionId ? { connectionId: formState.connectionId } : {}),
      engine: "sqlite",
      label: formState.label,
      filePath: formState.filePath,
    };
  }

  if (formState.engine === "convex") {
    return {
      projectId,
      ...(formState.connectionId ? { connectionId: formState.connectionId } : {}),
      engine: "convex",
      label: formState.label,
      gatewayBaseUrl: formState.gatewayBaseUrl,
      schemaFilePath: formState.schemaFilePath,
      syncTarget: formState.syncTarget,
      ...(formState.sharedSecret.trim().length > 0 ? { sharedSecret: formState.sharedSecret } : {}),
    };
  }

  if (formState.inputMode === "dsn") {
    return {
      projectId,
      ...(formState.connectionId ? { connectionId: formState.connectionId } : {}),
      engine: formState.engine,
      inputMode: "dsn",
      label: formState.label,
      dsn: formState.dsn,
      ...(formState.password.trim().length > 0 ? { password: formState.password } : {}),
    };
  }

  const parsedPort = Number.parseInt(formState.port, 10);
  if (!Number.isFinite(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
    throw new Error("Port must be between 1 and 65535.");
  }

  return {
    projectId,
    ...(formState.connectionId ? { connectionId: formState.connectionId } : {}),
    engine: formState.engine,
    inputMode: "manual",
    label: formState.label,
    host: formState.host,
    port: parsedPort,
    database: formState.database,
    user: formState.user,
    ssl: formState.ssl,
    ...(formState.password.trim().length > 0 ? { password: formState.password } : {}),
  };
}

function asErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The database request failed.";
}

function applyConvexInspectionPrefill(
  current: Extract<DatabaseConnectionFormState, { engine: "convex" }>,
  inspection: DatabaseInspectConvexProjectResult,
) {
  return {
    ...current,
    gatewayBaseUrl:
      current.gatewayBaseUrl.trim().length > 0
        ? current.gatewayBaseUrl
        : (inspection.gatewayBaseUrl ?? ""),
    schemaFilePath:
      current.schemaFilePath.trim().length > 0
        ? current.schemaFilePath
        : (inspection.schemaFilePath ?? ""),
  };
}

export function DatabaseConnectionDialog({
  open,
  environmentId,
  projectId,
  connection,
  onOpenChange,
  onSaved,
}: DatabaseConnectionDialogProps) {
  const queryClient = useQueryClient();
  const [formState, setFormState] = useState<DatabaseConnectionFormState>(() =>
    buildInitialFormState(connection),
  );
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">("success");

  const connectionResetKey = connection ? `${connection.id}:${connection.updatedAt}` : "new";
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const isConvexEngine = formState.engine === "convex";
  const convexInspectionQuery = useQuery(
    databaseInspectConvexProjectQueryOptions({
      environmentId,
      projectId,
      enabled: open && isConvexEngine,
    }),
  );
  const testMutation = useMutation(
    databaseTestConnectionMutationOptions({
      environmentId,
    }),
  );
  const saveMutation = useMutation(
    databaseUpsertConnectionMutationOptions({
      environmentId,
      projectId,
      queryClient,
    }),
  );
  const scaffoldMutation = useMutation(
    databaseScaffoldConvexHelpersMutationOptions({
      environmentId,
      projectId,
      queryClient,
    }),
  );
  const resetTestMutation = testMutation.reset;
  const resetSaveMutation = saveMutation.reset;
  const resetScaffoldMutation = scaffoldMutation.reset;

  useEffect(() => {
    if (!open) {
      return;
    }
    setFormState(buildInitialFormState(connectionRef.current));
    setFeedbackMessage(null);
    setFeedbackTone("success");
    resetTestMutation();
    resetSaveMutation();
    resetScaffoldMutation();
  }, [connectionResetKey, open, resetSaveMutation, resetScaffoldMutation, resetTestMutation]);

  useEffect(() => {
    if (!open || formState.engine !== "convex" || !convexInspectionQuery.data) {
      return;
    }
    setFormState((current) => {
      if (current.engine !== "convex") {
        return current;
      }
      const next = applyConvexInspectionPrefill(current, convexInspectionQuery.data);
      return next.gatewayBaseUrl === current.gatewayBaseUrl &&
        next.schemaFilePath === current.schemaFilePath
        ? current
        : next;
    });
  }, [convexInspectionQuery.data, formState.engine, open]);

  const dialogTitle = connection ? "Edit database" : "Add database";
  const isBusy = testMutation.isPending || saveMutation.isPending || scaffoldMutation.isPending;

  const networkEngineLabel =
    formState.engine === "mysql"
      ? "MySQL"
      : formState.engine === "postgres"
        ? "Postgres"
        : "SQLite";

  const engineButtons = useMemo(
    () =>
      [
        { engine: "sqlite" as const, label: "SQLite" },
        { engine: "mysql" as const, label: "MySQL" },
        { engine: "postgres" as const, label: "Postgres" },
        { engine: "convex" as const, label: "Convex" },
      ] as const,
    [],
  );

  const applyEngine = (engine: DatabaseConnectionFormState["engine"]) => {
    setFeedbackMessage(null);
    setFormState((current) => {
      if (current.engine === engine) {
        return current;
      }
      if (engine === "sqlite") {
        return {
          engine: "sqlite",
          connectionId: current.connectionId,
          label: current.label,
          filePath: "",
        };
      }
      if (engine === "convex") {
        return {
          engine: "convex",
          connectionId: current.connectionId,
          label: current.label,
          gatewayBaseUrl: "",
          schemaFilePath: "",
          syncTarget: "dev",
          sharedSecret: "",
        };
      }
      return {
        engine,
        connectionId: current.connectionId,
        label: current.label,
        inputMode: "manual",
        host: "",
        port: engine === "mysql" ? "3306" : "5432",
        database: "",
        user: "",
        password: "",
        ssl: false,
        dsn: "",
      };
    });
  };

  const updateNetworkState = (
    updater: (
      current: Extract<DatabaseConnectionFormState, { engine: "mysql" | "postgres" }>,
    ) => Extract<DatabaseConnectionFormState, { engine: "mysql" | "postgres" }>,
  ) => {
    setFormState((current) => {
      if (current.engine === "sqlite" || current.engine === "convex") {
        return current;
      }
      return updater(current);
    });
  };

  const runTest = async () => {
    try {
      const draft = buildDraftInput(projectId, formState);
      await testMutation.mutateAsync(draft);
      setFeedbackTone("success");
      setFeedbackMessage("Connection succeeded.");
    } catch (error) {
      setFeedbackTone("error");
      setFeedbackMessage(asErrorMessage(error));
    }
  };

  const runScaffold = async () => {
    if (formState.engine !== "convex") {
      return;
    }

    const localApi = readLocalApi();
    const confirmed = localApi
      ? await localApi.dialogs.confirm(
          `Create or update Convex helper files and push them to Convex ${formState.syncTarget}?`,
        )
      : window.confirm(
          `Create or update Convex helper files and push them to Convex ${formState.syncTarget}?`,
        );
    if (!confirmed) {
      return;
    }

    try {
      const result = await scaffoldMutation.mutateAsync({
        projectId,
        syncTarget: formState.syncTarget,
      });
      const touchedPaths = [...result.writtenPaths, ...result.alreadyPresentPaths];
      setFeedbackTone("success");
      setFeedbackMessage(
        touchedPaths.length > 0
          ? `Convex helper files are ready and pushed to ${result.syncTarget} with ${result.syncCommand}: ${touchedPaths.join(", ")}.`
          : `Convex helper files were already in place and pushed to ${result.syncTarget} with ${result.syncCommand}.`,
      );
    } catch (error) {
      setFeedbackTone("error");
      setFeedbackMessage(asErrorMessage(error));
    }
  };

  const runSave = async () => {
    try {
      const draft = buildDraftInput(projectId, formState);
      const result = await saveMutation.mutateAsync(draft);
      onSaved(result.connection);
      onOpenChange(false);
    } catch (error) {
      setFeedbackTone("error");
      setFeedbackMessage(asErrorMessage(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Save a project-scoped database connection for SQLite, MySQL, Postgres, or Convex.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-4">
            {engineButtons.map((button) => (
              <Button
                key={button.engine}
                variant={formState.engine === button.engine ? "default" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => applyEngine(button.engine)}
              >
                <DatabaseIcon className="size-3.5" />
                {button.label}
              </Button>
            ))}
          </div>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Label</span>
            <Input
              value={formState.label}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  label: event.target.value,
                }))
              }
              placeholder="Primary database"
            />
          </label>

          {formState.engine === "sqlite" ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">SQLite file path</span>
              <Input
                value={formState.filePath}
                onChange={(event) =>
                  setFormState((current) =>
                    current.engine === "sqlite"
                      ? {
                          ...current,
                          filePath: event.target.value,
                        }
                      : current,
                  )
                }
                placeholder="./data/app.sqlite"
              />
            </label>
          ) : formState.engine === "convex" ? (
            <div className="space-y-4">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Gateway base URL</span>
                <Input
                  value={formState.gatewayBaseUrl}
                  onChange={(event) =>
                    setFormState((current) =>
                      current.engine === "convex"
                        ? {
                            ...current,
                            gatewayBaseUrl: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="https://example.convex.site"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Schema file path</span>
                <Input
                  value={formState.schemaFilePath}
                  onChange={(event) =>
                    setFormState((current) =>
                      current.engine === "convex"
                        ? {
                            ...current,
                            schemaFilePath: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder="convex/schema.ts"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Shared secret</span>
                <Input
                  type="password"
                  value={formState.sharedSecret}
                  onChange={(event) =>
                    setFormState((current) =>
                      current.engine === "convex"
                        ? {
                            ...current,
                            sharedSecret: event.target.value,
                          }
                        : current,
                    )
                  }
                  placeholder={
                    connection?.engine === "convex"
                      ? "Leave blank to keep the current shared secret"
                      : "Required to authenticate T3 Code with Convex"
                  }
                />
              </label>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Push target</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    variant={formState.syncTarget === "dev" ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() =>
                      setFormState((current) =>
                        current.engine === "convex"
                          ? {
                              ...current,
                              syncTarget: "dev",
                            }
                          : current,
                      )
                    }
                  >
                    Dev
                  </Button>
                  <Button
                    variant={formState.syncTarget === "prod" ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() =>
                      setFormState((current) =>
                        current.engine === "convex"
                          ? {
                              ...current,
                              syncTarget: "prod",
                            }
                          : current,
                      )
                    }
                  >
                    Prod
                  </Button>
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="font-medium text-foreground">Project inspection</p>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void runScaffold()}
                    disabled={isBusy || !convexInspectionQuery.data?.canScaffold}
                  >
                    {scaffoldMutation.isPending ? (
                      <>
                        <Spinner className="size-3.5" />
                        Creating and pushing...
                      </>
                    ) : (
                      "Create helper functions and push"
                    )}
                  </Button>
                </div>
                {convexInspectionQuery.isPending ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Inspecting project files...
                  </div>
                ) : convexInspectionQuery.isError ? (
                  <p className="text-destructive">{convexInspectionQuery.error.message}</p>
                ) : convexInspectionQuery.data ? (
                  <div className="space-y-2">
                    {convexInspectionQuery.data.detectedFromEnvFile &&
                    convexInspectionQuery.data.detectedFromEnvVar ? (
                      <p className="text-muted-foreground">
                        Detected from {convexInspectionQuery.data.detectedFromEnvFile} via{" "}
                        {convexInspectionQuery.data.detectedFromEnvVar}.
                      </p>
                    ) : null}
                    <div className="space-y-1 text-muted-foreground">
                      {convexInspectionQuery.data.notes.map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">Convex project inspection is unavailable.</p>
                )}
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Convex v1 limitations</p>
                <p className="mt-1">
                  T3 Code requires project-scaffolded helper functions and a shared secret stored in
                  the Convex deployment as <code>T3CODE_CONVEX_SHARED_SECRET</code>.
                </p>
                <p className="mt-1">
                  Create helper functions also pushes to the selected Convex target. SQL execution
                  is unavailable for Convex connections in v1.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant={formState.inputMode === "manual" ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  onClick={() =>
                    updateNetworkState((current) => ({
                      ...current,
                      inputMode: "manual",
                    }))
                  }
                >
                  <ShieldIcon className="size-3.5" />
                  Manual
                </Button>
                <Button
                  variant={formState.inputMode === "dsn" ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  onClick={() =>
                    updateNetworkState((current) => ({
                      ...current,
                      inputMode: "dsn",
                    }))
                  }
                >
                  <LinkIcon className="size-3.5" />
                  DSN
                </Button>
              </div>

              {formState.inputMode === "dsn" ? (
                <div className="grid gap-4">
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {networkEngineLabel} DSN
                    </span>
                    <Input
                      value={formState.dsn}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          dsn: event.target.value,
                        }))
                      }
                      placeholder={
                        formState.engine === "mysql"
                          ? "mysql://user:password@localhost:3306/app"
                          : "postgres://user:password@localhost:5432/app"
                      }
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">Password override</span>
                    <Input
                      type="password"
                      value={formState.password}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          password: event.target.value,
                        }))
                      }
                      placeholder="Optional if the DSN already includes it"
                    />
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">Host</span>
                    <Input
                      value={formState.host}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          host: event.target.value,
                        }))
                      }
                      placeholder="localhost"
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">Port</span>
                    <Input
                      value={formState.port}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          port: event.target.value,
                        }))
                      }
                      placeholder={formState.engine === "mysql" ? "3306" : "5432"}
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">Database</span>
                    <Input
                      value={formState.database}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          database: event.target.value,
                        }))
                      }
                      placeholder="app"
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">User</span>
                    <Input
                      value={formState.user}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          user: event.target.value,
                        }))
                      }
                      placeholder="postgres"
                    />
                  </label>
                  <label className="grid gap-1.5 md:col-span-2">
                    <span className="text-xs font-medium text-foreground">Password</span>
                    <Input
                      type="password"
                      value={formState.password}
                      onChange={(event) =>
                        updateNetworkState((current) => ({
                          ...current,
                          password: event.target.value,
                        }))
                      }
                      placeholder={
                        connection
                          ? "Leave blank to keep the current password"
                          : "Optional for passwordless databases"
                      }
                    />
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
                    <Checkbox
                      checked={formState.ssl}
                      onCheckedChange={(checked) =>
                        updateNetworkState((current) => ({
                          ...current,
                          ssl: checked,
                        }))
                      }
                    />
                    Require SSL
                  </label>
                </div>
              )}
            </>
          )}

          {feedbackMessage ? (
            <p
              className={cn(
                "text-xs",
                feedbackTone === "success" ? "text-success" : "text-destructive",
              )}
            >
              {feedbackMessage}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={() => void runTest()} disabled={isBusy}>
            {testMutation.isPending ? (
              <>
                <Spinner className="size-3.5" />
                Testing...
              </>
            ) : (
              "Test connection"
            )}
          </Button>
          <Button size="sm" onClick={() => void runSave()} disabled={isBusy}>
            {saveMutation.isPending ? (
              <>
                <Spinner className="size-3.5" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
