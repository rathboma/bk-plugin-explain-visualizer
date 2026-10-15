<script setup lang="ts">
import Icon from "./Icon.vue";
import type { Insight, Plan } from "../core/plan";

defineProps<{ insights: Insight[]; plan?: Plan; showNode?: boolean }>();
defineEmits<{ select: [id: number] }>();

const icon = (insight: Insight) => (insight.severity === "info" ? "info" : insight.severity === "critical" ? "critical" : "warning");
</script>

<template>
  <ul class="insights">
    <li v-for="(insight, i) in insights" :key="i" :class="`sev-${insight.severity}`">
      <Icon :name="icon(insight)" :size="15" />
      <div class="text">
        <div class="title">{{ insight.title }}</div>
        <div v-if="insight.detail" class="detail">{{ insight.detail }}</div>
        <button
          v-if="showNode && insight.nodeId !== undefined && plan"
          class="node-link"
          @click="$emit('select', insight.nodeId)"
        >
          {{ plan.nodes[insight.nodeId].operation
          }}<template v-if="plan.nodes[insight.nodeId].target"> on {{ plan.nodes[insight.nodeId].target }}</template>
        </button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.insights {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
li {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: color-mix(in srgb, currentColor 7%, transparent);
}
li .icon {
  margin-top: 1px;
}
.text {
  min-width: 0;
  color: var(--text-dark);
}
.title {
  font-weight: 600;
  font-size: 0.8125rem;
}
.detail {
  margin-top: 2px;
  color: var(--text);
  font-size: 0.75rem;
}
.node-link {
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--link-color, var(--text-dark));
  font: inherit;
  font-size: 0.75rem;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}
</style>
