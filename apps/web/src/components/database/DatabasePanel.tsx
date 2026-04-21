import {
  type DatabaseConnectionId,
  type DatabaseExecuteQueryResult,
  type EnvironmentId,
  type ProjectId,
  type SavedDatabaseConnection,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Table2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  databaseDeleteConnectionMutationOptions,
  databaseExecuteQueryMutationOptions,
  databaseListConnectionsQueryOptions,
  databaseListSchemasQueryOptions,
  databaseListTablesQueryOptions,
  databaseTablePreviewQueryOptions,
  invalidateProjectDatabaseQueries,
} from "~/lib/databaseReactQuery";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseResultsDialog } from "./DatabaseResultsDialog";
import {
  deriveDatabaseQueryVisibleRows,
  getDatabaseSelectedConnectionStorageKey,
  NullableDatabaseConnectionId,
} from "./databaseQueryState";
import {
  isDatabaseSchemaExpanded,
  toggleDatabaseSchemaExpanded,
  type DatabaseExpandedSchemas,
} from "./databaseTreeState";

const EMPTY_DATABASE_CONNECTIONS: ReadonlyArray<SavedDatabaseConnection> = [];

type DatabaseResultView =
  | {
      kind: "preview";
      connectionId: DatabaseConnectionId;
      connectionLabel: string | null;
      schemaName: string;
      tableName: string;
      page: number;
    }
  | {
      kind: "query";
      connectionLabel: string | null;
      sql: string;
      result: DatabaseExecuteQueryResult;
    };

interface DatabaseSchemaSectionProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connectionId: DatabaseConnectionId;
  schemaName: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenTable: (schemaName: string, tableName: string) => void;
}

function asErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The database request failed.";
}

