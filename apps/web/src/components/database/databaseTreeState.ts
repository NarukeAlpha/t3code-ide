export type DatabaseExpandedSchemas = Record<string, boolean>;

export function getDatabaseSchemaStateKey(schemaName: string) {
  return schemaName;
}

export function isDatabaseSchemaExpanded(
  expandedSchemas: DatabaseExpandedSchemas,
  schemaName: string,
) {
  return expandedSchemas[getDatabaseSchemaStateKey(schemaName)] === true;
}

export function toggleDatabaseSchemaExpanded(
  expandedSchemas: DatabaseExpandedSchemas,
  schemaName: string,
): DatabaseExpandedSchemas {
  const key = getDatabaseSchemaStateKey(schemaName);
  return {
    ...expandedSchemas,
    [key]: !expandedSchemas[key],
  };
}
