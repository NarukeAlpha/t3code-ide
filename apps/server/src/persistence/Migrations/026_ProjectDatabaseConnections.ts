import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_database_connections (
      project_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      label TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, connection_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_database_connections_project_updated
    ON project_database_connections (project_id, updated_at DESC, connection_id ASC)
  `;
});
