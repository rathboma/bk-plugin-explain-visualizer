import {
  finalizeTree,
  type Condition,
  type DraftNode,
  type Plan,
  type PlanNode,
  type Property,
  type ValueFormat,
} from "../../core/plan";
import { displayName, nodeKind, targetName, type PgNode } from "./nodeTypes";
import { computeTimings } from "./timing";
import { postgresInsights } from "./insights";
import { finishPlan } from "../../core/analysis";

/** Keys shown as highlighted expressions rather than plain properties. */
const CONDITION_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "TID Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Filter",
  "One-Time Filter",
  "Run Condition",
  "Order By",
  "Sort Key",
  "Presorted Key",
  "Group Key",
  "Cache Key",
  "Hash Key",
  "Conflict Filter",
  "Conflict Arbiter Indexes",
  "Function Call",
  "Table Function Call",
  "Sampling Method",
  "Sampling Parameters",
  "Repeatable Seed",
  "Output",
];

/** Keys the model stores in dedicated fields, so they're not repeated. */
const MODELLED_KEYS = new Set([
  "Plans",
  "Node Type",
  "Startup Cost",
  "Total Cost",
  "Plan Rows",
  "Plan Width",
  "Actual Startup Time",
  "Actual Total Time",
  "Actual Rows",
  "Actual Loops",
  "Parent Relationship",
  "Subplan Name",
  "Workers",
  "Grouping Sets",
]);

type Spec = { group: string; format?: ValueFormat; label?: string };

const BUFFER_KEYS = [
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Shared Dirtied Blocks",
  "Shared Written Blocks",
  "Local Hit Blocks",
  "Local Read Blocks",
  "Local Dirtied Blocks",
  "Local Written Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
];
const IO_TIME_KEYS = [
  "I/O Read Time",
  "I/O Write Time",
  "Shared I/O Read Time",
  "Shared I/O Write Time",
  "Local I/O Read Time",
  "Local I/O Write Time",
  "Temp I/O Read Time",
  "Temp I/O Write Time",
];

/** How known keys are grouped and formatted in the details panel. */
const SPECS: Record<string, Spec> = {
  "Relation Name": { group: "Node", label: "Relation" },
  Schema: { group: "Node" },
  Alias: { group: "Node" },
  "Index Name": { group: "Node", label: "Index" },
  "CTE Name": { group: "Node", label: "CTE" },
  "Function Name": { group: "Node", label: "Function" },
  "Join Type": { group: "Node" },
  "Inner Unique": { group: "Node" },
  Strategy: { group: "Node" },
  "Partial Mode": { group: "Node" },
  Operation: { group: "Node" },
  Command: { group: "Node" },
  "Scan Direction": { group: "Node" },
  "Parallel Aware": { group: "Node" },
  "Async Capable": { group: "Node" },
  Disabled: { group: "Node" },
  "Custom Plan Provider": { group: "Node" },

  "Rows Removed by Filter": { group: "Rows", format: "rows" },
  "Rows Removed by Index Recheck": { group: "Rows", format: "rows" },
  "Rows Removed by Join Filter": { group: "Rows", format: "rows" },
  "Rows Removed by Conflict Filter": { group: "Rows", format: "rows" },
  "Heap Fetches": { group: "Rows", format: "number" },
  "Exact Heap Blocks": { group: "Rows", format: "blocks" },
  "Lossy Heap Blocks": { group: "Rows", format: "blocks" },
  "Index Searches": { group: "Rows", format: "number" },
  "Subplans Removed": { group: "Rows", format: "number" },
  "Tuples Inserted": { group: "Rows", format: "rows" },
  "Conflicting Tuples": { group: "Rows", format: "rows" },

  "Sort Method": { group: "Memory & Disk" },
  "Sort Space Used": { group: "Memory & Disk", format: "kilobytes" },
  "Sort Space Type": { group: "Memory & Disk" },
  "Hash Buckets": { group: "Memory & Disk", format: "number" },
  "Original Hash Buckets": { group: "Memory & Disk", format: "number" },
  "Hash Batches": { group: "Memory & Disk", format: "number" },
  "Original Hash Batches": { group: "Memory & Disk", format: "number" },
  "HashAgg Batches": { group: "Memory & Disk", format: "number" },
  "Planned Partitions": { group: "Memory & Disk", format: "number" },
  "Peak Memory Usage": { group: "Memory & Disk", format: "kilobytes" },
  "Disk Usage": { group: "Memory & Disk", format: "kilobytes" },
  "Cache Mode": { group: "Memory & Disk" },
  "Cache Hits": { group: "Memory & Disk", format: "number" },
  "Cache Misses": { group: "Memory & Disk", format: "number" },
  "Cache Evictions": { group: "Memory & Disk", format: "number" },
  "Cache Overflows": { group: "Memory & Disk", format: "number" },
  "Storage": { group: "Memory & Disk" },
  "Maximum Storage": { group: "Memory & Disk", format: "kilobytes" },

  "Workers Planned": { group: "Workers", format: "number" },
  "Workers Launched": { group: "Workers", format: "number" },
  "Single Copy": { group: "Workers" },

  "WAL Records": { group: "WAL", format: "number" },
  "WAL FPI": { group: "WAL", format: "number", label: "WAL Full Page Images" },
  "WAL Bytes": { group: "WAL", format: "bytes" },
  "WAL Buffers Full": { group: "WAL", format: "number" },
};
for (const key of BUFFER_KEYS) SPECS[key] = { group: "Buffers", format: "blocks" };
for (const key of IO_TIME_KEYS) SPECS[key] = { group: "Buffers", format: "ms" };

