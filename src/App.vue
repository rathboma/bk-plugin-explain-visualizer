<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import QueryPanel from "./components/QueryPanel.vue";
import ResultBar from "./components/ResultBar.vue";
import PlanDiagram from "./components/PlanDiagram.vue";
import PlanTable from "./components/PlanTable.vue";
import RawView from "./components/RawView.vue";
import DetailsPanel from "./components/DetailsPanel.vue";
import Icon from "./components/Icon.vue";
import { createExplainer } from "./state/explainer";
import { ExplainerKey } from "./state/inject";
import { host } from "./host/host";
import { launchInput } from "./host/launch";
import { databaseName, supportedDatabaseNames } from "./engines/registry";

const ex = createExplainer(host);
provide(ExplainerKey, ex);
const { state, plan } = ex;

const detailsOpen = ref(true);
watch(
  () => state.selectedId,
  (id) => {
    if (id !== undefined) detailsOpen.value = true;
  }
);

function onKeydown(event: KeyboardEvent) {
  const typing = (event.target as HTMLElement).closest("textarea, input");
  if (event.key === "Escape" && !typing && state.selectedId !== undefined) ex.select(undefined);
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void ex.init(async () => launchInput(await host.viewContext()));
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="app">
    <div v-if="!state.ready" class="status">
      <div class="spinner" />
    </div>
    <template v-else>
      <QueryPanel />
      <main class="workspace">
        <div v-if="state.status === 'error'" class="error" role="alert">
          <Icon name="critical" :size="16" />
          <div>
            <div class="error-title">{{ state.mode === "query" ? "Explain failed" : "The plan could not be read" }}</div>
            <div class="error-message mono">{{ state.error }}</div>
          </div>
        </div>

        <template v-if="plan">
          <ResultBar v-model:details-open="detailsOpen" />
          <div class="result" :class="{ busy: state.status === 'running' }">
            <PlanDiagram v-if="state.view === 'diagram'" />
            <PlanTable v-else-if="state.view === 'table'" />
            <RawView v-else />
            <DetailsPanel v-if="detailsOpen && state.view !== 'raw'" />
            <div v-if="state.status === 'running'" class="running">
              <div class="spinner" />
              {{ state.lastAnalyze ? "Running Explain Analyze…" : "Explaining…" }}
            </div>
          </div>
        </template>

        <div v-else-if="state.status === 'running'" class="status">
          <div class="spinner" />
          <span>{{ state.lastAnalyze ? "Running Explain Analyze…" : "Explaining…" }}</span>
        </div>

        <div v-else-if="state.status !== 'error'" class="empty">
          <Icon name="diagram" :size="40" class="empty-icon" />
          <template v-if="ex.unsupportedDatabase.value">
            <h1>{{ databaseName(state.connection?.databaseType) }} is not supported yet</h1>
            <p>
              Explain Visualizer supports {{ supportedDatabaseNames() }}. A plan from a supported database can still be
              pasted above.
            </p>
          </template>
          <template v-else>
            <h1>Visualize a query plan</h1>
            <p v-if="ex.engine.value?.supportsAnalyze">
              Write a statement above and choose <strong>Explain</strong> to see how the database will run it, or
              <strong>Explain Analyze</strong> to run it and measure every step.
            </p>
            <p v-else>Write a statement above and choose <strong>Explain</strong> to see how the database will run it.</p>
            <p class="hint">
              Right-click a query in the editor and choose <em>Visualize Explain Plan</em> to open it here. Existing
              EXPLAIN output can be visualized with <em>Paste Plan</em>.
            </p>
          </template>
        </div>
      </main>
    </template>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.result {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.result > :first-child {
  flex: 1;
  min-width: 0;
}
.running {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 20px;
  background: var(--raised);
  box-shadow: var(--shadow);
  font-size: 0.8125rem;
}
.running .spinner {
  width: 14px;
  height: 14px;
}
.status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-light);
}
.error {
  display: flex;
  gap: 10px;
  margin: 10px 12px 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--brand-danger) 40%, transparent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--brand-danger) 10%, transparent);
  color: var(--brand-danger);
}
.result + .error,
.error + .result-bar {
  margin-top: 10px;
}
.error-title {
  font-weight: 600;
  color: var(--text-dark);
}
.error-message {
  margin-top: 2px;
  color: var(--text);
  font-size: 0.8125rem;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  background: var(--canvas);
}
.empty-icon {
  color: var(--text-lighter);
  margin-bottom: 12px;
}
.empty h1 {
  margin: 0 0 6px;
  font-size: 1.0625rem;
  font-weight: 600;
}
.empty p {
  max-width: 460px;
  margin: 4px 0;
  color: var(--text);
}
.empty .hint {
  margin-top: 10px;
}
</style>
