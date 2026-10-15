import { formatNumber } from "./format";
import { parentMap, type Insight, type InsightSeverity, type Plan, type PlanNode } from "./plan";

export interface Misestimate {
  /** How many times off the estimate was, always >= 1. */
  factor: number;
  direction: "under" | "over";
}

export interface NodeStats {
  /** Share of total execution time spent in this node alone (0..1). */
  timeShare?: number;
  /** Share of total cost attributed to this node alone (0..1). */
  costShare?: number;
  misestimate?: Misestimate;
  /** Rows flowing out of the node, actual when known, else estimated. */
  outputRows?: number;
}

export interface PlanStats {
  totalTime?: number;
  totalCost?: number;
  maxOutputRows: number;
  nodes: Map<number, NodeStats>;
  /** Nodes doing the most work, by self time (or self cost for estimates). */
  hottest: PlanNode[];
}

export function misestimate(node: PlanNode): Misestimate | undefined {
  const estimated = node.estimatedRows;
  const actual = node.actualRows;
  if (estimated === undefined || actual === undefined || node.neverExecuted) return undefined;
  const factor = Math.max(actual, estimated) / Math.max(Math.min(actual, estimated), 1);
  return { factor, direction: actual > estimated ? "under" : "over" };
}

export function planStats(plan: Plan): PlanStats {
  const totalTime = plan.root.inclusiveTime ?? plan.executionTime;
  const totalCost = plan.totalCost;
  const nodes = new Map<number, NodeStats>();
  let maxOutputRows = 0;

  for (const node of plan.nodes) {
    const outputRows = plan.analyzed
      ? node.totalActualRows ?? node.actualRows
      : node.estimatedRows !== undefined
        ? node.estimatedRows
        : undefined;
    if (outputRows !== undefined) maxOutputRows = Math.max(maxOutputRows, outputRows);
    nodes.set(node.id, {
      timeShare:
        totalTime && node.exclusiveTime !== undefined ? Math.min(1, node.exclusiveTime / totalTime) : undefined,
      costShare:
        totalCost && node.exclusiveCost !== undefined ? Math.min(1, node.exclusiveCost / totalCost) : undefined,
      misestimate: misestimate(node),
      outputRows,
    });
  }

  const weight = (n: PlanNode) => (plan.analyzed ? n.exclusiveTime : n.exclusiveCost) ?? 0;
  const hottest = [...plan.nodes]
    .filter((n) => weight(n) > 0)
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 5);

  return { totalTime, totalCost, maxOutputRows, nodes, hottest };
}

/** Ancestors that legitimately stop their inputs early, making over-estimates expected. */
function stopsEarly(node: PlanNode, parents: Map<number, PlanNode>): boolean {
  let current: PlanNode | undefined = node;
  while (current) {
    if (current.role === "SubPlan" || current.role === "InitPlan") return true;
    const parent = parents.get(current.id);
    if (!parent) return false;
    if (parent.kind === "limit" || /Semi|Anti/.test(parent.operation) || /^Merge\b.*\bJoin$/.test(parent.operation)) {
      return true;
    }
    current = parent;
  }
  return false;
}

export interface FinishOptions {
  /** Engine-specific advice appended to row estimate insights. */
  statisticsAdvice?: string;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Adds the insights every engine shares and orders them by severity. Engine
 * adapters call this once after building their plan.
 */
export function finishPlan(plan: Plan, options: FinishOptions = {}): Plan {
  const parents = parentMap(plan);

  for (const node of plan.nodes) {
    const m = misestimate(node);
    if (!m || m.factor < 10) continue;
    const biggest = Math.max(node.actualRows ?? 0, node.estimatedRows ?? 0) * Math.max(1, node.loops ?? 1);
    if (biggest < 100) continue;
    if (m.direction === "over" && stopsEarly(node, parents)) continue;

    const factor = formatNumber(Math.round(m.factor));
    const insight: Insight = {
      rule: "row-misestimate",
      severity: m.direction === "under" ? (m.factor >= 1000 ? "critical" : "warning") : "info",
      title: m.direction === "under" ? `Rows underestimated ${factor}×` : `Rows overestimated ${factor}×`,
      detail:
        `Estimated ${formatNumber(node.estimatedRows!)}, actual ${formatNumber(node.actualRows!)} per loop. ` +
        "Bad estimates lead the planner to pick join methods and memory sizes that do not fit the data." +
        (options.statisticsAdvice ? ` ${options.statisticsAdvice}` : ""),
      nodeId: node.id,
    };
    node.insights.push(insight);
  }

  for (const node of plan.nodes) {
    node.insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }
  plan.insights.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return plan;
}

/** Every insight in the plan, plan-wide ones first, then by severity. */
export function allInsights(plan: Plan): Insight[] {
  const nodeInsights = plan.nodes.flatMap((n) => n.insights);
  return [...plan.insights, ...nodeInsights].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}
