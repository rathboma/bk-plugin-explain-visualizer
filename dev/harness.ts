/**
 * Stands in for Beekeeper Studio: loads the plugin in an iframe and answers
 * its requests using the same postMessage protocol as the app. Queries are
 * sent to a real database by the dev server (see vite.harness.config.ts), so
 * the plugin can be developed and tested in a plain browser.
 *
 *   PG_URL=postgres://postgres:pw@localhost:5432/postgres \
 *   MYSQL_URL=mysql://root:pw@127.0.0.1:3306/shop yarn harness
 *
 * SQLite needs nothing: a temporary database is seeded on first use.
 * The page reads ?scenario=&db=&theme=&readonly= so tests can drive it.
 */
import cteSubplans from "../tests/fixtures/postgres/cte-subplans.json";
import diskSort from "../tests/fixtures/postgres/disk-sort.json";
import mysqlSubqueries from "../tests/fixtures/mysql/mysql-8.4-subqueries.json";
import sqliteSubqueries from "../tests/fixtures/sqlite/sqlite-3.45-subqueries.json";

const SAMPLE_QUERY = `SELECT c.country, count(*) AS orders, sum(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'pending'
GROUP BY c.country
ORDER BY revenue DESC;`;

/** A statement the user wrote EXPLAIN ANALYZE (or its equivalent) in front of. */
const ANALYZE_QUERY: Record<string, string> = {
  postgresql: `EXPLAIN ANALYZE ${cteSubplans.query}`,
  mysql: `EXPLAIN ANALYZE ${mysqlSubqueries.query}`,
  mariadb: `ANALYZE ${mysqlSubqueries.query}`,
  sqlite: `EXPLAIN QUERY PLAN ${sqliteSubqueries.query}`,
};

/** A plan in a results cell, and a plan spread over a results column, per database. */
function resultsPlans(db: string): { cell: unknown; range?: unknown[][]; column: unknown[][] } {
  if (db === "mysql" || db === "mariadb") {
    const tree = mysqlSubqueries.outputs.treeAnalyze;
    return { cell: tree, column: [[tree]] };
  }
  if (db === "sqlite") {
    const rows = sqliteSubqueries.rows;
    return { cell: rows[0][3], range: rows, column: rows.map((r) => [r[3]]) };
  }
  return { cell: cteSubplans.json, column: diskSort.text.split("\n").map((line) => [line]) };
}

interface Scenario {
  label: string;
  command: string;
  params?: (db: string) => unknown;
}

const SCENARIOS: Record<string, Scenario> = {
  editor: {
    label: "Query editor menu",
    command: "explain-query",
    params: () => ({ text: `SELECT 1;\n\n${SAMPLE_QUERY}`, selectedText: "", selectedQuery: SAMPLE_QUERY }),
  },
  "editor-analyze": {
    label: "Editor: EXPLAIN ANALYZE …",
    command: "explain-query",
    params: (db) => ({ text: ANALYZE_QUERY[db] ?? ANALYZE_QUERY.postgresql, selectedText: "", selectedQuery: "" }),
  },
  "editor-write": {
    label: "Editor: UPDATE statement",
    command: "explain-query",
    params: () => ({ text: "UPDATE products SET price = price * 1.1 WHERE category = 'toys'", selectedText: "", selectedQuery: "" }),
  },
  "new-tab": { label: "New tab menu", command: "new-explain" },
  "cell-json": {
    label: "Results cell (a plan)",
    command: "visualize-cell",
    params: (db) => {
      const { cell, range } = resultsPlans(db);
      return { target: { type: "cell", row: 1, column: "QUERY PLAN", value: cell }, activeRange: range ? { value: range } : undefined };
    },
  },
  "column-text": {
    label: "Results column (text plan)",
    command: "visualize-column",
    params: (db) => ({ target: { type: "column", column: "QUERY PLAN", value: resultsPlans(db).column } }),
  },
};

