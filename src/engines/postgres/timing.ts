import { walk, type Plan, type PlanNode } from "../../core/plan";
import type { PgNode } from "./nodeTypes";

const raw = (node: PlanNode) => (node.raw ?? {}) as PgNode;

/** Number of processes running a node below a Gather. */
function processCount(gather: PlanNode): number {
  const r = raw(gather);
  if (r["Single Copy"] === true) return 1;
  const launched = r["Workers Launched"] ?? r["Workers Planned"];
  return (typeof launched === "number" ? launched : 0) + 1;
}

/**
 * Inclusive wall-clock time for every node.
 *
 * PostgreSQL reports `Actual Total Time` as an average per loop, so the time
 * spent overall is time × loops. Below a Gather, loops are summed across the
 * worker processes, which run at the same time, so dividing by the number of
 * processes gives the wall-clock time again.
 */
function computeInclusive(node: PlanNode, processes: number): void {
  if (node.actualTotalTime !== undefined && node.loops !== undefined) {
    const divisor = node.loops > 0 ? Math.max(1, Math.min(processes, node.loops)) : 1;
    node.inclusiveTime = (node.actualTotalTime * node.loops) / divisor;
    if (node.actualRows !== undefined) node.totalActualRows = node.actualRows * node.loops;
  }
  const isGather = raw(node)["Node Type"] === "Gather" || raw(node)["Node Type"] === "Gather Merge";
  const childProcesses = isGather ? processCount(node) : processes;
  for (const child of node.children) computeInclusive(child, childProcesses);
}

const isCte = (node: PlanNode) => node.subplanName?.startsWith("CTE ") ?? false;

/**
 * Text that refers to an InitPlan's output: "(InitPlan 1)" since PostgreSQL
 * 16, "$0" (the parameters in "InitPlan 1 (returns $0)") before that.
 */
function initPlanReferences(node: PlanNode): RegExp[] {
  const match = /^InitPlan (\d+)(?: \(returns ([^)]*)\))?/.exec(node.subplanName ?? "");
  if (!match) return [];
  const patterns = [new RegExp(`\\bInitPlan ${match[1]}\\b`)];
  for (const param of (match[2] ?? "").split(",")) {
    const p = param.trim();
    if (/^\$\d+$/.test(p)) patterns.push(new RegExp(`\\${p}(?!\\d)`));
  }
  return patterns;
}

function references(node: PlanNode, patterns: RegExp[]): boolean {
  return node.conditions.some((c) => patterns.some((p) => p.test(c.expression)));
}

/**
 * Finds the node that evaluates an InitPlan. Its time is included in that
 * node's time, which may be a descendant of the parent it is attached to.
 */
function initPlanEvaluator(parent: PlanNode, initPlan: PlanNode): PlanNode {
  const patterns = initPlanReferences(initPlan);
  if (!patterns.length || references(parent, patterns)) return parent;
  let evaluator: PlanNode | undefined;
  const search = (node: PlanNode) => {
    if (evaluator || node === initPlan) return;
    if (node !== parent && references(node, patterns)) {
      evaluator = node;
      return;
    }
    node.children.forEach(search);
  };
  search(parent);
  return evaluator ?? parent;
}

/**
 * Exclusive ("self") time: a node's inclusive time minus the time of the
 * work it delegated. Two PostgreSQL details matter here:
 *
 * - A CTE runs as rows are pulled from it, so its time is already part of
 *   the CTE Scan nodes reading it. It is charged to those scans (largest
 *   first) instead of to the node the CTE is attached to.
 * - An InitPlan's time is part of whichever node evaluates it, which is not
 *   always the node it is attached to.
 */
export function computeTimings(plan: Plan): void {
  if (!plan.analyzed) return;
  computeInclusive(plan.root, 1);

  const delegated = new Map<number, number>();
  const charge = (node: PlanNode, time: number | undefined) => {
    if (!time) return;
    delegated.set(node.id, (delegated.get(node.id) ?? 0) + time);
  };

  const ctes: PlanNode[] = [];
  walk(plan.root, (node) => {
    for (const child of node.children) {
      if (isCte(child)) {
        ctes.push(child);
      } else if (child.role === "InitPlan") {
        charge(initPlanEvaluator(node, child), child.inclusiveTime);
      } else {
        charge(node, child.inclusiveTime);
      }
    }
  });

  for (const cte of ctes) {
    const name = cte.subplanName!.slice(4);
    const scans = plan.nodes
      .filter((n) => raw(n)["Node Type"] === "CTE Scan" && raw(n)["CTE Name"] === name)
      .sort((a, b) => (b.inclusiveTime ?? 0) - (a.inclusiveTime ?? 0));
    let remaining = cte.inclusiveTime ?? 0;
    for (const scan of scans) {
      const share = Math.min(remaining, scan.inclusiveTime ?? 0);
      charge(scan, share);
      remaining -= share;
    }
  }

  for (const node of plan.nodes) {
    if (node.inclusiveTime === undefined) continue;
    node.exclusiveTime = Math.max(0, node.inclusiveTime - (delegated.get(node.id) ?? 0));
  }
}
