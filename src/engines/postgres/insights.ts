import type { Insight, Plan, PlanNode } from "../../core/plan";
import { formatBytes, formatMs, formatNumber } from "../../core/format";
import type { PgNode } from "./nodeTypes";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

type Rule = (node: PlanNode, r: PgNode, plan: Plan) => Omit<Insight, "nodeId"> | undefined;

/** Rules for single nodes. Each returns at most one insight. */
const NODE_RULES: Rule[] = [
  // A sequential scan that throws most rows away is the classic missing index.
  (node, r) => {
    if (r["Node Type"] !== "Seq Scan") return;
    const removed = num(r["Rows Removed by Filter"]) * Math.max(1, node.loops ?? 1);
    const kept = node.totalActualRows ?? 0;
    if (removed < 1000 || removed / (removed + kept) < 0.9) return;
    const share = Math.round((removed / (removed + kept)) * 100);
    return {
      rule: "seq-scan-filter",
      severity: "warning",
      title: "Sequential scan discards most rows",
      detail: `${formatNumber(removed)} rows (${share}%) were read and then removed by the filter. An index on the filtered columns lets PostgreSQL read only matching rows.`,
    };
  },

  // A sequential scan repeated for every outer row of a nested loop.
  (node, r) => {
    const loops = node.loops ?? 0;
    if (r["Node Type"] !== "Seq Scan" || loops < 100) return;
    const rowsRead = ((node.actualRows ?? 0) + num(r["Rows Removed by Filter"])) * loops;
    if (rowsRead < 10000) return;
    return {
      rule: "repeated-seq-scan",
      severity: "warning",
      title: `Sequential scan repeated ${formatNumber(node.loops!)} times`,
      detail: "The table is scanned once per row of the outer side of a join. An index on the join columns usually fixes this.",
    };
  },

  (_node, r) => {
    const onDisk = r["Sort Space Type"] === "Disk" || /external/.test(String(r["Sort Method"] ?? ""));
    if (!onDisk) return;
    const used = num(r["Sort Space Used"]);
    return {
      rule: "sort-on-disk",
      severity: "warning",
      title: "Sort spilled to disk",
      detail: `The sort used ${used ? formatBytes(used * 1024) : "temporary files"} on disk (${r["Sort Method"] ?? "external sort"}). A larger work_mem lets it run in memory.`,
    };
  },

  (_node, r) => {
    const batches = num(r["Hash Batches"]);
    if (batches <= 1) return;
    return {
      rule: "hash-batches",
      severity: "warning",
      title: `Hash split into ${formatNumber(batches)} batches`,
      detail: `The hash table did not fit in work_mem${num(r["Original Hash Batches"]) && num(r["Original Hash Batches"]) < batches ? ` (planned for ${r["Original Hash Batches"]})` : ""}, so batches were written to temporary files. A larger work_mem or a smaller inner side avoids this.`,
    };
  },

  (_node, r) => {
    const batches = num(r["HashAgg Batches"]);
    const disk = num(r["Disk Usage"]);
    if (batches <= 1 && disk === 0) return;
    return {
      rule: "hashagg-disk",
      severity: "warning",
      title: "Hash aggregate spilled to disk",
      detail: `${disk ? `${formatBytes(disk * 1024)} written to disk` : `${formatNumber(batches)} batches`}. A larger work_mem (or hash_mem_multiplier) keeps the aggregate in memory.`,
    };
  },

  (node, r) => {
    if (r["Node Type"] !== "Index Only Scan") return;
    const fetches = num(r["Heap Fetches"]);
    const rows = node.totalActualRows ?? 0;
    if (fetches < 1000 || fetches < rows * 0.1) return;
    return {
      rule: "heap-fetches",
      severity: "info",
      title: "Index-only scan visited the table",
      detail: `${formatNumber(fetches)} heap fetches were needed because the visibility map is out of date. VACUUM on the table makes the scan truly index-only.`,
    };
  },

  (_node, r) => {
    const lossy = num(r["Lossy Heap Blocks"]);
    if (!lossy) return;
    return {
      rule: "lossy-bitmap",
      severity: "info",
      title: "Bitmap became lossy",
      detail: `${formatNumber(lossy)} heap blocks were tracked per page instead of per row, so every row on them was rechecked${num(r["Rows Removed by Index Recheck"]) ? ` (${formatNumber(num(r["Rows Removed by Index Recheck"]))} removed)` : ""}. A larger work_mem keeps the bitmap exact.`,
    };
  },

  (_node, r) => {
    const planned = num(r["Workers Planned"]);
    if (!planned || r["Workers Launched"] === undefined) return;
    const launched = num(r["Workers Launched"]);
    if (launched >= planned) return;
    return {
      rule: "workers-not-launched",
      severity: "warning",
      title: `${launched} of ${planned} parallel workers launched`,
      detail: "The server ran out of background workers. Check max_parallel_workers and max_worker_processes.",
    };
  },

  (node, r) => {
    const removed = num(r["Rows Removed by Join Filter"]) * Math.max(1, node.loops ?? 1);
    const kept = node.totalActualRows ?? 0;
    if (removed < 10000 || removed < kept * 10) return;
    return {
      rule: "join-filter",
      severity: "info",
      title: "Join filter discards most row pairs",
      detail: `${formatNumber(removed)} joined rows were removed by the join filter. Moving the condition into the join clause, or indexing it, may avoid producing them.`,
    };
  },

  (_node, r) => {
    if (r["Disabled"] !== true) return;
    return {
      rule: "disabled-node",
      severity: "info",
      title: "Node type disabled by a setting",
      detail: "An enable_* setting is off for this node type, but no other plan was possible.",
    };
  },
];

export function postgresInsights(plan: Plan, top: Record<string, unknown>): void {
  for (const node of plan.nodes) {
    const r = (node.raw ?? {}) as PgNode;
    for (const rule of NODE_RULES) {
      const insight = rule(node, r, plan);
      if (insight) node.insights.push({ ...insight, nodeId: node.id });
    }
  }

  const execution = plan.executionTime ?? 0;
  const jitTotal = num((top["JIT"] as { Timing?: { Total?: unknown } } | undefined)?.Timing?.Total);
  if (jitTotal > 50 && jitTotal > execution * 0.2) {
    plan.insights.push({
      rule: "jit-overhead",
      severity: "warning",
      title: `JIT compilation took ${formatMs(jitTotal)}`,
      detail: `That is ${Math.round((jitTotal / Math.max(execution, 1)) * 100)}% of the execution time. For short queries, raising jit_above_cost or turning jit off is usually faster.`,
    });
  }

  const triggers = Array.isArray(top["Triggers"]) ? (top["Triggers"] as Record<string, unknown>[]) : [];
  const triggerTime = triggers.reduce((sum, t) => sum + num(t["Time"]), 0);
  if (execution && triggerTime > execution * 0.3 && triggerTime > 1) {
    plan.insights.push({
      rule: "trigger-time",
      severity: "info",
      title: `Triggers took ${formatMs(triggerTime)}`,
      detail: "Time spent in triggers (including foreign key checks) is not part of any plan node.",
    });
  }

  const planning = plan.planningTime ?? 0;
  if (planning > 50 && planning > execution && execution > 0) {
    plan.insights.push({
      rule: "slow-planning",
      severity: "info",
      title: "Planning took longer than execution",
      detail: `Planning: ${formatMs(planning)}, execution: ${formatMs(execution)}. Many joins, partitions or complex views increase planning time; a prepared statement can reuse the plan.`,
    });
  }
}