/**
 * Counters that PostgreSQL's text format leaves out when they are zero. JSON
 * always includes them; hiding the zeros keeps the details panel readable.
 */
const HIDDEN_WHEN_ZERO = new Set([
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  "Rows Removed by Join Filter",
  "Rows Removed by Conflict Filter",
  "Exact Heap Blocks",
  "Lossy Heap Blocks",
  "Disk Usage",
  "Planned Partitions",
  "Subplans Removed",
  ...BUFFER_KEYS,
  ...IO_TIME_KEYS,
  "WAL Records",
  "WAL FPI",
  "WAL Bytes",
  "WAL Buffers Full",
]);

/** Flags only worth showing when they are set. */
const FLAGS = new Set(["Single Copy", "Parallel Aware", "Async Capable", "Inner Unique", "Disabled"]);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function stringify(value: unknown): string {
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toPropertyValue(value: unknown): Property["value"] | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  return stringify(value);
}

/** Properties for a set of keys from a node (or the plan's "Planning" block). */
export function collectProperties(source: Record<string, unknown>, fallbackGroup: string): Property[] {
  const props: Property[] = [];
  for (const [key, raw] of Object.entries(source)) {
    if (MODELLED_KEYS.has(key) || CONDITION_KEYS.includes(key)) continue;
    const value = toPropertyValue(raw);
    if (value === undefined) continue;
    if (value === 0 && HIDDEN_WHEN_ZERO.has(key)) continue;
    // Defaults the text format leaves out as well.
    if (key === "Partial Mode" && value === "Simple") continue;
    if (value === false && FLAGS.has(key)) continue;
    if (key === "Original Hash Buckets" && value === source["Hash Buckets"]) continue;
    if (key === "Original Hash Batches" && value === source["Hash Batches"]) continue;
    const spec = SPECS[key];
    props.push({
      group: spec?.group ?? fallbackGroup,
      label: spec?.label ?? key,
      value,
      format: spec?.format ?? (typeof value === "number" ? "number" : "text"),
    });
  }
  return props;
}

function workerProperties(node: PgNode): Property[] {
  const workers = node["Workers"];
  if (!Array.isArray(workers)) return [];
  const props: Property[] = [];
  for (const worker of workers as Record<string, unknown>[]) {
    const label = `Worker ${worker["Worker Number"] ?? props.length}`;
    const parts: string[] = [];
    const time = num(worker["Actual Total Time"]);
    if (time !== undefined) parts.push(`time=${time} ms`);
    const rows = num(worker["Actual Rows"]);
    if (rows !== undefined) parts.push(`rows=${rows}`);
    const loops = num(worker["Actual Loops"]);
    if (loops !== undefined) parts.push(`loops=${loops}`);
    if (worker["Sort Method"]) {
      parts.push(`sort=${worker["Sort Method"]} ${worker["Sort Space Used"] ?? "?"}kB ${worker["Sort Space Type"] ?? ""}`.trim());
    }
    if (worker["Peak Memory Usage"] !== undefined) parts.push(`memory=${worker["Peak Memory Usage"]}kB`);
    if (worker["Text"]) parts.push(String(worker["Text"]));
    if (parts.length) props.push({ group: "Workers", label, value: parts.join(", "), format: "text" });
  }
  return props;
}

function conditions(node: PgNode): Condition[] {
  const out: Condition[] = [];
  for (const key of CONDITION_KEYS) {
    const value = node[key];
    if (value === undefined || value === null || value === "") continue;
    out.push({ label: key, expression: stringify(value) });
  }
  if (node["Grouping Sets"]) {
    out.push({ label: "Grouping Sets", expression: stringify(node["Grouping Sets"]) });
  }
  return out;
}

function toDraft(node: PgNode): DraftNode {
  const type = String(node["Node Type"] ?? "Unknown");
  const loops = num(node["Actual Loops"]);
  const analyzed = loops !== undefined;

  const draft: DraftNode = {
    operation: displayName(node),
    kind: nodeKind(type),
    target: targetName(node),
    index: typeof node["Index Name"] === "string" ? (node["Index Name"] as string) : undefined,
    role: typeof node["Parent Relationship"] === "string" ? (node["Parent Relationship"] as string) : undefined,
    subplanName: typeof node["Subplan Name"] === "string" ? (node["Subplan Name"] as string) : undefined,
    startupCost: num(node["Startup Cost"]),
    totalCost: num(node["Total Cost"]),
    estimatedRows: num(node["Plan Rows"]),
    estimatedWidth: num(node["Plan Width"]),
    actualStartupTime: num(node["Actual Startup Time"]),
    actualTotalTime: num(node["Actual Total Time"]),
    actualRows: num(node["Actual Rows"]),
    loops,
    neverExecuted: analyzed && loops === 0,
    conditions: conditions(node),
    properties: [...collectProperties(node, "Other"), ...workerProperties(node)],
    children: (node.Plans ?? []).map(toDraft),
    raw: stripChildren(node),
  };
  return draft;
}