const THEMES = {
  dark: {
    "--font-size": "0.875rem",
    "--theme-bg": "#181818",
    "--theme-base": "#fff",
    "--theme-primary": "#fad83b",
    "--theme-secondary": "#4ad0ff",
    "--text-dark": "rgba(255, 255, 255, 0.87)",
    "--text": "rgba(255, 255, 255, 0.67)",
    "--text-light": "rgba(255, 255, 255, 0.57)",
    "--text-lighter": "rgba(255, 255, 255, 0.37)",
    "--text-hint": "rgba(255, 255, 255, 0.37)",
    "--brand-info": "#4ad0ff",
    "--brand-success": "#15db95",
    "--brand-warning": "#ff8d21",
    "--brand-danger": "#ff5d59",
    "--brand-purple": "#9858ff",
    "--border-color": "rgba(255, 255, 255, 0.1)",
    "--link-color": "rgba(255, 255, 255, 0.87)",
    "--selection": "rgba(250, 216, 59, 0.2)",
    "--input-highlight": "rgba(255, 255, 255, 0.27)",
    "--query-editor-bg": "#090909",
  },
  light: {
    "--font-size": "0.875rem",
    "--theme-bg": "#f8f8f8",
    "--theme-base": "black",
    "--theme-primary": "#f9ce09",
    "--theme-secondary": "#0099ff",
    "--text-dark": "rgba(0, 0, 0, 0.87)",
    "--text": "rgba(0, 0, 0, 0.67)",
    "--text-light": "rgba(0, 0, 0, 0.57)",
    "--text-lighter": "rgba(0, 0, 0, 0.37)",
    "--text-hint": "rgba(0, 0, 0, 0.37)",
    "--brand-info": "#3498db",
    "--brand-success": "#15db95",
    "--brand-warning": "#dc700c",
    "--brand-danger": "#ff5d59",
    "--brand-purple": "#9858ff",
    "--border-color": "rgba(0, 0, 0, 0.15)",
    "--link-color": "rgba(0, 0, 0, 0.87)",
    "--selection": "rgba(249, 206, 9, 0.2)",
    "--input-highlight": "rgba(0, 0, 0, 0.27)",
    "--query-editor-bg": "white",
  },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = $<HTMLIFrameElement>("plugin");
const scenarioSelect = $<HTMLSelectElement>("scenario");
const databaseSelect = $<HTMLSelectElement>("database");
const themeSelect = $<HTMLSelectElement>("theme");
const readOnlyBox = $<HTMLInputElement>("readonly");
const keepStateBox = $<HTMLInputElement>("keep-state");
const logEl = $<HTMLPreElement>("log");

const query = new URLSearchParams(location.search);
for (const [key, s] of Object.entries(SCENARIOS)) scenarioSelect.add(new Option(s.label, key));
scenarioSelect.value = query.get("scenario") ?? "editor";
databaseSelect.value = query.get("db") ?? "postgresql";
themeSelect.value = query.get("theme") ?? "dark";
readOnlyBox.checked = query.get("readonly") === "1";

const STATE_KEY = "harness-view-state";
let viewState: unknown = keepStateBox.checked ? JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null") : undefined;
const storage = new Map<string, unknown>();

function log(line: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${line}\n${logEl.textContent}`.slice(0, 5000);
}

function theme() {
  const vars = THEMES[themeSelect.value as keyof typeof THEMES];
  const cssString = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join("");
  return { type: themeSelect.value, palette: vars, cssString };
}

async function runQuery(sql: string) {
  log(`runQuery: ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
  const response = await fetch("/__harness/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, db: databaseSelect.value }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return { results: body.results };
}

async function handle(name: string, args: Record<string, unknown>): Promise<unknown> {
  const scenario = SCENARIOS[scenarioSelect.value];
  switch (name) {
    case "getConnectionInfo":
      return {
        connectionType: databaseSelect.value,
        databaseType: databaseSelect.value,
        id: 1,
        workspaceId: -1,
        connectionName: "Harness",
        databaseName: databaseSelect.value === "postgresql" ? "postgres" : "shop",
        defaultSchema: "public",
        readOnlyMode: readOnlyBox.checked,
      };
    case "getViewContext":
      return { command: scenario.command, params: scenario.params?.(databaseSelect.value) };
    case "getAppInfo":
      return { version: "5.5.0", theme: theme() };
    case "getViewState":
      return viewState;
    case "setViewState":
      viewState = args.state;
      if (keepStateBox.checked) sessionStorage.setItem(STATE_KEY, JSON.stringify(viewState));
      return undefined;
    case "getData":
      return storage.get(String(args.key)) ?? null;
    case "setData":
      storage.set(String(args.key), args.value);
      return undefined;
    case "runQuery":
      return runQuery(String(args.query));
    case "setTabTitle":
      $("tab-title").textContent = String(args.title);
      return undefined;
    case "confirm":
      return window.confirm(`${args.title}\n\n${args.message}`);
    case "clipboard.writeText":
      await navigator.clipboard?.writeText(String(args.text)).catch(() => undefined);
      return undefined;
    case "noty.success":
    case "noty.error":
    case "noty.info":
    case "noty.warning":
    case "openTab":
    case "requestFileSave":
      log(`${name}: ${JSON.stringify(args).slice(0, 200)}`);
      return undefined;
    default:
      throw new Error(`Unknown request: ${name}`);
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== iframe.contentWindow) return;
  const { id, name, args } = event.data ?? {};
  if (!id) return; // notifications, e.g. forwarded window events
  try {
    const result = await handle(name, args ?? {});
    iframe.contentWindow!.postMessage({ id, result }, "*");
  } catch (e) {
    const error = e as Error;
    log(`error ${name}: ${error.message}`);
    iframe.contentWindow!.postMessage({ id, error: { name: "Error", message: error.message } }, "*");
  }
});

function load() {
  if (!keepStateBox.checked) viewState = undefined;
  $("tab-title").textContent = "Explain Visualizer";
  iframe.src = `/index.html?t=${Date.now()}`;
}

themeSelect.addEventListener("change", () => {
  iframe.contentWindow?.postMessage({ name: "themeChanged", args: theme() }, "*");
  document.body.style.background = themeSelect.value === "dark" ? "#222" : "#ddd";
});
scenarioSelect.addEventListener("change", load);
databaseSelect.addEventListener("change", load);
readOnlyBox.addEventListener("change", load);
$("reload").addEventListener("click", load);
load();
