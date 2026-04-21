import type {
  DatabaseExecuteQueryResult,
  DatabasePreviewTableResult,
  DatabaseSchemaInfo,
  DatabaseTableInfo,
} from "@t3tools/contracts";

import type { DatabaseDriver } from "../Services/DatabaseManager.ts";
import { previewConvexTable, pingConvexGateway } from "../convex/GatewayClient.ts";
import { parseConvexSchema } from "../convex/SchemaParser.ts";
import { CONVEX_DATABASE_SCHEMA_NAME, toDatabaseError } from "../convex/shared.ts";
import { createColumnsFromNames, DATABASE_PREVIEW_PAGE_SIZE } from "./shared.ts";

export interface ConvexDriverConfig {
  readonly projectRoot: string;
  readonly schemaFilePath: string;
  readonly gatewayBaseUrl: string;
  readonly sharedSecret: string;
}

export async function createConvexDriver(config: ConvexDriverConfig): Promise<DatabaseDriver> {
  const readSchema = () =>
    parseConvexSchema({
      projectRoot: config.projectRoot,
      schemaFilePath: config.schemaFilePath,
    });

  const listSchemas = async (): Promise<ReadonlyArray<DatabaseSchemaInfo>> => [
    { name: CONVEX_DATABASE_SCHEMA_NAME },
  ];

  const listTables = async (schemaName: string): Promise<ReadonlyArray<DatabaseTableInfo>> => {
    if (schemaName !== CONVEX_DATABASE_SCHEMA_NAME) {
      return [];
    }
    const schema = await readSchema();
    return schema.tables.map((table) => ({
      schemaName: CONVEX_DATABASE_SCHEMA_NAME,
      name: table.name,
    }));
  };

  const previewTable = async (input: {
    readonly schemaName: string;
    readonly tableName: string;
    readonly page: number;
  }): Promise<DatabasePreviewTableResult> => {
    if (input.schemaName !== CONVEX_DATABASE_SCHEMA_NAME) {
      throw toDatabaseError(`Convex schema ${input.schemaName} is not supported.`);
    }

    const schema = await readSchema();
    const table = schema.tables.find((candidate) => candidate.name === input.tableName);
    if (!table) {
      throw toDatabaseError(
        `Convex table ${input.tableName} was not found in ${schema.schemaFilePath}.`,
      );
    }

    const gatewayResult = await previewConvexTable({
      gatewayBaseUrl: config.gatewayBaseUrl,
      sharedSecret: config.sharedSecret,
      tableName: input.tableName,
      page: input.page,
      pageSize: DATABASE_PREVIEW_PAGE_SIZE,
    });

    const schemaColumnNames = ["_id", "_creationTime", ...table.fieldNames];
    const columns =
      schemaColumnNames.length > 2
        ? createColumnsFromNames(Array.from(new Set(schemaColumnNames)))
        : gatewayResult.columns;

    return {
      schemaName: CONVEX_DATABASE_SCHEMA_NAME,
      tableName: gatewayResult.tableName,
      page: gatewayResult.page,
      pageSize: gatewayResult.pageSize,
      totalRowCount: gatewayResult.totalRowCount,
      hasNextPage: gatewayResult.hasNextPage,
      columns,
      rows: gatewayResult.rows,
    };
  };

  return {
    testConnection: async () => {
      await readSchema();
      await pingConvexGateway({
        gatewayBaseUrl: config.gatewayBaseUrl,
        sharedSecret: config.sharedSecret,
      });
    },
    listSchemas,
    listTables,
    previewTable,
    executeQuery: async (): Promise<DatabaseExecuteQueryResult> => {
      throw toDatabaseError("Convex connections do not support SQL queries.");
    },
    dispose: async () => {},
  };
}
