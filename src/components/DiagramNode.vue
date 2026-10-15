<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import type { PlanNode } from "../core/plan";
import type { NodeStats } from "../core/analysis";
import { formatCompact, formatCost, formatMs, formatPercent } from "../core/format";
import { heatLevel } from "./heat";
import { NODE_HEIGHT, NODE_WIDTH } from "../core/layout";

const props = defineProps<{
  node: PlanNode;
  stats?: NodeStats;
  colorBy: "time" | "cost";
  analyzed: boolean;
  selected: boolean;
  x: number;
  y: number;
}>();
defineEmits<{ select: [id: number] }>();

const share = computed(() => (props.colorBy === "time" ? props.stats?.timeShare : props.stats?.costShare) ?? 0);
const heat = computed(() => heatLevel(share.value));

const subtitle = computed(() => {
  const n = props.node;
  const parts: string[] = [];
  if (n.target) parts.push(n.target);
  if (n.index) parts.push(n.target ? `using ${n.index}` : n.index);
  if (parts.length) return parts.join(" ");
  if (n.description) return n.description;
  const condition = n.conditions.find((c) => c.label !== "Output");
  return condition ? condition.expression : "";
});

const metric = computed(() => {
  const n = props.node;
  if (props.colorBy === "time") {
    if (n.exclusiveTime === undefined) return undefined;
    return formatMs(n.exclusiveTime);
  }
  if (n.exclusiveCost === undefined) return undefined;
  return formatCost(Math.round(n.exclusiveCost));
});

const rows = computed(() => {
  const n = props.node;
  if (props.analyzed && n.actualRows !== undefined) {
    const value = formatCompact(n.actualRows);
    return (n.loops ?? 1) > 1 ? `${value} × ${formatCompact(n.loops!)} loops` : `${value} rows`;
  }
  return n.estimatedRows !== undefined ? `~${formatCompact(n.estimatedRows)} rows` : "";
});

const estimate = computed(() => {
  const m = props.stats?.misestimate;
  if (!props.analyzed || !m || m.factor < 2 || props.node.estimatedRows === undefined) return undefined;
  return {
    text: `est ${formatCompact(props.node.estimatedRows)}`,
    arrow: m.direction === "under" ? "↑" : "↓",
    factor: m.factor >= 10 ? `${formatCompact(Math.round(m.factor))}×` : `${m.factor.toFixed(1)}×`,
    bad: m.factor >= 10,
  };
});

const worstInsight = computed(() => props.node.insights[0]);
</script>

<template>
  <div
    class="node-card"
    :class="[`heat-${heat}`, { selected, never: node.neverExecuted }]"
    :style="{ left: `${x}px`, top: `${y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
    :data-node-id="node.id"
    role="treeitem"
    :aria-selected="selected"
    :aria-label="`${node.operation}${node.target ? ' on ' + node.target : ''}`"
    @click.stop="$emit('select', node.id)"
  >
    <div v-if="node.subplanName" class="subplan">{{ node.subplanName }}</div>
    <div class="head">
      <Icon :name="node.kind" :size="14" class="kind" />
      <span class="operation" :title="node.operation">{{ node.operation }}</span>
      <span
        v-if="worstInsight"
        class="insight-badge"
        :class="`sev-${worstInsight.severity}`"
        :title="node.insights.map((i) => i.title).join('\n')"
      >
        <Icon :name="worstInsight.severity === 'info' ? 'info' : 'warning'" :size="13" />
        <span v-if="node.insights.length > 1">{{ node.insights.length }}</span>
      </span>
    </div>
    <div class="subtitle mono" :title="subtitle">{{ subtitle || " " }}</div>
    <div v-if="node.neverExecuted" class="never-label">never executed</div>
    <template v-else>
      <div v-if="metric !== undefined" class="metric">
        <div class="bar"><div class="fill" :style="{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }" /></div>
        <span v-if="metric" class="value">{{ metric }}</span>
        <span class="share">{{ formatPercent(share) }}</span>
      </div>
      <div class="rows">
        <span>{{ rows }}</span>
        <span v-if="estimate" class="estimate" :class="{ bad: estimate.bad }" :title="`Estimated ${node.estimatedRows} rows per loop`">
          {{ estimate.arrow }} {{ estimate.factor }} <span class="muted">({{ estimate.text }})</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.node-card {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px 8px 13px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--raised);
  box-shadow: var(--shadow);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
}
.node-card::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -1px;
  bottom: -1px;
  width: 4px;
  border-radius: var(--radius) 0 0 var(--radius);
  background: var(--heat-color, transparent);
}
.node-card:hover {
  background: var(--raised-hover);
}
.node-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--shadow);
}
.node-card.never {
  opacity: 0.55;
}
.heat-1 {
  --heat-color: var(--heat-low);
}
.heat-2 {
  --heat-color: var(--heat-mid);
}
.heat-3 {
  --heat-color: var(--heat-high);
}
.subplan {
  position: absolute;
  top: -21px;
  left: 0;
  max-width: 100%;
  padding: 1px 7px;
  border-radius: 4px 4px 0 0;
  background: var(--subtle);
  color: var(--text-light);
  font-size: 0.6875rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.kind {
  color: var(--text-light);
}
.operation {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.insight-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.6875rem;
  font-weight: 700;
}
.subtitle {
  color: var(--text-light);
  font-size: 0.6875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metric {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 0.75rem;
}
.bar {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--subtle);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 3px;
  background: var(--heat-color, var(--text-lighter));
}
.value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.share {
  min-width: 34px;
  text-align: right;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.rows {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--text);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.estimate {
  color: var(--text-light);
}
.estimate.bad {
  color: var(--brand-warning);
}
.never-label {
  margin-top: 4px;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--text-light);
}
</style>
