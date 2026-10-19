/**
 * MySQL's iterator plans, the format of EXPLAIN FORMAT=TREE and EXPLAIN
 * ANALYZE (8.0.16+) and of FORMAT=JSON with explain_json_format_version=2
 * (8.3+). Both list the same iterators; this reads either into one shape.
 *
 *   -> Nested loop inner join  (cost=27125 rows=19980) (actual time=0.18..83.7 rows=16000 loops=1)
 *       -> Filter: (o.`status` = 'pending')  (cost=20132 rows=19980) (actual time=...)
 *           -> Table scan on o  (cost=20132 rows=199800) (actual time=...)
 */

export interface IteratorNode {
  /** The iterator's description, e.g. "Table scan on o". */
  operation: string;
  children: IteratorNode[];
  startupCost?: number;
  totalCost?: number;
  estimatedRows?: number;
  /** Per loop, like PostgreSQL: average time to the first and the last row. */
  firstRowMs?: number;
  lastRowMs?: number;
  actualRows?: number;
  loops?: number;
  neverExecuted?: boolean;
  /** JSON version 2 fields (table_name, index_name, condition...). */
  fields?: Record<string, unknown>;
}

/** Numbers print like "27125", "0.0154", "1.2e+6" or "377e-6". */
const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const COST = new RegExp(String.raw`^cost=(${NUMBER})(?:\.\.(${NUMBER}))? rows=(${NUMBER})$`, "i");
const ACTUAL = new RegExp(
  String.raw`^actual time=(${NUMBER})\.\.(${NUMBER}) rows=(${NUMBER}) loops=(${NUMBER})$`,
  "i"
);
/** A trailing "(cost=...)", "(actual time=...)" or "(never executed)" group. */
const TRAILING_GROUP = /\s*\((cost=[^()]*|actual time=[^()]*|never executed)\)\s*$/i;

export const NOT_EXECUTABLE = "<not executable by iterator executor>";

/** MySQL's answer for statements it can't show as a tree (single-table UPDATE and DELETE). */
export function isNotExecutable(value: unknown): boolean {
  return typeof value === "string" && /^(?:EXPLAIN:\s*)?(?:->\s*)?<not executable by iterator executor>$/.test(value.trim());
}

/** Whether text looks like tree output, optionally with the mysql client's "EXPLAIN: " label. */
export function looksLikeTree(text: string): boolean {
  return /^(?:EXPLAIN:\s*)?->\s/.test(text.trimStart()) || isNotExecutable(text);
}

function parseLine(text: string): IteratorNode {
  const node: IteratorNode = { operation: text, children: [] };
  let rest = text;
  for (;;) {
    const match = TRAILING_GROUP.exec(rest);
    if (!match) break;
    const group = match[1];
    const cost = COST.exec(group);
    const actual = ACTUAL.exec(group);
    if (cost) {
      // "cost=0.25 rows=1" before 8.0.20-ish, "cost=99..114 rows=330" (startup..total) after.
      node.startupCost = cost[2] !== undefined ? Number(cost[1]) : undefined;
      node.totalCost = Number(cost[2] ?? cost[1]);
      node.estimatedRows = Number(cost[3]);
    } else if (actual) {
      node.firstRowMs = Number(actual[1]);
      node.lastRowMs = Number(actual[2]);
      node.actualRows = Number(actual[3]);
      node.loops = Number(actual[4]);
    } else if (/^never executed$/i.test(group)) {
      node.neverExecuted = true;
      node.loops = 0;
      node.actualRows = 0;
    } else {
      break;
    }
    rest = rest.slice(0, match.index);
  }
  node.operation = rest.trim();
  return node;
}

/**
 * Parses tree text into its top-level iterators. There is usually one; a
 * subquery in the select list ("Select #2 (subquery in projection...)")
 * follows as another.
 */
export function parseTree(text: string): IteratorNode[] {
  const lines = text.replace(/^\s*EXPLAIN:\s*/, "").split(/\r?\n/);
  const roots: IteratorNode[] = [];
  const stack: { node: IteratorNode; indent: number }[] = [];
  let last: IteratorNode | undefined;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const match = /^(\s*)->\s?(.*)$/.exec(raw);
    if (!match) {
      // A condition with a line break in a string literal continues the line.
      if (last) Object.assign(last, parseLine(`${last.operation} ${raw.trim()}`), { children: last.children });
      continue;
    }
    const indent = match[1].length;
    const node = parseLine(match[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ node, indent });
    last = node;
  }

  if (!roots.length) throw new Error("This doesn't look like MySQL EXPLAIN output.");
  return roots;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Whether a JSON value is a version 2 plan (an iterator with "operation" and "inputs"). */
export function isJsonV2(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  // MySQL 9 puts the root iterator under "query_plan".
  const plan = obj["query_plan"];
  if (plan && typeof plan === "object") return typeof (plan as Record<string, unknown>)["operation"] === "string";
  return typeof obj["operation"] === "string" && ("access_type" in obj || "inputs" in obj || "query_type" in obj);
}

/** The root iterator of a version 2 plan. */
export function jsonV2Root(value: Record<string, unknown>): Record<string, unknown> {
  const plan = value["query_plan"];
  return plan && typeof plan === "object" ? (plan as Record<string, unknown>) : value;
}

/**
 * Reads a FORMAT=JSON version 2 plan into iterators, shaped like the tree
 * text: a subquery's "heading" ("Select #2 (subquery in condition...)") becomes
 * a node above it, and subqueries in the select list
 * (`inputs_from_select_list`) follow the main tree as more top-level nodes.
 */
export function fromJsonV2(top: Record<string, unknown>): IteratorNode[] {
  const value = jsonV2Root(top);
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const withHeading = (obj: Record<string, unknown>, top = false): IteratorNode => {
    const node = convert(obj, top);
    const heading = obj["heading"];
    return typeof heading === "string" ? { operation: heading, children: [node] } : node;
  };
  const convert = (obj: Record<string, unknown>, top: boolean): IteratorNode => {
    const { inputs, inputs_from_select_list: selectList, ...fields } = obj;
    const loops = num(obj["actual_loops"]);
    const node: IteratorNode = {
      operation: String(obj["operation"] ?? "Unknown"),
      // Only the outermost query's select list is measured separately.
      children: [...list(inputs), ...(top ? [] : list(selectList))].map((child) => withHeading(child)),
      startupCost: num(obj["estimated_first_row_cost"]),
      totalCost: num(obj["estimated_total_cost"]),
      estimatedRows: num(obj["estimated_rows"]),
      firstRowMs: num(obj["actual_first_row_ms"]),
      lastRowMs: num(obj["actual_last_row_ms"]),
      actualRows: num(obj["actual_rows"]),
      loops,
      fields,
    };
    // Iterators that never ran have "actual_loops": null (or 0) and no times.
    if (loops === 0 || ("actual_loops" in obj && obj["actual_loops"] === null)) {
      node.neverExecuted = true;
      node.loops = 0;
      node.actualRows = 0;
    }
    return node;
  };
  return [withHeading(value, true), ...list(value["inputs_from_select_list"]).map((child) => withHeading(child))];
}
