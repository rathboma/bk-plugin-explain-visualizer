<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { useExplainer } from "../state/inject";
import type { ExplainOption } from "../engines/types";
import { databaseName } from "../engines/registry";

const ex = useExplainer();
const { state, engine } = ex;

const collapsed = ref(false);
const optionsOpen = ref(false);
const optionsEl = ref<HTMLElement>();
const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl";

const running = computed(() => state.status === "running");
const text = computed({
  get: () => (state.mode === "query" ? state.query : state.pasteText),
  set: (value: string) => {
    if (state.mode === "query") state.query = value;
    else state.pasteText = value;
  },
});
// Leave room for the plan once there is one; the box can still be resized.
const rows = computed(() => Math.min(ex.plan.value ? 4 : 10, Math.max(3, text.value.split("\n").length)));
const statement = computed(() => (state.mode === "query" && engine.value ? engine.value.inspect(state.query) : undefined));
const writes = computed(() => Boolean(statement.value && !statement.value.error && statement.value.modifiesData));
const analyzeBlocked = computed(() => writes.value && ex.readOnly.value);

const dbLabel = computed(() => {
  if (!engine.value) return state.connection ? databaseName(state.connection.databaseType) : "";
  const version = state.server?.versionLabel;
  return version ? `${engine.value.displayName} ${version}` : engine.value.displayName;
});

function optionUnavailable(option: ExplainOption): string | undefined {
  const version = state.server?.version;
  if (option.minServerVersion && version !== undefined && version < option.minServerVersion) {
    const major = Math.floor(option.minServerVersion / 10000);
    return `Needs ${engine.value?.displayName ?? "server"} ${major}+`;
  }
  return undefined;
}

const activeOptions = computed(() =>
  (engine.value?.options ?? []).filter((o) => state.options[o.id] && !optionUnavailable(o)).map((o) => o.label)
);

function setMode(mode: "query" | "paste") {
  state.mode = mode;
  ex.persist();
}

function submit(analyze: boolean) {
  if (running.value) return;
  if (state.mode === "paste") ex.visualize();
  else void ex.explain(analyze);
  ex.persist();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit(event.shiftKey);
  }
}

function onDocumentClick(event: MouseEvent) {
  if (optionsOpen.value && optionsEl.value && !optionsEl.value.contains(event.target as Node)) {
    optionsOpen.value = false;
  }
}
onMounted(() => document.addEventListener("mousedown", onDocumentClick));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocumentClick));
</script>

