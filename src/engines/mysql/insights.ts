/**
 * Insights for MySQL and MariaDB plans. The three plan formats are converted
 * to the same operation names ("Table scan", "Filter", "Block nested loop"),
 * so the rules read the model, not the native output.
 */
import type { Insight, Plan, PlanNode } from "../../core/plan";
import { parentMap } from "../../core/plan";
import { formatMs, formatNumber } from "../../core/format";

type Draft = Omit<Insight, "nodeId">;

const raw = (node: PlanNode) => (node.raw ?? {}) as Record<string, unknown>;
const num = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const hasFilter = (node: PlanNode) => node.conditions.some((c) => c.label === "Filter");

/** Rows a table scan read in total, before its filter. */
function rowsRead(scan: PlanNode): number | undefined {
  // MariaDB counts rows read per loop separately from the rows kept.
  const perLoop = num(raw(scan)["r_rows"]);
  if (perLoop !== undefined) return perLoop * (scan.loops ?? 1);
  return scan.totalActualRows;
}

/** The scan and the rows its filter kept: a Filter above a scan (tree), or a scan with a filter (JSON). */
function filteredScan(node: PlanNode): { scan: PlanNode; kept: number | undefined; estimatedKept?: number } | undefined {
  if (node.kind === "filter" && node.children[0]?.operation === "Table scan") {
    return { scan: node.children[0], kept: node.totalActualRows, estimatedKept: node.estimatedRows };
  }
  if (node.operation === "Table scan" && hasFilter(node)) {
    return { scan: node, kept: node.totalActualRows, estimatedKept: node.estimatedRows };
  }
  return undefined;
}

