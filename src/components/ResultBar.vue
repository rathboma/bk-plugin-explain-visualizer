<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { useExplainer } from "../state/inject";
import { allInsights } from "../core/analysis";
import { formatCost, formatMs, formatNumber } from "../core/format";

const props = defineProps<{ detailsOpen: boolean }>();
const emit = defineEmits<{ "update:detailsOpen": [value: boolean] }>();

const ex = useExplainer();
const { state, plan } = ex;

interface Stat {
  label: string;
  value: string;
  title?: string;
}

const summary = computed<Stat[]>(() => {
  const p = plan.value;
  if (!p) return [];
  const out: Stat[] = [];
  if (p.analyzed) {
    if (p.executionTime !== undefined) out.push({ label: "Execution", value: formatMs(p.executionTime) });
    else if (p.root.inclusiveTime !== undefined) out.push({ label: "Time", value: formatMs(p.root.inclusiveTime) });
    if (p.planningTime !== undefined) out.push({ label: "Planning", value: formatMs(p.planningTime) });
    if (p.root.actualRows !== undefined) out.push({ label: "Rows", value: formatNumber(p.root.totalActualRows ?? p.root.actualRows) });
  } else if (p.root.estimatedRows !== undefined) {
    out.push({ label: "Est. rows", value: formatNumber(p.root.estimatedRows) });
  }
  if (p.totalCost !== undefined) {
    out.push({ label: "Cost", value: formatCost(p.totalCost), title: "Planner cost estimate, in arbitrary units" });
  }
  out.push({ label: "Nodes", value: formatNumber(p.nodes.length) });
  return out;
});

const counts = computed(() => {
  const insights = plan.value ? allInsights(plan.value) : [];
  return {
    problems: insights.filter((i) => i.severity !== "info").length,
    info: insights.filter((i) => i.severity === "info").length,
  };
});

function setView(view: "diagram" | "table" | "raw") {
  state.view = view;
  ex.persist();
}
function setColor(color: "time" | "cost") {
  state.colorBy = color;
  ex.persist();
}
</script>

<template>
  <div v-if="plan" class="result-bar">
    <div class="stats">
      <span v-if="!plan.analyzed" class="badge info" title="The statement was planned but not run">Estimate</span>
      <span v-else class="badge" title="The statement was run to measure it">Analyzed</span>
      <span v-for="s in summary" :key="s.label" class="stat" :title="s.title">
        <span class="label">{{ s.label }}</span>
        <span class="value">{{ s.value }}</span>
      </span>
      <button
        v-if="counts.problems || counts.info"
        class="badge"
        :class="counts.problems ? 'warning' : 'info'"
        title="Show insights"
        @click="
          ex.select(undefined);
          emit('update:detailsOpen', true);
        "
      >
        <Icon :name="counts.problems ? 'warning' : 'info'" :size="12" />
        {{ counts.problems || counts.info }} {{ (counts.problems || counts.info) === 1 ? "insight" : "insights" }}
      </button>
    </div>
    <div class="controls">
      <div
        v-if="state.view !== 'raw' && (plan.analyzed || plan.totalCost !== undefined)"
        class="segmented"
        role="radiogroup"
        aria-label="Color by"
      >
        <button
          :class="{ active: ex.colorBy.value === 'time' }"
          :disabled="!plan.analyzed"
          :title="plan.analyzed ? 'Color by each step\'s share of execution time' : 'Time is only measured by Explain Analyze'"
          @click="setColor('time')"
        >
          Time
        </button>
        <button
          :class="{ active: ex.colorBy.value === 'cost' }"
          title="Color by each step's share of the estimated cost"
          @click="setColor('cost')"
        >
          Cost
        </button>
      </div>
      <div class="segmented" role="tablist" aria-label="View">
        <button :class="{ active: state.view === 'diagram' }" @click="setView('diagram')">
          <Icon name="diagram" :size="13" /> Diagram
        </button>
        <button :class="{ active: state.view === 'table' }" @click="setView('table')">
          <Icon name="table" :size="13" /> Table
        </button>
        <button :class="{ active: state.view === 'raw' }" @click="setView('raw')">
          <Icon name="code" :size="13" /> Raw
        </button>
      </div>
      <button
        class="btn ghost icon-only"
        :class="{ on: props.detailsOpen }"
        :title="props.detailsOpen ? 'Hide details' : 'Show details'"
        :aria-pressed="props.detailsOpen"
        @click="emit('update:detailsOpen', !props.detailsOpen)"
      >
        <Icon name="panel" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.result-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel);
  flex-wrap: wrap;
}
.stats,
.controls {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.controls {
  gap: 8px;
}
.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}
.stat .label {
  color: var(--text-light);
  font-size: 0.75rem;
}
.stat .value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
button.badge {
  border: 0;
  cursor: pointer;
  font-family: inherit;
}
.btn.on {
  color: var(--text-dark);
  background: var(--subtle);
}
</style>
