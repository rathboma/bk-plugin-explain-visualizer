import type { AnalyzePolicy, ExplainEngine, ParsedPlan, QueryResultLike } from "../types";
import { readsOnlyPolicy } from "../shared/analyzePolicy";
import { canParseMysqlPlan, extractPlanOutput, NOT_EXECUTABLE_MESSAGE, parseMysqlPlan } from "./parse";
import { capabilities, loadServerInfo, type MysqlServerInfo } from "./server";
import { inspectStatement } from "./statement";

export { parseMysqlPlan, extractPlanOutput } from "./parse";

const isSyntaxError = (e: unknown) => /error in your SQL syntax/i.test(String((e as Error)?.message ?? e));

/**
 * MySQL and MariaDB. Which EXPLAIN to send depends on the server:
 *
 * - MySQL 8.0.18+: EXPLAIN FORMAT=TREE, and EXPLAIN ANALYZE for actual times.
 *   Statements the tree can't show (single-table UPDATE and DELETE) fall back
 *   to FORMAT=JSON, and on MySQL 9, whose JSON can't show them either, to
 *   the classic table.
 * - MySQL 5.6 to 8.0.17: EXPLAIN FORMAT=JSON, estimates only.
 * - MariaDB 10.1+: EXPLAIN FORMAT=JSON, and ANALYZE FORMAT=JSON for actual
 *   times.
 * - Older servers: the classic tabular EXPLAIN.
 */
export const mysql: ExplainEngine = {
  id: "mysql",
  displayName: "MySQL",
  products: ["MySQL", "MariaDB"],
  connectionTypes: ["mysql", "mariadb"],
  supportsAnalyze: true,
  docsUrl: "https://dev.mysql.com/doc/refman/8.4/en/explain.html",
  pasteHint:
    "Paste the output of EXPLAIN FORMAT=TREE, EXPLAIN ANALYZE or EXPLAIN FORMAT=JSON, or MariaDB's ANALYZE FORMAT=JSON.",
  options: [],

  loadServerInfo,

  inspect: (sql, server) => inspectStatement(sql, server as MysqlServerInfo | undefined),

  analyzePolicy(statement, context): AnalyzePolicy {
    const server = context.server as MysqlServerInfo | undefined;
    const caps = capabilities(server);
    if (!caps.analyze) return { blocked: caps.noAnalyzeReason };
    if (statement.modifiesData) {
      // A transaction with a ROLLBACK after the statement is not safe here: if
      // the statement failed, the ROLLBACK would not run and the transaction
      // would stay open on a pooled connection that other tabs then use.
      return readsOnlyPolicy(statement, `${server?.productName ?? "MySQL"} would commit its changes.`);
    }
    if (caps.analyze === "mariadb-analyze" && context.readOnlyConnection) {
      return { blocked: "Read-only mode doesn't allow MariaDB's ANALYZE statement, so Explain Analyze isn't available on this connection." };
    }
    return {};
  },

  async explain(request, run) {
    const server = request.server as MysqlServerInfo | undefined;
    const caps = capabilities(server);
    if (server?.flavor === "tidb") throw new Error("TiDB plans are not supported yet.");
    const statement = request.statement.statement;

    const attempts: string[] = [];
    if (request.analyze) {
      if (!caps.analyze) throw new Error(caps.noAnalyzeReason);
      attempts.push(caps.analyze === "mariadb-analyze" ? `ANALYZE FORMAT=JSON ${statement}` : `EXPLAIN ANALYZE ${statement}`);
    } else {
      if (caps.tree) attempts.push(`EXPLAIN FORMAT=TREE ${statement}`);
      if (caps.json) attempts.push(`EXPLAIN FORMAT=JSON ${statement}`);
      // The classic table: the only plan MySQL 9 shows for single-table
      // UPDATE and DELETE, and all servers older than FORMAT=JSON have.
      if (server?.flavor !== "mariadb" || !caps.json) {
        attempts.push(caps.json && server?.flavor !== "mariadb" ? `EXPLAIN FORMAT=TRADITIONAL ${statement}` : `EXPLAIN ${statement}`);
      }
    }

    for (const [i, sql] of attempts.entries()) {
      const last = i === attempts.length - 1;
      let results: QueryResultLike[];
      try {
        results = await run(sql);
      } catch (e) {
        // A server of unknown version may not have the newer formats.
        if (!last && server?.version === undefined && isSyntaxError(e)) continue;
        throw e;
      }
      const table = results.find((r) => r.fields.some((f) => f.name.toLowerCase() === "select_type"));
      let parsed: ParsedPlan;
      try {
        parsed = parseMysqlPlan(table ?? extractPlanOutput(results));
      } catch (e) {
        // Single-table UPDATE and DELETE have no tree (nor, on MySQL 9, JSON):
        // an older format shows them.
        if (!last && (e as Error).message === NOT_EXECUTABLE_MESSAGE) continue;
        throw e;
      }
      parsed.plan.query = statement;
      return { ...parsed, sql };
    }
    throw new Error("The database did not return a query plan.");
  },

  canParse: canParseMysqlPlan,
  parse: parseMysqlPlan,
};