function DatabaseSchemaSection({
  environmentId,
  projectId,
  connectionId,
  schemaName,
  expanded,
  onToggle,
  onOpenTable,
}: DatabaseSchemaSectionProps) {
  const tablesQuery = useQuery(
    databaseListTablesQueryOptions({
      environmentId,
      projectId,
      connectionId,
      schemaName,
      enabled: expanded,
    }),
  );

  return (
    <div className="rounded-lg border border-border/60 bg-background/70">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/40"
      >
        {expanded ? (
          <ChevronDownIcon className="size-4" />
        ) : (
          <ChevronRightIcon className="size-4" />
        )}
        <DatabaseIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{schemaName}</span>
      </button>
      {expanded ? (
        <div className="border-t border-border/50 px-2 py-2">
          {tablesQuery.isPending ? (
            <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Loading tables...
            </div>
          ) : tablesQuery.isError ? (
            <p className="px-2 py-2 text-destructive text-xs">{tablesQuery.error.message}</p>
          ) : tablesQuery.data?.tables.length ? (
            <div className="space-y-1">
              {tablesQuery.data.tables.map((table) => (
                <button
                  key={`${table.schemaName}:${table.name}`}
                  type="button"
                  onClick={() => onOpenTable(table.schemaName, table.name)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/40"
                >
                  <Table2Icon className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 truncate">{table.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-2 py-2 text-muted-foreground text-xs">No tables found.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DatabasePanel(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectName?: string;
  mode: "sidebar" | "sheet";
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [expandedSchemas, setExpandedSchemas] = useState<DatabaseExpandedSchemas>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [queryError, setQueryError] = useState<string | null>(null);
  const [connectionDialogState, setConnectionDialogState] = useState<{
    open: boolean;
    connection: SavedDatabaseConnection | null;
  }>({
    open: false,
    connection: null,
  });
  const [resultView, setResultView] = useState<DatabaseResultView | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useLocalStorage(
    getDatabaseSelectedConnectionStorageKey({
      environmentId: props.environmentId,
      projectId: props.projectId,
    }),
    null,
    NullableDatabaseConnectionId,
  );

  const connectionsQuery = useQuery(
    databaseListConnectionsQueryOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
    }),
  );
  const deleteConnectionMutation = useMutation(
    databaseDeleteConnectionMutationOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
      queryClient,
    }),
  );
  const executeQueryMutation = useMutation(
    databaseExecuteQueryMutationOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
      queryClient,
    }),
  );

  const connections = connectionsQuery.data?.connections ?? EMPTY_DATABASE_CONNECTIONS;
  const selectedConnection =
    connections.find((connection) => connection.id === selectedConnectionId) ?? null;
  const isConvexConnection = selectedConnection?.engine === "convex";

  useEffect(() => {
    if (connectionsQuery.isPending || connectionsQuery.isFetching) {
      return;
    }
    if (connections.length === 0) {
      if (selectedConnectionId !== null) {
        setSelectedConnectionId(null);
      }
      return;
    }
    if (selectedConnectionId === null) {
      setSelectedConnectionId(connections[0]!.id);
      return;
    }
    if (!selectedConnection) {
      setSelectedConnectionId(connections[0]!.id);
    }
  }, [
    connections,
    connectionsQuery.isFetching,
    connectionsQuery.isPending,
    selectedConnection,
    selectedConnectionId,
    setSelectedConnectionId,
  ]);

  useEffect(() => {
    setExpandedSchemas({});
    setQueryText("");
    setQueryError(null);
    setResultView(null);
  }, [selectedConnectionId]);

  const schemasQuery = useQuery(
    databaseListSchemasQueryOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
      connectionId: selectedConnection?.id ?? null,
      enabled: selectedConnection !== null,
    }),
  );

  const previewView = resultView?.kind === "preview" ? resultView : null;
  const previewQuery = useQuery(
    databaseTablePreviewQueryOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
      connectionId: previewView?.connectionId ?? null,
      schemaName: previewView?.schemaName ?? null,
      tableName: previewView?.tableName ?? null,
      page: previewView?.page ?? 1,
      enabled: previewView !== null,
    }),
  );

  const visibleQueryRows = deriveDatabaseQueryVisibleRows(queryText);

  const toggleSchema = useCallback((schemaName: string) => {
    setExpandedSchemas((current) => toggleDatabaseSchemaExpanded(current, schemaName));
  }, []);

  const openTablePreview = useCallback(
    (schemaName: string, tableName: string) => {
      if (!selectedConnection) {
        return;
      }
      setResultView({
        kind: "preview",
        connectionId: selectedConnection.id,
        connectionLabel: selectedConnection.label,
        schemaName,
        tableName,
        page: 1,
      });
    },
    [selectedConnection],
  );

  const runQuery = useCallback(async () => {
    if (!selectedConnection) {
      return;
    }
    setQueryError(null);
    try {
      const result = await executeQueryMutation.mutateAsync({
        projectId: props.projectId,
        connectionId: selectedConnection.id,
        sql: queryText,
      });
      setResultView({
        kind: "query",
        connectionLabel: selectedConnection.label,
        sql: queryText,
        result,
      });
    } catch (error) {
      setQueryError(asErrorMessage(error));
    }
  }, [executeQueryMutation, props.projectId, queryText, selectedConnection]);

  const refreshDatabase = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await invalidateProjectDatabaseQueries(queryClient, {
        environmentId: props.environmentId,
        projectId: props.projectId,
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [props.environmentId, props.projectId, queryClient]);

  const confirmDeleteSelectedConnection = useCallback(async () => {
    if (!selectedConnection) {
      return;
    }
    const localApi = readLocalApi();
    const confirmed = localApi
      ? await localApi.dialogs.confirm(
          `Delete database connection "${selectedConnection.label}" from this project?`,
        )
      : window.confirm(
          `Delete database connection "${selectedConnection.label}" from this project?`,
        );
    if (!confirmed) {
      return;
    }
    await deleteConnectionMutation.mutateAsync({
      projectId: props.projectId,
      connectionId: selectedConnection.id,
    });
    setSelectedConnectionId(null);
  }, [deleteConnectionMutation, props.projectId, selectedConnection, setSelectedConnectionId]);

  const resultsDialogView = useMemo(() => {
    if (!resultView) {
      return null;
    }
    if (resultView.kind === "query") {
      return resultView;
    }
    return {
      kind: "preview" as const,
      connectionLabel: resultView.connectionLabel,
      schemaName: resultView.schemaName,
      tableName: resultView.tableName,
      page: resultView.page,
      result: previewQuery.data ?? null,
      isPending: previewQuery.isPending || previewQuery.isFetching,
      errorMessage: previewQuery.isError ? previewQuery.error.message : null,
      onPreviousPage:
        resultView.page > 1
          ? () =>
              setResultView((current) =>
                current?.kind === "preview"
                  ? {
                      ...current,
                      page: Math.max(1, current.page - 1),
                    }
                  : current,
              )
          : null,
      onNextPage:
        previewQuery.data?.hasNextPage === true
          ? () =>
              setResultView((current) =>
                current?.kind === "preview"
                  ? {
                      ...current,
                      page: current.page + 1,
                    }
                  : current,
              )
          : null,
    };
  }, [
    previewQuery.data,
    previewQuery.error,
    previewQuery.isError,
    previewQuery.isFetching,
    previewQuery.isPending,
    resultView,
  ]);

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runQuery();
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">Database</p>
            {props.projectName ? (
              <p className="truncate text-muted-foreground text-xs">{props.projectName}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void refreshDatabase()}
            aria-label="Refresh database panel"
            title="Refresh database"
            disabled={isRefreshing}
          >
            <RefreshCwIcon className={isRefreshing ? "size-4 animate-spin" : "size-4"} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={props.onClose}
            aria-label="Close database panel"
          >
            <PanelRightCloseIcon className="size-4" />
          </Button>
        </div>
        <div className="grid gap-2 px-4 pb-3">
          <div className="flex items-center gap-2">
            <Select
              value={selectedConnectionId ?? undefined}
              onValueChange={(value) => setSelectedConnectionId(value as DatabaseConnectionId)}
              items={connections.map((connection) => ({
                value: connection.id,
                label: connection.label,
              }))}
            >
              <SelectTrigger size="sm" aria-label="Selected database connection" className="flex-1">
                <DatabaseIcon className="size-3.5" />
                {selectedConnectionId ? (
                  <SelectValue>{selectedConnection?.label ?? "Loading database..."}</SelectValue>
                ) : (
                  <span className="text-muted-foreground text-sm">Select a database</span>
                )}
              </SelectTrigger>
              <SelectPopup>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <DatabaseIcon className="size-3.5 text-muted-foreground" />
                      <span className="truncate">{connection.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                setConnectionDialogState({
                  open: true,
                  connection: null,
                })
              }
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
            {selectedConnection ? (
              <Menu>
                <MenuTrigger render={<Button variant="outline" size="icon-xs" />}>
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    onClick={() =>
                      setConnectionDialogState({
                        open: true,
                        connection: selectedConnection,
                      })
                    }
                  >
                    Edit
                  </MenuItem>
                  <MenuItem onClick={() => void confirmDeleteSelectedConnection()}>Delete</MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
          {connectionsQuery.isPending ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Loading connections...
            </div>
          ) : connectionsQuery.isError ? (
            <p className="text-destructive text-xs">{connectionsQuery.error.message}</p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-3 p-4">
            {!selectedConnection ? (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/18 p-4 text-sm">
                <p className="font-medium">No database selected</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Add a connection to browse schemas and run queries.
                </p>
              </div>
            ) : schemasQuery.isPending ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-4" />
                Loading schemas...
              </div>
            ) : schemasQuery.isError ? (
              <p className="text-destructive text-sm">{schemasQuery.error.message}</p>
            ) : schemasQuery.data?.schemas.length ? (
              schemasQuery.data.schemas.map((schema) => (
                <DatabaseSchemaSection
                  key={schema.name}
                  environmentId={props.environmentId}
                  projectId={props.projectId}
                  connectionId={selectedConnection.id}
                  schemaName={schema.name}
                  expanded={isDatabaseSchemaExpanded(expandedSchemas, schema.name)}
                  onToggle={() => toggleSchema(schema.name)}
                  onOpenTable={openTablePreview}
                />
              ))
            ) : (
              <p className="text-muted-foreground text-sm">No schemas found.</p>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="border-t border-border px-4 py-3">
        {isConvexConnection ? (
          <div className="rounded-lg border border-border/60 bg-muted/18 px-3 py-2 text-xs text-muted-foreground">
            Convex v1 supports schema browsing and table preview only.
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
                Query
              </p>
              {executeQueryMutation.isPending ? (
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Spinner className="size-3.5" />
                  Running...
                </div>
              ) : null}
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={queryText}
                rows={visibleQueryRows}
                onChange={(event) => setQueryText(event.target.value)}
                onKeyDown={onQueryKeyDown}
                placeholder="SELECT * FROM users"
                className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
                style={{
                  maxHeight: `${4 * 1.6}rem`,
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runQuery()}
                disabled={!selectedConnection || executeQueryMutation.isPending}
              >
                <PlayIcon className="size-3.5" />
                Run
              </Button>
            </div>
            {queryError ? <p className="mt-2 text-destructive text-xs">{queryError}</p> : null}
          </>
        )}
      </div>

      <DatabaseConnectionDialog
        open={connectionDialogState.open}
        environmentId={props.environmentId}
        projectId={props.projectId}
        connection={connectionDialogState.connection}
        onOpenChange={(open) =>
          setConnectionDialogState((current) => ({
            ...current,
            open,
          }))
        }
        onSaved={(connection) => {
          setSelectedConnectionId(connection.id);
        }}
      />
      <DatabaseResultsDialog
        view={resultsDialogView}
        onOpenChange={(open) => {
          if (!open) {
            setResultView(null);
          }
        }}
      />
    </div>
  );
}
