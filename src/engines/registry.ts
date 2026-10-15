import type { ExplainEngine } from "./types";
import { postgres } from "./postgres";

/**
 * Every supported database. To add one, implement {@link ExplainEngine} in
 * `src/engines/<name>/` and list it here.
 */
export const ENGINES: ExplainEngine[] = [postgres];

export function engineForConnection(connectionType: string | undefined): ExplainEngine | undefined {
  if (!connectionType) return undefined;
  return ENGINES.find((engine) => engine.connectionTypes.includes(connectionType));
}

/** Finds the engine whose plan format matches a pasted value. */
export function engineForPlan(input: unknown, preferred?: ExplainEngine): ExplainEngine | undefined {
  if (preferred?.canParse(input)) return preferred;
  return ENGINES.find((engine) => engine !== preferred && engine.canParse(input));
}

export function supportedDatabaseNames(): string {
  return ENGINES.map((e) => e.displayName).join(", ");
}

const DATABASE_NAMES: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  sqlserver: "SQL Server",
  oracle: "Oracle",
  cockroachdb: "CockroachDB",
  redshift: "Redshift",
  bigquery: "BigQuery",
  clickhouse: "ClickHouse",
  duckdb: "DuckDB",
  libsql: "LibSQL",
  firebird: "Firebird",
  mongodb: "MongoDB",
  cassandra: "Cassandra",
  trino: "Trino",
  tidb: "TiDB",
};

/** A readable name for a Beekeeper Studio connection type. */
export function databaseName(connectionType: string | undefined): string {
  if (!connectionType) return "This database";
  return DATABASE_NAMES[connectionType] ?? connectionType;
}
