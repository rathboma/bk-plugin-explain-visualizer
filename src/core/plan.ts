/**
 * Engine-agnostic execution plan model.
 *
 * Every database engine adapter (see `src/engines`) converts its native
 * EXPLAIN output into this shape. The UI only ever reads this model, so adding
 * a new database means writing an adapter, not touching components.
 *
 * All metrics are optional because engines expose very different data:
 * PostgreSQL gives costs, rows and timings; SQLite's EXPLAIN QUERY PLAN only
 * gives a tree of text details; SQL Server gives per-operator costs and actual
 * row counts, and so on.
 */

/** Connection types as reported by Beekeeper Studio's `getConnectionInfo()`. */
export type EngineId = string;

/**
 * Broad operation category. Used for icons, colours and generic insights, so
 * adapters should map their native operator names onto the closest kind.
 */
export type NodeKind =
  | "scan" // reads a whole table / heap
  | "index" // index scan, seek or lookup
  | "join"
  | "aggregate"
  | "sort"
  | "limit"
  | "materialize" // hash, materialize, memoize, spool, temp b-tree
  | "set" // append, union, intersect, except
  | "subquery" // subquery scan, CTE scan, function scan, values
  | "modify" // insert, update, delete, merge
  | "parallel" // gather, exchange, repartition streams
  | "other";

export type ValueFormat =
  | "ms"
  | "rows"
  | "cost"
  | "bytes"
  | "kilobytes"
  | "blocks"
  | "number"
  | "percent"
  | "text"
  | "code";

export type PropertyValue = string | number | boolean | null;

/** A labelled value shown in the node details panel. */
export interface Property {
  /** Group heading in the details panel, e.g. "Buffers" or "Workers". */
  group: string;
  label: string;
  value: PropertyValue;
  format?: ValueFormat;
}

/** An expression attached to a node: filter, join condition, sort key... */
export interface Condition {
  label: string;
  expression: string;
}

export type InsightSeverity = "info" | "warning" | "critical";

/** Something worth pointing out to the user about a node or the whole plan. */
export interface Insight {
  /** Stable identifier of the rule that produced it, e.g. `row-misestimate`. */
  rule: string;
  severity: InsightSeverity;
  title: string;
  detail?: string;
  /** Node the insight is about. Omitted for plan-wide insights. */
  nodeId?: number;
}

export interface PlanNode {
  /** Sequential id in pre-order, starting at 0 for the root. */
  id: number;
  /** Operator name, e.g. "Seq Scan", "Hash Join", "SCAN orders". */
  operation: string;
  kind: NodeKind;
  /** Relation the node reads from or writes to, e.g. "public.orders o". */
  target?: string;
  /** Index used, if any. */
  index?: string;
  /** Short secondary description, e.g. "Inner", "Hashed", "Parallel". */
  description?: string;
  /** How the node relates to its parent, e.g. "Outer", "Inner", "InitPlan". */
  role?: string;
  /** Name of the subplan this node starts, e.g. "CTE totals" or "SubPlan 1". */
  subplanName?: string;

  // Planner estimates (per execution / loop).
  startupCost?: number;
  totalCost?: number;
  estimatedRows?: number;
  estimatedWidth?: number;

  // Runtime measurements, only when the plan was analyzed. Times are in
  // milliseconds and, like rows, are averages per loop.
  actualStartupTime?: number;
  actualTotalTime?: number;
  actualRows?: number;
  loops?: number;
  /** The node was never executed (e.g. the other side of a join was empty). */
  neverExecuted?: boolean;

  // Derived by the adapter (it knows the engine's timing semantics) and then
  // used by the generic analysis.
  /** Inclusive wall-clock time spent in this node and its children, in ms. */
  inclusiveTime?: number;
  /** Time spent in this node alone, in ms. */
  exclusiveTime?: number;
  /** Cost of this node alone (total cost minus children's total cost). */
  exclusiveCost?: number;
  /** Total rows produced across all loops. */
  totalActualRows?: number;

  conditions: Condition[];
  properties: Property[];
  insights: Insight[];
  children: PlanNode[];
  /** The engine's untouched node object, shown in the "Raw" section. */
  raw?: unknown;
}

export interface Plan {
  engine: EngineId;
  /** Format the plan was parsed from, e.g. "json" or "text". */
  sourceFormat: string;
  /** True when the plan contains runtime measurements (EXPLAIN ANALYZE). */
  analyzed: boolean;
  root: PlanNode;
  /** All nodes in pre-order, `nodes[n.id] === n`. */
  nodes: PlanNode[];
  planningTime?: number;
  executionTime?: number;
  /** Cost of the root node. */
  totalCost?: number;
  /** Plan-wide values: triggers, JIT, settings... */
  properties: Property[];
  insights: Insight[];
  /** The statement that was explained, when known. */
  query?: string;
}

/** Shape adapters return before ids are assigned and analysis runs. */
export type DraftNode = Omit<PlanNode, "id" | "children" | "insights"> & {
  children: DraftNode[];
  insights?: Insight[];
};

export function walk(
  node: PlanNode,
  visit: (node: PlanNode, parent: PlanNode | undefined, depth: number) => void,
  parent?: PlanNode,
  depth = 0
): void {
  visit(node, parent, depth);
  for (const child of node.children) walk(child, visit, node, depth + 1);
}

/** Assigns pre-order ids and returns the finished node tree plus flat list. */
export function finalizeTree(draft: DraftNode): { root: PlanNode; nodes: PlanNode[] } {
  const nodes: PlanNode[] = [];
  const build = (d: DraftNode): PlanNode => {
    const node: PlanNode = { ...d, id: nodes.length, insights: d.insights ?? [], children: [] };
    nodes.push(node);
    node.children = d.children.map(build);
    return node;
  };
  const root = build(draft);
  return { root, nodes };
}

export function parentMap(plan: Plan): Map<number, PlanNode> {
  const parents = new Map<number, PlanNode>();
  walk(plan.root, (node, parent) => {
    if (parent) parents.set(node.id, parent);
  });
  return parents;
}
