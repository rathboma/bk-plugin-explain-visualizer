import { computed, reactive, shallowRef } from "vue";
import { planStats } from "../core/analysis";
import type { Plan } from "../core/plan";
import { engineForConnection, engineForPlan, ENGINES, supportedDatabaseNames } from "../engines/registry";
import type {
  AnalyzePolicy,
  ExplainEngine,
  ExplainOptionValues,
  ParsedPlan,
  RawFormat,
  ServerInfo,
} from "../engines/types";
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
/** Set once the user has accepted the notice that Explain Analyze runs the statement. */
const ANALYZE_NOTICE_PREFERENCE = "analyzeNoticeAccepted";
/**
 * Asked before the first Explain Analyze, then remembered. Statements that
 * change data ask every time instead, through the engine's policy.
 */
export const ANALYZE_NOTICE = {
  title: "Run the statement?",
  message:
    "Explain Analyze runs the statement to measure every step, so it takes as long as the query does and does the same work on the database. This is asked once; statements that change data are never run without asking.",
  confirmLabel: "Run",
};
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
    analyzeNoticeAccepted: false,
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
  /** The statement in the query box, as the engine reads it. */
  const statement = computed(() =>
    state.mode === "query" && engine.value ? engine.value.inspect(state.query, state.server) : undefined
  );
  /** What Explain Analyze would do with that statement. */
  const analyzePolicy = computed<AnalyzePolicy>(() => {
    const current = engine.value;
    const info = statement.value;
    if (!current?.supportsAnalyze || !info || info.error) return {};
    return current.analyzePolicy(info, { server: state.server, readOnlyConnection: readOnly.value });
  });

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
    void host.setTitle(next.plan.query ? tabTitle(next.plan.query) : "Query Plan");
    persist();
  }

  function fail(message: string) {
    state.status = "error";
    state.error = message;
  }

  /** Loaded once per tab. A failure is not cached, so the next run retries. */
  async function serverInfo(): Promise<ServerInfo | undefined> {
    if (state.server || !engine.value?.loadServerInfo) return state.server;
    try {
      state.server = await engine.value.loadServerInfo(host.runQuery);
    } catch {
      return undefined;
    }
    return state.server;
  }

  /** Either dialog has told the user that Explain Analyze runs the statement. */
  function acceptAnalyzeNotice() {
    if (state.analyzeNoticeAccepted) return;
    state.analyzeNoticeAccepted = true;
    void host.savePreference(ANALYZE_NOTICE_PREFERENCE, true);
  }

  /**
   * Runs EXPLAIN for the query box. `analyze` executes the statement, which
   * the first Explain Analyze says and asks about, unless the user wrote
   * EXPLAIN ANALYZE themselves (`typedAnalyze`). Statements that change data
   * ask every time (the engine's policy), notice or not.
   */
  async function explain(analyze: boolean, typedAnalyze = false) {
    const current = engine.value;
    if (!current) {
      fail("This database is not supported yet.");
      return;
    }
    const server = await serverInfo();
    const statement = current.inspect(state.query, server);
    if (statement.error) return fail(statement.error);

    if (analyze) {
      if (!current.supportsAnalyze) {
        return fail(`${current.displayName} can't measure the steps of a plan, so there is no Explain Analyze. Explain still works.`);
      }
      if (statement.hasParameters) {
        return fail("Statements with parameters can't be analyzed, because they have to run. Replace the parameters with values first.");
      }
      const policy = current.analyzePolicy(statement, { server, readOnlyConnection: readOnly.value });
      if (policy.blocked) return fail(policy.blocked);
      const ask = policy.confirm ?? (state.analyzeNoticeAccepted || typedAnalyze ? undefined : ANALYZE_NOTICE);
      if (ask) {
        const proceed = await host.confirm(ask.title, ask.message, ask.confirmLabel);
        if (proceed === undefined) {
          // Only the engine's confirmation is a safety gate; without a dialog
          // the notice is skipped and a statement that only reads still runs.
          if (policy.confirm) {
            return fail("This version of Beekeeper Studio can't ask for confirmation, so this statement can't be analyzed. Explain (without Analyze) still works.");
          }
        } else if (!proceed) {
          return;
        } else {
          acceptAnalyzeNotice();
        }
      }
    }

    const run = ++runCounter;
    state.status = "running";
    state.error = "";
    state.lastAnalyze = analyze;
    try {
      const output = await current.explain(
        { statement, analyze, options: state.options, server, readOnlyConnection: readOnly.value },
        host.runQuery
      );
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
      return fail(`This doesn't look like a query plan. Plans from ${supportedDatabaseNames()} can be visualized.`);
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
    const [connection, saved, savedOptions, noticeAccepted] = await Promise.all([
      host.connectionInfo(),
      host.viewState<SavedViewState>(),
      host.preference<ExplainOptionValues>(OPTIONS_PREFERENCE),
      host.preference<boolean>(ANALYZE_NOTICE_PREFERENCE),
    ]);
    state.connection = connection;
    state.analyzeNoticeAccepted = noticeAccepted === true;
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
      // Saved first, so reopening the tab restores it rather than running it again.
      persist();
      // Explaining is safe: the statement is planned, not run. ANALYZE only
      // runs automatically when the user wrote EXPLAIN ANALYZE themselves
      // (so without the first-run notice), and never on read-only
      // connections, where it can't be rolled back. A statement the engine
      // won't analyze is explained instead; the query panel says why.
      const current = engine.value;
      if (current) {
        let auto = Boolean(analyze) && current.supportsAnalyze && !readOnly.value;
        if (auto) {
          const server = await serverInfo();
          const info = current.inspect(state.query, server);
          auto = !info.error && !current.analyzePolicy(info, { server, readOnlyConnection: false }).blocked;
        }
        await explain(auto, auto);
      }
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
    statement,
    analyzePolicy,
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
