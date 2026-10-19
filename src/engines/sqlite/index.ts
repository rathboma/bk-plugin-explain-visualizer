import type { ExplainEngine, ServerInfo } from "../types";
import { rowsByName } from "../shared/results";
import { canParseSqlitePlan, parseSqlitePlan } from "./parse";
import { inspectStatement } from "./statement";

export { parseSqlitePlan } from "./parse";

/**
 * SQLite, and LibSQL which shares its planner. EXPLAIN QUERY PLAN shows the
 * steps without running anything; SQLite has no way to measure them from
 * SQL, so there is no Explain Analyze.
 */
export const sqlite: ExplainEngine = {
  id: "sqlite",
  displayName: "SQLite",
  connectionTypes: ["sqlite", "libsql"],
  supportsAnalyze: false,
  docsUrl: "https://www.sqlite.org/eqp.html",
  pasteHint: "Paste the output of EXPLAIN QUERY PLAN: the sqlite3 shell's tree, or the id, parent and detail columns.",
  options: [],

  async loadServerInfo(run): Promise<ServerInfo> {
    const results = await run("SELECT sqlite_version() AS version");
    const version = results[0] ? rowsByName(results[0])[0]?.["version"] : undefined;
    const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
    if (!match) throw new Error("Unexpected server version response.");
    const [major, minor, patch] = match.slice(1).map(Number);
    return { version: major * 1_000_000 + minor * 1000 + patch, versionLabel: `${major}.${minor}.${patch}` };
  },

  inspect: (sql) => inspectStatement(sql),

  analyzePolicy: () => ({ blocked: "SQLite can't measure the steps of a plan. Explain shows them." }),

  async explain(request, run) {
    const statement = request.statement.statement;
    const sql = `EXPLAIN QUERY PLAN ${statement}`;
    const results = await run(sql);
    // No rows (and, from Beekeeper Studio, no columns either) when the
    // statement reads no tables: a plan without steps.
    const result = results.find((r) => r.fields.some((f) => f.name.toLowerCase() === "detail")) ?? { fields: [], rows: [] };
    const parsed = parseSqlitePlan(result);
    parsed.plan.query = statement;
    return { ...parsed, sql };
  },

  canParse: canParseSqlitePlan,
  parse: parseSqlitePlan,
};
