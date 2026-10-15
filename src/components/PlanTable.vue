<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { useExplainer } from "../state/inject";
import { walk, type PlanNode } from "../core/plan";
import { formatCost, formatMs, formatNumber, formatPercent } from "../core/format";
import { heatLevel } from "./heat";

const ex = useExplainer();
const { state, plan, stats } = ex;
const sortByWeight = ref(false);
const body = ref<HTMLElement>();

interface Row {
  node: PlanNode;
  depth: number;
}

const rows = computed<Row[]>(() => {
  if (!plan.value) return [];
  const out: Row[] = [];
  walk(plan.value.root, (node, _parent, depth) => out.push({ node, depth }));
  if (sortByWeight.value) {
    const weight = (n: PlanNode) => (analyzed.value ? n.exclusiveTime : n.exclusiveCost) ?? 0;
    out.sort((a, b) => weight(b.node) - weight(a.node));
  }
  return out;
});

const analyzed = computed(() => plan.value?.analyzed ?? false);

function share(node: PlanNode): number {
  const s = stats.value?.nodes.get(node.id);
  return (analyzed.value ? s?.timeShare : s?.costShare) ?? 0;
}

function estimateText(node: PlanNode): string {
  const m = stats.value?.nodes.get(node.id)?.misestimate;
  if (!m || m.factor < 2) return "";
  const factor = m.factor >= 10 ? formatNumber(Math.round(m.factor)) : m.factor.toFixed(1);
  return `${m.direction === "under" ? "↑" : "↓"}${factor}×`;
}

/** The node as psql would print it: "Index Scan using idx on t". */
function label(node: PlanNode): string {
  let text = node.operation;
  if (node.index) text += node.target ? ` using ${node.index}` : ` on ${node.index}`;
  if (node.target) text += ` on ${node.target}`;
  return text;
}

watch(
  () => state.selectedId,
  async (id) => {
    await nextTick();
    body.value?.querySelector(`[data-node-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }
);
</script>

<template>
  <div v-if="plan" class="table-wrap">
    <table class="plan-table">
      <thead>
        <tr>
          <th class="op">Operation</th>
          <th class="num sortable" :class="{ sorted: sortByWeight }" @click="sortByWeight = !sortByWeight">
            {{ analyzed ? "Self time" : "Self cost" }}
            <Icon :name="sortByWeight ? 'chevronDown' : 'sort'" :size="12" />
          </th>
          <th class="num">Share</th>
          <th class="num">{{ analyzed ? "Total time" : "Total cost" }}</th>
          <th v-if="analyzed" class="num">Rows</th>
          <th class="num">Est. rows</th>
          <th v-if="analyzed" class="num">Loops</th>
          <th v-if="analyzed" class="num">Self cost</th>
        </tr>
      </thead>
      <tbody ref="body">
        <tr
          v-for="{ node, depth } in rows"
          :key="node.id"
          :data-node-id="node.id"
          :class="{ selected: state.selectedId === node.id, never: node.neverExecuted }"
          @click="ex.select(node.id)"
        >
          <td class="op">
            <div class="op-cell" :style="{ paddingLeft: `${sortByWeight ? 0 : depth * 16}px` }">
              <span v-if="depth > 0 && !sortByWeight" class="elbow">└</span>
              <Icon :name="node.kind" :size="13" class="kind" />
              <span v-if="node.subplanName" class="badge">{{ node.subplanName }}</span>
              <span class="op-label" :title="label(node)">{{ label(node) }}</span>
              <Icon
                v-if="node.insights.length"
                :name="node.insights[0].severity === 'info' ? 'info' : 'warning'"
                :size="13"
                :class="`sev-${node.insights[0].severity}`"
                :title="node.insights.map((i) => i.title).join('\n')"
              />
            </div>
          </td>
          <td class="num strong">
            <template v-if="analyzed">{{ node.exclusiveTime !== undefined ? formatMs(node.exclusiveTime) : "–" }}</template>
            <template v-else>{{ node.exclusiveCost !== undefined ? formatCost(Math.round(node.exclusiveCost)) : "–" }}</template>
          </td>
          <td class="num share" :class="`heat-${heatLevel(share(node))}`">{{ formatPercent(share(node)) }}</td>
          <td class="num">
            <template v-if="analyzed">{{ node.inclusiveTime !== undefined ? formatMs(node.inclusiveTime) : "–" }}</template>
            <template v-else>{{ node.totalCost !== undefined ? formatCost(node.totalCost) : "–" }}</template>
          </td>
          <td v-if="analyzed" class="num">
            {{ node.neverExecuted ? "never executed" : node.actualRows !== undefined ? formatNumber(node.actualRows) : "–" }}
          </td>
          <td class="num">
            {{ node.estimatedRows !== undefined ? formatNumber(node.estimatedRows) : "–" }}
            <span v-if="analyzed && estimateText(node)" class="estimate">{{ estimateText(node) }}</span>
          </td>
          <td v-if="analyzed" class="num">{{ node.loops !== undefined ? formatNumber(node.loops) : "–" }}</td>
          <td v-if="analyzed" class="num">
            {{ node.exclusiveCost !== undefined ? formatCost(Math.round(node.exclusiveCost)) : "–" }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--canvas);
}
.plan-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel);
  color: var(--text-light);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  text-align: left;
  white-space: nowrap;
}
th.sortable {
  cursor: pointer;
}
th.sortable .icon {
  display: inline-block;
  vertical-align: -2px;
}
th.sorted {
  color: var(--text-dark);
}
td {
  padding: 5px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 60%, transparent);
  white-space: nowrap;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover {
  background: var(--subtle);
}
tbody tr.selected {
  background: var(--selection);
}
tbody tr.never {
  color: var(--text-light);
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
th.num {
  text-align: right;
}
.strong {
  font-weight: 600;
}
.op {
  width: 100%;
  max-width: 0;
}
.op-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 260px;
}
.op-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.elbow {
  color: var(--text-lighter);
  margin-left: -12px;
  width: 6px;
}
.kind {
  color: var(--text-light);
}
.share.heat-1 {
  background: color-mix(in srgb, var(--heat-low) 35%, transparent);
}
.share.heat-2 {
  background: color-mix(in srgb, var(--heat-mid) 35%, transparent);
}
.share.heat-3 {
  background: color-mix(in srgb, var(--heat-high) 40%, transparent);
  color: var(--text-dark);
}
.estimate {
  margin-left: 4px;
  color: var(--brand-warning);
  font-size: 0.75rem;
}
</style>
