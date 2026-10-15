<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { useExplainer } from "../state/inject";
import { host, errorMessage } from "../host/host";

const ex = useExplainer();
const result = ex.result;

const extension = computed(() => (result.value?.rawFormat === "json" ? "json" : "txt"));

async function save() {
  if (!result.value) return;
  try {
    await host.saveFile(
      result.value.raw,
      `query-plan.${extension.value}`,
      extension.value,
      result.value.rawFormat === "json" ? "JSON" : "Text"
    );
  } catch (e) {
    void host.notifyError(`The plan could not be saved: ${errorMessage(e)}`);
  }
}
</script>

<template>
  <div v-if="result" class="raw">
    <div class="raw-toolbar">
      <button class="btn" @click="host.copy(result.raw)"><Icon name="copy" :size="14" /> Copy Plan</button>
      <button class="btn" @click="save"><Icon name="download" :size="14" /> Save…</button>
      <!-- Analyzed SQL is left out: run one statement at a time in a query
           tab, EXPLAIN ANALYZE would commit what the ROLLBACK undoes here. -->
      <button
        v-if="result.sql && !result.plan.analyzed"
        class="btn"
        title="Open the EXPLAIN statement in a new query tab"
        @click="host.openQueryTab(result.sql)"
      >
        <Icon name="external" :size="14" /> Open SQL in Query Tab
      </button>
      <span class="hint">{{ result.rawFormat === "json" ? "JSON" : "Text" }} · {{ result.plan.nodes.length }} nodes</span>
    </div>
    <details v-if="result.sql" class="sql">
      <summary>SQL sent to the database</summary>
      <pre class="mono">{{ result.sql }}</pre>
    </details>
    <pre class="mono plan-text">{{ result.raw }}</pre>
  </div>
</template>

<style scoped>
.raw {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--canvas);
}
.raw-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel);
}
.sql {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 0.75rem;
  color: var(--text-light);
}
.sql summary {
  cursor: pointer;
}
.sql pre {
  margin: 6px 0 0;
  white-space: pre-wrap;
  color: var(--text-dark);
}
.plan-text {
  flex: 1;
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-dark);
  user-select: text;
}
</style>
