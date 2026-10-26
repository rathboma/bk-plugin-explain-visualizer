/**
 * Derived metrics most engines compute the same way. Adapters call these
 * after building their tree, or write their own when the engine's semantics
 * differ (PostgreSQL's CTEs and InitPlans, MariaDB's per-table timers).
 */
import type { Plan, PlanNode } from "./plan";

/** Cost of each node alone: its total cost minus its children's. */
export function computeExclusiveCosts(node: PlanNode): void {
  for (const child of node.children) computeExclusiveCosts(child);
  if (node.totalCost === undefined) return;
  const childCost = node.children.reduce((sum, c) => sum + (c.totalCost ?? 0), 0);
  node.exclusiveCost = Math.max(0, node.totalCost - childCost);
}

export interface LoopTimingRules {
  /**
   * Children the parent's measurement does not include, such as MySQL's
   * subqueries in the select list. They add to the parent's total time
   * instead of being taken out of its self time.
   */
  measuredSeparately?(child: PlanNode, parent: PlanNode): boolean;
}

/**
 * Inclusive and self time for engines that report, per node, an average time
 * and row count per loop plus the number of loops (MySQL's EXPLAIN ANALYZE):
 * the time spent overall is time × loops, and a node's self time is that
 * minus its children's. A step without its own measurement (MySQL's "Hash")
 * passes its children's time on.
 */
export function computeLoopTimings(plan: Plan, rules: LoopTimingRules = {}): void {
  if (!plan.analyzed) return;
  const visit = (node: PlanNode): number | undefined => {
    let children = 0;
    let separate = 0;
    let timedChildren = false;
    for (const child of node.children) {
      const time = visit(child);
      if (time === undefined) continue;
      timedChildren = true;
      children += time;
      if (rules.measuredSeparately?.(child, node)) separate += time;
    }
    if (node.actualRows !== undefined && node.loops !== undefined) node.totalActualRows = node.actualRows * node.loops;
    if (node.actualTotalTime !== undefined && node.loops !== undefined) {
      node.inclusiveTime = node.actualTotalTime * node.loops + separate;
    } else if (node.neverExecuted) {
      node.inclusiveTime = 0;
    } else if (timedChildren) {
      node.inclusiveTime = children;
    }
    if (node.inclusiveTime !== undefined) node.exclusiveTime = Math.max(0, node.inclusiveTime - children);
    return node.inclusiveTime;
  };
  visit(plan.root);
}

/**
 * For engines that time some nodes as a whole (`actualTotalTime` × `loops`,
 * like MariaDB's query blocks) and others on their own (`exclusiveTime`, like
 * its tables): fills in the rest, so every timed node has both.
 */
export function computeMixedTimings(plan: Plan): void {
  if (!plan.analyzed) return;
  const visit = (node: PlanNode): number | undefined => {
    let children = 0;
    let timedChildren = false;
    for (const child of node.children) {
      const time = visit(child);
      if (time === undefined) continue;
      timedChildren = true;
      children += time;
    }
    if (node.actualRows !== undefined && node.loops !== undefined) node.totalActualRows = node.actualRows * node.loops;
    if (node.actualTotalTime !== undefined && node.loops !== undefined) {
      // Timers are not perfectly nested; never report less than the children took.
      node.inclusiveTime = Math.max(node.actualTotalTime * node.loops, children);
      node.exclusiveTime = node.inclusiveTime - children;
    } else if (node.exclusiveTime !== undefined) {
      node.inclusiveTime = node.exclusiveTime + children;
    } else if (timedChildren) {
      node.inclusiveTime = children;
      node.exclusiveTime = 0;
    }
    return node.inclusiveTime;
  };
  visit(plan.root);
}
