<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import InsightList from "./InsightList.vue";
import { useExplainer } from "../state/inject";
import { allInsights } from "../core/analysis";
import type { Property } from "../core/plan";
import { formatCost, formatMs, formatNumber, formatPercent, formatValue } from "../core/format";

const ex = useExplainer();
const { plan, stats, selectedNode } = ex;

const nodeStats = computed(() => (selectedNode.value ? stats.value?.nodes.get(selectedNode.value.id) : undefined));
const analyzed = computed(() => plan.value?.analyzed ?? false);

function grouped(properties: Property[]): [string, Property[]][] {
  const groups = new Map<string, Property[]>();
  for (const p of properties) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group)!.push(p);
  }
  return [...groups.entries()];
}

interface Metric {
  label: string;
  value: string;
  note?: string;
  warn?: boolean;
}

const metrics = computed<Metric[]>(() => {
  const n = selectedNode.value;
  const s = nodeStats.value;
  if (!n) return [];
  const out: Metric[] = [];
  if (n.neverExecuted) out.push({ label: "Status", value: "Never executed", note: "Skipped at run time" });
  if (n.exclusiveTime !== undefined) {
    out.push({ label: "Self time", value: formatMs(n.exclusiveTime), note: s?.timeShare !== undefined ? `${formatPercent(s.timeShare)} of total` : undefined });
  }
  if (n.inclusiveTime !== undefined) out.push({ label: "Total time", value: formatMs(n.inclusiveTime), note: "Including children" });
  if (n.actualTotalTime !== undefined && (n.loops ?? 1) > 1) {
    out.push({ label: "Time per loop", value: formatMs(n.actualTotalTime), note: n.actualStartupTime !== undefined ? `First row after ${formatMs(n.actualStartupTime)}` : undefined });
  } else if (n.actualStartupTime !== undefined) {
    out.push({ label: "First row", value: formatMs(n.actualStartupTime) });
  }
  if (n.actualRows !== undefined && !n.neverExecuted) {
    const m = s?.misestimate;
    out.push({
      label: (n.loops ?? 1) > 1 ? "Rows per loop" : "Rows",
      value: formatNumber(n.actualRows),
      note: n.estimatedRows !== undefined ? `Estimated ${formatNumber(n.estimatedRows)}${m && m.factor >= 2 ? ` (${m.factor >= 10 ? formatNumber(Math.round(m.factor)) : m.factor.toFixed(1)}× ${m.direction})` : ""}` : undefined,
      warn: (m?.factor ?? 1) >= 10,
    });
  } else if (n.estimatedRows !== undefined) {
    out.push({ label: "Estimated rows", value: formatNumber(n.estimatedRows) });
  }
  if (n.loops !== undefined && n.loops !== 1) {
    out.push({ label: "Loops", value: formatNumber(n.loops), note: n.totalActualRows !== undefined ? `${formatNumber(n.totalActualRows)} rows in total` : undefined });
  }
  if (n.exclusiveCost !== undefined) {
    out.push({ label: "Self cost", value: formatCost(Math.round(n.exclusiveCost)), note: s?.costShare !== undefined ? `${formatPercent(s.costShare)} of total` : undefined });
  }
  if (n.totalCost !== undefined) {
    out.push({ label: "Total cost", value: formatCost(n.totalCost), note: n.startupCost !== undefined ? `Startup ${formatCost(n.startupCost)}` : undefined });
  }
  if (n.estimatedWidth !== undefined) out.push({ label: "Row width", value: `${formatNumber(n.estimatedWidth)} bytes` });
  return out;
});

const planInsights = computed(() => (plan.value ? allInsights(plan.value) : []));
const hottest = computed(() => stats.value?.hottest ?? []);

function hotValue(id: number): string {
  const n = plan.value!.nodes[id];
  return analyzed.value ? formatMs(n.exclusiveTime ?? 0) : formatCost(Math.round(n.exclusiveCost ?? 0));
}
function hotShare(id: number): number {
  const s = stats.value?.nodes.get(id);
  return (analyzed.value ? s?.timeShare : s?.costShare) ?? 0;
}
const rawNode = computed(() => (selectedNode.value?.raw ? JSON.stringify(selectedNode.value.raw, null, 2) : ""));
</script>

