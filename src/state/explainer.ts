import { computed, reactive, shallowRef } from "vue";
import { planStats } from "../core/analysis";
import type { Plan } from "../core/plan";
import { engineForConnection, engineForPlan, ENGINES } from "../engines/registry";
import type { ExplainEngine, ExplainOptionValues, ParsedPlan, RawFormat, ServerInfo } from "../engines/types";
import { errorMessage, type ConnectionInfo, type Host } from "../host/host";
import type { LaunchInput } from "../host/launch";

export type InputMode = "query" | "paste";
export type ResultView = "diagram" | "table" | "raw";
export type ColorBy = "time" | "cost";

export interface PlanResult extends ParsedPlan {
  engineId: string;
  /** SQL sent to the database; absent for pasted plans. */
  sql?: string;
}

/** What each tab remembers between restarts (Beekeeper Studio stores it). */
export interface SavedViewState {
  version: 1;
  mode: InputMode;
  query: string;
  pasteText: string;
  view: ResultView;
  colorBy: ColorBy;
  result?: { engineId: string; raw: string; rawFormat: RawFormat; sql?: string; query?: string };
}

const OPTIONS_PREFERENCE = "explainOptions";
/** Plans larger than this are not saved with the tab, to keep the app's storage small. */
const MAX_SAVED_PLAN_BYTES = 1_000_000;

export function defaultOptions(engine: ExplainEngine | undefined): ExplainOptionValues {
  return Object.fromEntries((engine?.options ?? []).map((o) => [o.id, o.defaultValue]));
}

