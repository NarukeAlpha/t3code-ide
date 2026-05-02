import {
  type DatabaseConnectionDraft,
  type DatabaseDeleteConnectionInput,
  type DatabaseExecuteQueryInput,
  type DatabaseListConnectionsResult,
  type DatabaseListConnectionsInput,
  type DatabaseInspectConvexProjectInput,
  type DatabaseListSchemasInput,
  type DatabaseListTablesInput,
  type DatabasePreviewTableInput,
  type DatabaseScaffoldConvexHelpersInput,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../environmentApi";

export const databaseQueryKeys = {
  all: ["database"] as const,
  project: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    ["database", environmentId ?? null, projectId ?? null] as const,
  connections: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    [...databaseQueryKeys.project(environmentId, projectId), "connections"] as const,
  convexInspect: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    [...databaseQueryKeys.project(environmentId, projectId), "convex-inspect"] as const,
  schemas: (
    environmentId: EnvironmentId | null,
    projectId: ProjectId | null,
    connectionId: string | null,
  ) => [...databaseQueryKeys.project(environmentId, projectId), "schemas", connectionId] as const,
  tables: (
    environmentId: EnvironmentId | null,
    projectId: ProjectId | null,
    connectionId: string | null,
    schemaName: string | null,
  ) =>
    [
      ...databaseQueryKeys.project(environmentId, projectId),
      "tables",
      connectionId,
      schemaName,
    ] as const,
  preview: (
    environmentId: EnvironmentId | null,
    projectId: ProjectId | null,
    connectionId: string | null,
    schemaName: string | null,
    tableName: string | null,
    page: number,
  ) =>
    [
      ...databaseQueryKeys.project(environmentId, projectId),
      "preview",
      connectionId,
      schemaName,
      tableName,
      page,
    ] as const,
};

export function invalidateProjectDatabaseQueries(
  queryClient: QueryClient,
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly projectId: ProjectId | null;
  },
) {
  return queryClient.invalidateQueries({
    queryKey: databaseQueryKeys.project(input.environmentId, input.projectId),
  });
}