/** Rules for single nodes. Each returns at most one insight. */
const RULES: ((node: PlanNode, plan: Plan, parent: PlanNode | undefined) => Draft | undefined)[] = [
  // A full table scan that throws most rows away is the classic missing index.
  (node, plan) => {
    const found = filteredScan(node);
    if (!found) return;
    if (plan.analyzed) {
      const read = rowsRead(found.scan);
      if (read === undefined || found.kept === undefined) return;
      const removed = read - found.kept;
      if (removed < 1000 || removed / read < 0.9) return;
      return {
        rule: "full-scan-filter",
        severity: "warning",
        title: "Full table scan discards most rows",
        detail: `${formatNumber(Math.round(removed))} rows (${Math.round((removed / read) * 100)}%) were read and then removed by the filter. An index on the filtered columns lets the server read only matching rows.`,
      };
    }
    // MySQL's JSON gives rows examined before the filter as a property; the
    // tree gives the scan's own estimate.
    const examined = num(raw(found.scan)["rows_examined_per_scan"]) ?? num(raw(found.scan)["rows"]) ?? found.scan.estimatedRows;
    const kept = found.estimatedKept;
    if (examined === undefined || kept === undefined || (found.scan === node && examined === kept)) return;
    if (examined < 10000 || kept / examined > 0.1001) return;
    return {
      rule: "full-scan-filter",
      severity: "info",
      title: "Full table scan, most rows filtered out",
      detail: `About ${formatNumber(Math.round(examined))} rows are expected to be read to keep ${formatNumber(Math.round(kept))}. An index on the filtered columns lets the server read only matching rows.`,
    };
  },

  // A table read in full once per row of a join or per run of a subquery.
  (node, plan) => {
    if (node.operation !== "Table scan" || !plan.analyzed) return;
    const loops = node.loops ?? 0;
    const read = rowsRead(node) ?? 0;
    if (loops < 100 || read < 10000) return;
    return {
      rule: "repeated-scan",
      severity: "warning",
      title: `Table scanned ${formatNumber(loops)} times`,
      detail: `${formatNumber(Math.round(read))} rows were read in total. The table is read in full once per row of the outer side of a join, or per run of a subquery. An index on the join or correlation columns usually fixes this.`,
    };
  },

  // A subquery that depends on the outer row runs once per row.
  (node, plan) => {
    if (node.kind !== "subquery") return;
    // MariaDB doesn't mark dependent subqueries, but runs them once per row.
    const dependent = /dependent/.test(node.description ?? "");
    const runs = node.loops ?? node.children.find((c) => c.loops !== undefined)?.loops;
    if (!dependent && (!plan.analyzed || node.role === "Outer" || node.role === "Inner")) return;
    if (!plan.analyzed) {
      return {
        rule: "dependent-subquery",
        severity: "info",
        title: "Subquery runs once per outer row",
        detail: "The subquery depends on the outer query's row, so it is evaluated again for every row. Rewriting it as a join often lets the optimizer do better.",
      };
    }
    if (!runs || runs < 100) return;
    const time = node.inclusiveTime;
    return {
      rule: "dependent-subquery",
      severity: time !== undefined && plan.root.inclusiveTime && time > plan.root.inclusiveTime * 0.2 ? "warning" : "info",
      title: `Dependent subquery ran ${formatNumber(runs)} times`,
      detail: `It runs once per row of the outer query${time !== undefined ? `, ${formatMs(time)} in total` : ""}. Rewriting it as a join, or an index on the columns it correlates on, usually helps.`,
    };
  },

  // Joins without a usable index compare rows in a buffer (MySQL 5.7, MariaDB).
  (node, plan) => {
    if (node.operation !== "Block nested loop") return;
    const [outer, inner] = node.children;
    const pairs = plan.analyzed
      ? (outer?.totalActualRows ?? 0) * (num(raw(inner ?? node)["r_rows"]) ?? inner?.actualRows ?? 0)
      : (outer?.estimatedRows ?? 0) * (num(raw(inner ?? node)["rows_examined_per_scan"]) ?? num(raw(inner ?? node)["rows"]) ?? 0);
    return {
      rule: "join-without-index",
      severity: pairs >= 1_000_000 ? "warning" : "info",
      title: "Join without an index",
      detail: `No index matches the join condition, so every row of ${inner?.target ?? "the inner table"} is compared with a buffer of rows from the other side${pairs ? ` (about ${formatNumber(Math.round(pairs))} comparisons)` : ""}. An index on the join columns lets the server look matching rows up instead.`,
    };
  },

  // Large sorts and temporary tables, where an index could provide the order.
  (node, plan) => {
    if (!plan.analyzed) return;
    const input = node.children.reduce((sum, c) => sum + (c.totalActualRows ?? 0), 0);
    if (input < 100_000) return;
    if (node.kind === "sort") {
      return {
        rule: "large-sort",
        severity: "info",
        title: `Sorted ${formatNumber(Math.round(input))} rows`,
        detail: "An index whose columns match the ORDER BY lets the server read rows already in order, and stop early with a LIMIT.",
      };
    }
    if (/temporary table/i.test(`${node.operation} ${node.description ?? ""}`) && node.kind === "aggregate") {
      return {
        rule: "temporary-table",
        severity: "info",
        title: `Grouped ${formatNumber(Math.round(input))} rows in a temporary table`,
        detail: "An index on the GROUP BY or DISTINCT columns lets the server group rows in order, without a temporary table.",
      };
    }
    return undefined;
  },
];

export function mysqlInsights(plan: Plan): void {
  const parents = parentMap(plan);
  for (const node of plan.nodes) {
    for (const rule of RULES) {
      const insight = rule(node, plan, parents.get(node.id));
      if (insight) node.insights.push({ ...insight, nodeId: node.id });
    }
  }

  const impossible = plan.nodes.find((n) =>
    /^Zero (input )?rows$/.test(n.operation) || /impossible|no matching row/i.test(`${n.operation} ${n.description ?? ""}`)
  );
  if (impossible) {
    plan.insights.push({
      rule: "no-rows",
      severity: "info",
      title: "No rows can match",
      detail: `The optimizer found that the statement returns nothing (${impossible.description ?? impossible.operation}), so no table was read.`,
    });
  }
}

/** Parents that stop reading early, which makes row over-estimates expected. */
export function mysqlStopsEarly(node: PlanNode, parent: PlanNode | undefined): boolean {
  if (!parent) return false;
  // EXISTS and IN subqueries stop at the first matching row.
  if (node.kind === "subquery" && (node.role === "Condition" || node.role === "Subquery" || /in condition/.test(node.description ?? ""))) {
    return true;
  }
  return /semijoin|antijoin|semi join|anti join|first match/i.test(`${parent.operation} ${parent.description ?? ""}`);
}