/** How a value from a results grid is shown in the paste box. */
function pasteTextFor(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const flat = value.flat(2);
    if (flat.every((v) => typeof v === "string")) return flat.join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function tabTitle(query: string | undefined): string {
  const flat = (query ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "Explain";
  return `Explain: ${flat.length > 28 ? `${flat.slice(0, 28)}…` : flat}`;
}

export function createExplainer(host: Host) {
  const state = reactive({
    ready: false,
    status: "idle" as "idle" | "running" | "done" | "error",
    error: "",
    mode: "query" as InputMode,
    query: "",
    pasteText: "",
    options: {} as ExplainOptionValues,
    view: "diagram" as ResultView,
    colorBy: "time" as ColorBy,
    selectedId: undefined as number | undefined,
    connection: undefined as ConnectionInfo | undefined,
    server: undefined as ServerInfo | undefined,
    lastAnalyze: false,
  });

  const result = shallowRef<PlanResult>();
  const engine = shallowRef<ExplainEngine>();
  let runCounter = 0;

  const plan = computed<Plan | undefined>(() => result.value?.plan);
  const stats = computed(() => (plan.value ? planStats(plan.value) : undefined));
  const selectedNode = computed(() =>
    state.selectedId === undefined ? undefined : plan.value?.nodes[state.selectedId]
  );
  /** Time is only known for analyzed plans; estimates fall back to cost. */
  const colorBy = computed<ColorBy>(() => (plan.value?.analyzed ? state.colorBy : "cost"));
  const readOnly = computed(() => state.connection?.readOnlyMode === true);
  const unsupportedDatabase = computed(() => state.ready && !engine.value);

  function persist() {
    const saved: SavedViewState = {
      version: 1,
      mode: state.mode,
      query: state.query,
      pasteText: state.pasteText.length > MAX_SAVED_PLAN_BYTES ? "" : state.pasteText,
      view: state.view,
      colorBy: state.colorBy,
    };
    const r = result.value;
    if (r && r.raw.length <= MAX_SAVED_PLAN_BYTES) {
      saved.result = { engineId: r.engineId, raw: r.raw, rawFormat: r.rawFormat, sql: r.sql, query: r.plan.query };
    }
    void host.saveViewState(saved);
  }

  function showResult(next: PlanResult) {
    result.value = next;
    state.selectedId = undefined;
    state.status = "done";
    state.error = "";
    void host.setTitle(tabTitle(next.plan.query ?? (state.mode === "paste" ? "pasted plan" : state.query)));
    persist();
  }

  function fail(message: string) {
    state.status = "error";
    state.error = message;
  }

  async function serverInfo(): Promise<ServerInfo | undefined> {
    if (state.server || !engine.value?.loadServerInfo) return state.server;
    try {
      state.server = await engine.value.loadServerInfo(host.runQuery);
    } catch {
      state.server = {};
    }
    return state.server;
  }

  /** Runs EXPLAIN for the query box. `analyze` executes the statement. */
  async function explain(analyze: boolean) {
    const current = engine.value;
    if (!current) {
      fail("This database is not supported yet.");
      return;
    }
    const statement = current.inspect(state.query);
    if (statement.error) return fail(statement.error);

    if (analyze && statement.hasParameters) {
      return fail("Statements with parameters can't be analyzed, because they have to run. Replace the parameters with values first.");
    }
    if (analyze && statement.modifiesData) {
      if (readOnly.value) {
        return fail("This connection is read-only, so a statement that changes data can't be analyzed. Explain (without Analyze) still works.");
      }
      const proceed = await host.confirm(
        "Run this statement?",
        "Explain Analyze runs the statement to measure it. This statement can change data: its changes are rolled back afterwards, but effects outside the database transaction (such as sequence values) are not undone.",
        "Run and Roll Back"
      );
      if (!proceed) return;
    }

    const run = ++runCounter;
    state.status = "running";
    state.error = "";
    state.lastAnalyze = analyze;
    try {
      const server = await serverInfo();
      const output = await current.explain({ statement, analyze, options: state.options, server }, host.runQuery);
      if (run !== runCounter) return;
      showResult({ ...output, engineId: current.id });
    } catch (e) {
      if (run !== runCounter) return;
      fail(errorMessage(e));
    }
  }

  /** Parses a pasted plan, or a value taken from a results grid. */
  function visualize(value: unknown = state.pasteText) {
    if (typeof value === "string" && !value.trim()) return fail("Paste a plan to visualize.");
    const parser = engineForPlan(value, engine.value);
    if (!parser) {
      const names = ENGINES.map((e) => e.displayName).join(", ");
      return fail(`This doesn't look like a query plan. Supported formats: ${names}.`);
    }
    try {
      runCounter++;
      showResult({ ...parser.parse(value), engineId: parser.id });
    } catch (e) {
      fail(errorMessage(e));
    }
  }

  function setOption(id: string, value: boolean) {
    state.options = { ...state.options, [id]: value };
    void host.savePreference(OPTIONS_PREFERENCE, state.options);
  }

  function restore(saved: SavedViewState): boolean {
    if (saved?.version !== 1) return false;
    state.mode = saved.mode;
    state.query = saved.query ?? "";
    state.pasteText = saved.pasteText ?? "";
    state.view = saved.view ?? "diagram";
    state.colorBy = saved.colorBy ?? "time";
    if (saved.result) {
      const parser = ENGINES.find((e) => e.id === saved.result!.engineId);
      try {
        if (parser) {
          const parsed = parser.parse(saved.result.raw);
          parsed.plan.query = saved.result.query;
          result.value = { ...parsed, engineId: parser.id, sql: saved.result.sql };
          state.status = "done";
        }
      } catch {
        // A plan that no longer parses is dropped; the query is still there.
      }
    }
    return true;
  }

  async function init(launch: () => Promise<LaunchInput>) {
    const [connection, saved, savedOptions] = await Promise.all([
      host.connectionInfo(),
      host.viewState<SavedViewState>(),
      host.preference<ExplainOptionValues>(OPTIONS_PREFERENCE),
    ]);
    state.connection = connection;
    engine.value = engineForConnection(connection?.databaseType ?? connection?.connectionType);
    state.options = { ...defaultOptions(engine.value), ...(savedOptions ?? {}) };
    if (!engine.value) state.mode = "paste";
    state.ready = true;

    // A tab that was open before keeps what it showed.
    if (saved && restore(saved)) return;

    const input = await launch();
    if (input.kind === "plan") {
      state.mode = "paste";
      state.pasteText = pasteTextFor(input.value);
      visualize(input.value);
    } else if (input.kind === "query") {
      state.mode = engine.value ? "query" : "paste";
      state.query = input.sql.trim();
      const requested = engine.value?.inspect(state.query).requestedOptions ?? {};
      const { analyze, ...options } = requested;
      if (Object.keys(options).length) state.options = { ...state.options, ...(options as ExplainOptionValues) };
      // Explaining is safe: the statement is planned, not run. ANALYZE only
      // runs automatically when the user wrote EXPLAIN ANALYZE themselves.
      if (engine.value) await explain(Boolean(analyze));
    } else {
      persist();
    }
  }

  return {
    state,
    result,
    engine,
    plan,
    stats,
    selectedNode,
    colorBy,
    readOnly,
    unsupportedDatabase,
    init,
    explain,
    visualize,
    setOption,
    persist,
    select(id: number | undefined) {
      state.selectedId = id;
    },
  };
}

export type Explainer = ReturnType<typeof createExplainer>;