export function databaseListConnectionsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: databaseQueryKeys.connections(input.environmentId, input.projectId),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Database connections are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      const payload: DatabaseListConnectionsInput = { projectId: input.projectId };
      return api.database.listConnections(payload);
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function databaseListSchemasQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly connectionId: string | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: databaseQueryKeys.schemas(input.environmentId, input.projectId, input.connectionId),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId || !input.connectionId) {
        throw new Error("Database schema browsing is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      const payload: DatabaseListSchemasInput = {
        projectId: input.projectId,
        connectionId: input.connectionId as DatabaseListSchemasInput["connectionId"],
      };
      return api.database.listSchemas(payload);
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.connectionId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function databaseInspectConvexProjectQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: databaseQueryKeys.convexInspect(input.environmentId, input.projectId),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Convex project inspection is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      const payload: DatabaseInspectConvexProjectInput = {
        projectId: input.projectId,
      };
      return api.database.inspectConvexProject(payload);
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function databaseListTablesQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly connectionId: string | null;
  readonly schemaName: string | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: databaseQueryKeys.tables(
      input.environmentId,
      input.projectId,
      input.connectionId,
      input.schemaName,
    ),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId || !input.connectionId || !input.schemaName) {
        throw new Error("Database table browsing is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      const payload: DatabaseListTablesInput = {
        projectId: input.projectId,
        connectionId: input.connectionId as DatabaseListTablesInput["connectionId"],
        schemaName: input.schemaName as DatabaseListTablesInput["schemaName"],
      };
      return api.database.listTables(payload);
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.connectionId !== null &&
      input.schemaName !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function databaseTablePreviewQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly connectionId: string | null;
  readonly schemaName: string | null;
  readonly tableName: string | null;
  readonly page: number;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: databaseQueryKeys.preview(
      input.environmentId,
      input.projectId,
      input.connectionId,
      input.schemaName,
      input.tableName,
      input.page,
    ),
    queryFn: async () => {
      if (
        !input.environmentId ||
        !input.projectId ||
        !input.connectionId ||
        !input.schemaName ||
        !input.tableName
      ) {
        throw new Error("Table preview is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      const payload: DatabasePreviewTableInput = {
        projectId: input.projectId,
        connectionId: input.connectionId as DatabasePreviewTableInput["connectionId"],
        schemaName: input.schemaName as DatabasePreviewTableInput["schemaName"],
        tableName: input.tableName as DatabasePreviewTableInput["tableName"],
        page: input.page,
      };
      return api.database.previewTable(payload);
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.connectionId !== null &&
      input.schemaName !== null &&
      input.tableName !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function databaseTestConnectionMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  return mutationOptions({
    mutationKey: ["database", "mutation", "test-connection", input.environmentId ?? null] as const,
    mutationFn: async (draft: DatabaseConnectionDraft) => {
      if (!input.environmentId) {
        throw new Error("Database testing is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).database.testConnection(draft);
    },
  });
}

export function databaseUpsertConnectionMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: [
      "database",
      "mutation",
      "upsert-connection",
      input.environmentId ?? null,
      input.projectId ?? null,
    ] as const,
    mutationFn: async (draft: DatabaseConnectionDraft) => {
      if (!input.environmentId) {
        throw new Error("Database saving is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).database.upsertConnection(draft);
    },
    onSuccess: async (result) => {
      input.queryClient.setQueryData<DatabaseListConnectionsResult>(
        databaseQueryKeys.connections(input.environmentId, input.projectId),
        (current) => {
          const existing = current?.connections ?? [];
          return {
            connections: [
              result.connection,
              ...existing.filter((connection) => connection.id !== result.connection.id),
            ],
          };
        },
      );
      await invalidateProjectDatabaseQueries(input.queryClient, {
        environmentId: input.environmentId,
        projectId: input.projectId,
      });
    },
  });
}

export function databaseScaffoldConvexHelpersMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: [
      "database",
      "mutation",
      "scaffold-convex-helpers",
      input.environmentId ?? null,
      input.projectId ?? null,
    ] as const,
    mutationFn: async (payload: DatabaseScaffoldConvexHelpersInput) => {
      if (!input.environmentId) {
        throw new Error("Convex scaffolding is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).database.scaffoldConvexHelpers(payload);
    },
    onSuccess: async () => {
      await Promise.all([
        invalidateProjectDatabaseQueries(input.queryClient, {
          environmentId: input.environmentId,
          projectId: input.projectId,
        }),
        input.queryClient.invalidateQueries({
          queryKey: databaseQueryKeys.convexInspect(input.environmentId, input.projectId),
        }),
      ]);
    },
  });
}

export function databaseDeleteConnectionMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: [
      "database",
      "mutation",
      "delete-connection",
      input.environmentId ?? null,
      input.projectId ?? null,
    ] as const,
    mutationFn: async (payload: DatabaseDeleteConnectionInput) => {
      if (!input.environmentId) {
        throw new Error("Database deletion is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).database.deleteConnection(payload);
    },
    onSuccess: async (result) => {
      input.queryClient.setQueryData<DatabaseListConnectionsResult>(
        databaseQueryKeys.connections(input.environmentId, input.projectId),
        (current) => {
          if (!current) {
            return current;
          }
          return {
            connections: current.connections.filter(
              (connection) => connection.id !== result.connectionId,
            ),
          };
        },
      );
      await invalidateProjectDatabaseQueries(input.queryClient, {
        environmentId: input.environmentId,
        projectId: input.projectId,
      });
    },
  });
}

export function databaseExecuteQueryMutationOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: [
      "database",
      "mutation",
      "execute-query",
      input.environmentId ?? null,
      input.projectId ?? null,
    ] as const,
    mutationFn: async (payload: DatabaseExecuteQueryInput) => {
      if (!input.environmentId) {
        throw new Error("Database querying is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).database.executeQuery(payload);
    },
    onSuccess: async () => {
      await invalidateProjectDatabaseQueries(input.queryClient, {
        environmentId: input.environmentId,
        projectId: input.projectId,
      });
    },
  });
}
