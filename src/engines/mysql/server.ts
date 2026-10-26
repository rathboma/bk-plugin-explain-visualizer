import type { RunQuery, ServerInfo } from "../types";
import { rowsByName } from "../shared/results";

/** MySQL-compatible servers explain plans in different ways. */
export type MysqlFlavor = "mysql" | "mariadb" | "tidb";

/** What the MySQL engine learns about its server. */
export interface MysqlServerInfo extends ServerInfo {
  flavor: MysqlFlavor;
  /** sql_mode has NO_BACKSLASH_ESCAPES: backslashes are plain characters in strings. */
  noBackslashEscapes?: boolean;
  /** sql_mode has ANSI_QUOTES: "..." is an identifier, not a string. */
  ansiQuotes?: boolean;
}

const PRODUCT: Record<MysqlFlavor, string> = { mysql: "MySQL", mariadb: "MariaDB", tidb: "TiDB" };

/** Versions as one number, the way MySQL's /*!80018 comments write them: 8.0.18 is 80018. */
export const version = (major: number, minor: number, patch = 0) => major * 10000 + minor * 100 + patch;

/** Reads `SELECT VERSION()` and `@@sql_mode`, e.g. "10.6.18-MariaDB-1:10.6.18+maria~ubu2004". */
export function parseServerInfo(versionString: string, sqlMode = ""): MysqlServerInfo {
  const flavor: MysqlFlavor = /mariadb/i.test(versionString) ? "mariadb" : /tidb/i.test(versionString) ? "tidb" : "mysql";
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionString);
  const modes = sqlMode.toUpperCase().split(",");
  const info: MysqlServerInfo = {
    flavor,
    productName: PRODUCT[flavor],
    noBackslashEscapes: modes.includes("NO_BACKSLASH_ESCAPES"),
    ansiQuotes: modes.includes("ANSI_QUOTES") || modes.includes("ANSI"),
  };
  if (match) {
    const [major, minor, patch] = match.slice(1).map(Number);
    info.version = version(major, minor, patch);
    info.versionLabel = `${major}.${minor}.${patch}`;
  }
  // TiDB reports the MySQL version it is compatible with first.
  const tidb = /TiDB-v(\d+\.\d+\.\d+)/i.exec(versionString);
  if (flavor === "tidb" && tidb) info.versionLabel = tidb[1];
  return info;
}

export async function loadServerInfo(run: RunQuery): Promise<MysqlServerInfo> {
  // A SELECT, which Beekeeper Studio's read-only mode allows.
  const results = await run("SELECT VERSION() AS version, @@sql_mode AS sql_mode");
  const row = results[0] ? rowsByName(results[0])[0] : undefined;
  if (!row || typeof row["version"] !== "string") throw new Error("Unexpected server version response.");
  return parseServerInfo(row["version"], typeof row["sql_mode"] === "string" ? row["sql_mode"] : "");
}

/** How a server is asked for plans. */
export interface Capabilities {
  /** EXPLAIN FORMAT=TREE with costs and row estimates (MySQL 8.0.18+). */
  tree: boolean;
  /** EXPLAIN FORMAT=JSON (MySQL 5.6.5+, MariaDB 10.1+). Without it, only the classic table. */
  json: boolean;
  /** How Explain Analyze runs, if the server has it. */
  analyze?: "explain-analyze" | "mariadb-analyze";
  /** Why Explain Analyze is not available. */
  noAnalyzeReason?: string;
}

/**
 * MySQL 5.6.5 added FORMAT=JSON, 8.0.16 the tree format, and 8.0.18 the
 * tree's costs and EXPLAIN ANALYZE. MariaDB has FORMAT=JSON and ANALYZE
 * FORMAT=JSON since 10.1. An unknown server is treated as a current MySQL,
 * and the engine falls back to older formats if the server refuses one.
 */
export function capabilities(server: MysqlServerInfo | undefined): Capabilities {
  if (!server || server.version === undefined) return { tree: true, json: true, analyze: "explain-analyze" };
  if (server.flavor === "tidb") return { tree: false, json: false, noAnalyzeReason: "TiDB plans are not supported yet." };
  if (server.flavor === "mariadb") {
    return server.version >= version(10, 1)
      ? { tree: false, json: true, analyze: "mariadb-analyze" }
      : { tree: false, json: false, noAnalyzeReason: "Explain Analyze needs MariaDB 10.1 or later." };
  }
  if (server.version >= version(8, 0, 18)) return { tree: true, json: true, analyze: "explain-analyze" };
  return {
    tree: false,
    json: server.version >= version(5, 6, 5),
    noAnalyzeReason: "Explain Analyze needs MySQL 8.0.18 or later.",
  };
}