function stripChildren(node: PgNode): Record<string, unknown> {
  const { Plans: _plans, ...rest } = node;
  return rest;
}

/** Accepts `[ { Plan } ]`, `{ Plan }` or a bare plan node. */
export function unwrapPlanJson(input: unknown): Record<string, unknown> {
  let value = input;
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "object") {
    throw new Error("The plan JSON is empty.");
  }
  const obj = value as Record<string, unknown>;
  if (obj["Plan"] && typeof obj["Plan"] === "object") return obj;
  if (obj["Node Type"]) return { Plan: obj };
  throw new Error("The JSON does not look like a PostgreSQL plan (no \"Plan\" or \"Node Type\" key).");
}

function planProperties(top: Record<string, unknown>): Property[] {
  const props: Property[] = [];
  const planning = top["Planning"];
  if (planning && typeof planning === "object") {
    for (const prop of collectProperties(planning as Record<string, unknown>, "Planning")) {
      props.push({ ...prop, group: prop.group === "Buffers" ? "Planning Buffers" : "Planning" });
    }
  }
  const triggers = top["Triggers"];
  if (Array.isArray(triggers)) {
    for (const trigger of triggers as Record<string, unknown>[]) {
      const name = trigger["Constraint Name"] ?? trigger["Trigger Name"] ?? "Trigger";
      const relation = trigger["Relation"] ? ` on ${trigger["Relation"]}` : "";
      props.push({
        group: "Triggers",
        label: `${name}${relation}`,
        value: `${trigger["Time"] ?? "?"} ms, ${trigger["Calls"] ?? "?"} calls`,
        format: "text",
      });
    }
  }
  const jit = top["JIT"] as Record<string, unknown> | undefined;
  if (jit && typeof jit === "object") {
    if (jit["Functions"] !== undefined) {
      props.push({ group: "JIT", label: "Functions", value: Number(jit["Functions"]), format: "number" });
    }
    const timing = jit["Timing"] as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(timing ?? {})) {
      if (typeof value === "number") props.push({ group: "JIT", label: key, value, format: "ms" });
      else if (value && typeof value === "object" && typeof (value as Record<string, unknown>)["Total"] === "number") {
        props.push({ group: "JIT", label: key, value: (value as Record<string, number>)["Total"], format: "ms" });
      }
    }
    const options = jit["Options"] as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(options ?? {})) {
      props.push({ group: "JIT", label: key, value: Boolean(value) });
    }
  }
  const settings = top["Settings"];
  if (settings && typeof settings === "object") {
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      props.push({ group: "Settings", label: key, value: String(value), format: "code" });
    }
  }
  const serialization = top["Serialization"] as Record<string, unknown> | undefined;
  if (serialization && typeof serialization === "object") {
    for (const prop of collectProperties(serialization, "Serialization")) {
      props.push({ ...prop, group: "Serialization", format: prop.label === "Time" ? "ms" : prop.format });
    }
  }
  if (top["Query Identifier"] !== undefined) {
    props.push({ group: "Query", label: "Query Identifier", value: String(top["Query Identifier"]), format: "code" });
  }
  return props;
}

/** Converts PostgreSQL's EXPLAIN (FORMAT JSON) output into the shared model. */
export function normalizePlan(input: unknown, sourceFormat: "json" | "text" = "json"): Plan {
  const top = unwrapPlanJson(input);
  const draft = toDraft(top["Plan"] as PgNode);
  const { root, nodes } = finalizeTree(draft);
  const analyzed = nodes.some((n) => n.loops !== undefined);

  const plan: Plan = {
    engine: "postgresql",
    sourceFormat,
    analyzed,
    root,
    nodes,
    planningTime: num(top["Planning Time"]),
    executionTime: num(top["Execution Time"]),
    totalCost: root.totalCost,
    properties: planProperties(top),
    insights: [],
  };

  computeTimings(plan);
  computeExclusiveCosts(root);
  postgresInsights(plan, top);
  return finishPlan(plan, {
    statisticsAdvice: "Running ANALYZE on the tables involved refreshes their statistics.",
  });
}

function computeExclusiveCosts(node: PlanNode): void {
  for (const child of node.children) computeExclusiveCosts(child);
  if (node.totalCost === undefined) return;
  const childCost = node.children.reduce((sum, c) => sum + (c.totalCost ?? 0), 0);
  node.exclusiveCost = Math.max(0, node.totalCost - childCost);
}
