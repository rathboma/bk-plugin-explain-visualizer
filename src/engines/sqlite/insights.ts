/**
 * Insights for SQLite plans. SQLite reports no numbers, so these come from
 * the shape of the plan: which tables are read without an index, and where.
 */
import type { Insight, Plan, PlanNode } from "../../core/plan";
import { parentMap } from "../../core/plan";

type Draft = Omit<Insight, "nodeId">;

const isFullScan = (node: PlanNode) => node.kind === "scan" && (node.operation === "Scan" || node.operation === "Search");
const isInnerLoop = (node: PlanNode) => /^Inner loop/.test(node.role ?? "");

/** Column names in a constraint such as "(price=? AND qty>?)". */
function columns(constraint: string | undefined): string[] {
  return [...(constraint ?? "").matchAll(/([A-Za-z_][\w$]*)\s*(?:=|<|>|IS\b|IN\b)/g)].map((m) => m[1]);
}

const RULES: ((node: PlanNode, ancestors: PlanNode[]) => Draft | undefined)[] = [
  (node) => {
    if (node.operation !== "Automatic index search") return;
    const cols = columns(node.conditions[0]?.expression);
    return {
      rule: "automatic-index",
      severity: "warning",
      title: "Temporary index built on every run",
      detail: `No index matches the lookup on ${node.target ?? "this table"}, so SQLite builds one${cols.length ? ` on ${cols.join(", ")}` : ""} each time the statement runs. A permanent index on ${cols.length ? "those columns" : "the lookup columns"} avoids it.`,
    };
  },

  // A table read in full inside a loop or a correlated subquery.
  (node, ancestors) => {
    if (!isFullScan(node)) return;
    const correlated = ancestors.find((a) => a.kind === "subquery" && a.operation.startsWith("Correlated"));
    if (isInnerLoop(node)) {
      return {
        rule: "repeated-scan",
        severity: "warning",
        title: "Table scanned for every outer row",
        detail: `${node.target ?? "The table"} is read in full once per row of the loops before it. An index on its join columns lets SQLite look the matching rows up instead.`,
      };
    }
    if (correlated) {
      return {
        rule: "repeated-scan",
        severity: "warning",
        title: "Correlated subquery reads the whole table",
        detail: `${node.target ?? "The table"} is read in full each time the subquery runs, once per row of the outer query. An index on the columns the subquery filters on avoids it.`,
      };
    }
    return undefined;
  },

  (node) => {
    if (!node.description?.startsWith("temporary B-tree")) return;
    if (node.kind === "sort") {
      return {
        rule: "temp-b-tree",
        severity: "info",
        title: "Sorted in a temporary B-tree",
        detail: "SQLite collects the rows and sorts them. An index whose columns match the ORDER BY lets it read rows already in order, and stop early with a LIMIT.",
      };
    }
    if (node.kind === "aggregate") {
      const what = node.operation === "Group" ? "GROUP BY" : "DISTINCT";
      return {
        rule: "temp-b-tree",
        severity: "info",
        title: `${what} uses a temporary B-tree`,
        detail: `An index on the ${what} columns lets SQLite read rows in groups instead of collecting them first.`,
      };
    }
    return undefined;
  },

  (node) => {
    if (node.kind !== "subquery" || !node.operation.startsWith("Correlated")) return;
    return {
      rule: "correlated-subquery",
      severity: "info",
      title: "Subquery runs once per outer row",
      detail: "It depends on the outer query's row, so SQLite runs it again for every row. Rewriting it as a join can let SQLite pick a better plan.",
    };
  },
];

export function sqliteInsights(plan: Plan): void {
  const parents = parentMap(plan);
  for (const node of plan.nodes) {
    const ancestors: PlanNode[] = [];
    for (let p = parents.get(node.id); p; p = parents.get(p.id)) ancestors.push(p);
    for (const rule of RULES) {
      const insight = rule(node, ancestors);
      if (insight) node.insights.push({ ...insight, nodeId: node.id });
    }
  }
}