<template>
  <header class="query-panel">
    <div class="bar">
      <div class="segmented" role="tablist" aria-label="Input">
        <button
          role="tab"
          :class="{ active: state.mode === 'query' }"
          :aria-selected="state.mode === 'query'"
          :disabled="!engine"
          :title="engine ? 'Explain a query' : 'Explaining queries is not supported for this database yet'"
          @click="setMode('query')"
        >
          <Icon name="code" :size="13" /> Query
        </button>
        <button
          role="tab"
          :class="{ active: state.mode === 'paste' }"
          :aria-selected="state.mode === 'paste'"
          @click="setMode('paste')"
        >
          <Icon name="paste" :size="13" /> Paste Plan
        </button>
      </div>
      <span class="spacer" />
      <span v-if="dbLabel" class="db-label">{{ dbLabel }}</span>
      <span v-if="ex.readOnly.value" class="badge" title="The connection is in read-only mode">Read-only</span>
      <button
        class="btn ghost icon-only"
        :title="collapsed ? 'Show editor' : 'Hide editor'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <Icon :name="collapsed ? 'chevronDown' : 'chevronUp'" />
      </button>
    </div>

    <div v-if="!collapsed" class="editor">
      <textarea
        v-model="text"
        class="mono"
        :rows="rows"
        spellcheck="false"
        :placeholder="state.mode === 'query' ? 'SELECT … — write the statement to explain' : engine?.pasteHint ?? 'Paste EXPLAIN output'"
        :aria-label="state.mode === 'query' ? 'Query to explain' : 'Plan to visualize'"
        @keydown="onKeydown"
        @blur="ex.persist()"
      />
    </div>
    <button v-else class="collapsed-preview mono" title="Show editor" @click="collapsed = false">
      {{ text.replace(/\s+/g, " ").trim() || "Empty" }}
    </button>

    <div class="actions">
      <template v-if="state.mode === 'query'">
        <button
          class="btn primary"
          :disabled="running || !engine"
          title="Show the plan without running the statement"
          @click="submit(false)"
        >
          <Icon name="play" :size="14" /> Explain <span class="kbd">{{ mod }}+Enter</span>
        </button>
        <button
          class="btn"
          :disabled="running || !engine?.supportsAnalyze || analyzeBlocked"
          :title="
            analyzeBlocked
              ? 'Statements that change data can\'t be analyzed on a read-only connection'
              : 'Run the statement and measure the time and rows of every step'
          "
          @click="submit(true)"
        >
          <Icon name="timer" :size="14" /> Explain Analyze <span class="kbd">{{ mod }}+Shift+Enter</span>
        </button>
        <div v-if="engine?.options.length" ref="optionsEl" class="options">
          <button class="btn ghost" :aria-expanded="optionsOpen" @click="optionsOpen = !optionsOpen">
            <Icon name="tune" :size="14" /> Options
            <span v-if="activeOptions.length" class="hint">{{ activeOptions.join(", ") }}</span>
            <Icon name="chevronDown" :size="12" />
          </button>
          <div v-if="optionsOpen" class="options-menu" role="menu">
            <label
              v-for="option in engine.options"
              :key="option.id"
              class="option"
              :class="{ disabled: optionUnavailable(option) }"
            >
              <input
                type="checkbox"
                :checked="state.options[option.id]"
                :disabled="!!optionUnavailable(option)"
                @change="ex.setOption(option.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>
                <strong>{{ option.label }}</strong>
                <span v-if="option.requiresAnalyze" class="hint"> · Analyze only</span>
                <span v-if="optionUnavailable(option)" class="hint"> · {{ optionUnavailable(option) }}</span>
                <span class="option-description">{{ option.description }}</span>
              </span>
            </label>
          </div>
        </div>
        <span class="spacer" />
        <span v-if="analyzeBlocked" class="hint write-hint">
          This statement changes data, so it can't be analyzed on a read-only connection.
        </span>
        <span v-else-if="writes" class="hint write-hint">
          This statement changes data. Explain Analyze rolls the changes back.
        </span>
      </template>
      <template v-else>
        <button class="btn primary" :disabled="running" @click="submit(false)">
          <Icon name="play" :size="14" /> Visualize <span class="kbd">{{ mod }}+Enter</span>
        </button>
        <span class="spacer" />
        <span class="hint">{{ engine?.pasteHint ?? "Paste a PostgreSQL plan (JSON or text)." }}</span>
      </template>
    </div>
  </header>
</template>

<style scoped>
.query-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel);
}
.bar,
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.spacer {
  flex: 1;
}
.db-label {
  font-size: 0.75rem;
  color: var(--text-light);
}
.editor textarea {
  display: block;
  width: 100%;
  resize: vertical;
  min-height: 52px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--canvas);
  color: var(--text-dark);
  font-size: 0.8125rem;
  line-height: 1.5;
  tab-size: 2;
}
.editor textarea:focus {
  outline: none;
  border-color: var(--input-highlight);
}
.collapsed-preview {
  display: block;
  width: 100%;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--canvas);
  color: var(--text-light);
  font-size: 0.75rem;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.options {
  position: relative;
}
.options .hint {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.options-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  width: 320px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--raised);
  box-shadow: var(--shadow);
}
.option {
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 4px;
  font-size: 0.8125rem;
  cursor: pointer;
}
.option:hover {
  background: var(--subtle);
}
.option.disabled {
  opacity: 0.5;
  cursor: default;
}
.option input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.option-description {
  display: block;
  color: var(--text-light);
  font-size: 0.75rem;
}
.write-hint {
  color: var(--brand-warning);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