<template>
  <aside class="details" aria-label="Details">
    <!-- A selected node -->
    <template v-if="selectedNode">
      <div class="node-head">
        <Icon :name="selectedNode.kind" :size="18" class="kind" />
        <div class="titles">
          <h2>{{ selectedNode.operation }}</h2>
          <div v-if="selectedNode.target || selectedNode.index" class="target mono">
            {{ selectedNode.target }}<template v-if="selectedNode.index">
              {{ selectedNode.target ? " using " : "" }}{{ selectedNode.index }}</template
            >
          </div>
          <div class="tags">
            <span v-if="selectedNode.subplanName" class="badge">{{ selectedNode.subplanName }}</span>
            <span v-if="selectedNode.role" class="badge" title="Relationship to the parent node">{{ selectedNode.role }}</span>
            <span class="badge">#{{ selectedNode.id }}</span>
          </div>
        </div>
        <button class="btn ghost icon-only" title="Back to plan overview (Esc)" @click="ex.select(undefined)">
          <Icon name="close" />
        </button>
      </div>

      <section v-if="selectedNode.insights.length">
        <InsightList :insights="selectedNode.insights" />
      </section>

      <section v-if="metrics.length">
        <dl class="metrics">
          <div v-for="m in metrics" :key="m.label" class="metric" :class="{ warn: m.warn }">
            <dt>{{ m.label }}</dt>
            <dd>
              {{ m.value }}
              <span v-if="m.note" class="note">{{ m.note }}</span>
            </dd>
          </div>
        </dl>
      </section>

      <section v-if="selectedNode.conditions.length">
        <h3>Conditions</h3>
        <div v-for="c in selectedNode.conditions" :key="c.label" class="condition">
          <div class="label">{{ c.label }}</div>
          <code class="expression">{{ c.expression }}</code>
        </div>
      </section>

      <section v-for="[group, props] in grouped(selectedNode.properties)" :key="group">
        <h3>{{ group }}</h3>
        <table class="props">
          <tr v-for="p in props" :key="p.label">
            <th>{{ p.label }}</th>
            <td :class="{ mono: p.format === 'code' }">{{ formatValue(p.value, p.format) }}</td>
          </tr>
        </table>
      </section>

      <section v-if="rawNode">
        <details>
          <summary>Raw node</summary>
          <pre class="mono raw">{{ rawNode }}</pre>
        </details>
      </section>
    </template>

    <!-- Plan overview -->
    <template v-else-if="plan">
      <section>
        <h3>Insights</h3>
        <InsightList
          v-if="planInsights.length"
          :insights="planInsights"
          :plan="plan"
          show-node
          @select="ex.select"
        />
        <p v-else class="muted small">No problems detected in this plan.</p>
      </section>

      <section v-if="hottest.length">
        <h3>{{ analyzed ? "Slowest steps" : "Most expensive steps" }}</h3>
        <ol class="hottest">
          <li v-for="n in hottest" :key="n.id" @click="ex.select(n.id)">
            <div class="hot-line">
              <span class="hot-name">{{ n.operation }}<span v-if="n.target" class="muted">{{ ` ${n.target}` }}</span></span>
              <span class="hot-value">{{ hotValue(n.id) }}</span>
            </div>
            <div class="hot-bar"><div :style="{ width: `${hotShare(n.id) * 100}%` }" /></div>
          </li>
        </ol>
      </section>

      <section v-for="[group, props] in grouped(plan.properties)" :key="group">
        <h3>{{ group }}</h3>
        <table class="props">
          <tr v-for="p in props" :key="p.label">
            <th>{{ p.label }}</th>
            <td :class="{ mono: p.format === 'code' }">{{ formatValue(p.value, p.format) }}</td>
          </tr>
        </table>
      </section>

      <p class="hint">Select a node to see its details. Arrow keys move through the diagram.</p>
    </template>
  </aside>
</template>

<style scoped>
.details {
  width: 340px;
  flex: none;
  min-height: 0;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--panel);
  padding: 12px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.3;
}
h3 {
  margin: 0 0 6px;
  color: var(--text-light);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
section {
  min-width: 0;
}
.node-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.node-head .kind {
  margin-top: 2px;
  color: var(--text-light);
}
.titles {
  flex: 1;
  min-width: 0;
}
.target {
  margin-top: 2px;
  color: var(--text);
  font-size: 0.75rem;
  word-break: break-all;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  margin: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--border-color);
}
.metric {
  padding: 7px 9px;
  background: var(--panel);
}
.metric:last-child:nth-child(odd) {
  grid-column: span 2;
}
.metric dt {
  color: var(--text-light);
  font-size: 0.6875rem;
}
.metric dd {
  margin: 1px 0 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.metric.warn dd {
  color: var(--brand-warning);
}
.note {
  display: block;
  font-weight: 400;
  font-size: 0.6875rem;
  color: var(--text-light);
}
.condition + .condition {
  margin-top: 8px;
}
.condition .label {
  font-size: 0.75rem;
  color: var(--text-light);
  margin-bottom: 2px;
}
.expression {
  display: block;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--canvas);
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-dark);
  user-select: text;
}
.props {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}
.props th,
.props td {
  padding: 3px 0;
  vertical-align: top;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
}
.props th {
  width: 48%;
  padding-right: 8px;
  color: var(--text-light);
  font-weight: 400;
  text-align: left;
}
.props td {
  word-break: break-word;
  font-variant-numeric: tabular-nums;
  user-select: text;
}
details summary {
  cursor: pointer;
  color: var(--text-light);
  font-size: 0.75rem;
}
.raw {
  margin: 6px 0 0;
  padding: 8px;
  border-radius: 4px;
  background: var(--canvas);
  font-size: 0.6875rem;
  overflow-x: auto;
  user-select: text;
}
.hottest {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hottest li {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.hottest li:hover {
  background: var(--subtle);
}
.hot-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.8125rem;
}
.hot-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hot-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.hot-bar {
  height: 4px;
  margin-top: 4px;
  border-radius: 2px;
  background: var(--subtle);
  overflow: hidden;
}
.hot-bar div {
  height: 100%;
  background: var(--heat-mid);
  border-radius: 2px;
}
.small {
  font-size: 0.8125rem;
  margin: 0;
}
</style>
