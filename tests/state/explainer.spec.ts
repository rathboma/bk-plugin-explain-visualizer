// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createExplainer, type SavedViewState } from "../../src/state/explainer";
import { launchInput } from "../../src/host/launch";
import type { Host } from "../../src/host/host";
import { mysqlFixture, postgresFixture, sqliteFixture, sqliteResult } from "../fixtures/load";

const fixture = postgresFixture("hash-join-aggregate");

function fakeHost(
  { runQuery: answer, ...overrides }: Partial<Host> = {},
  options: { readOnly?: boolean; db?: string; saved?: unknown } = {}
) {
  const queries: string[] = [];
  let saved: unknown = options.saved;
  const host = {
    connectionInfo: async () => ({
      connectionType: options.db ?? "postgresql",
      databaseType: options.db ?? "postgresql",
      id: 1,
      workspaceId: -1,
      connectionName: "test",
      databaseName: "test",
      readOnlyMode: options.readOnly ?? false,
    }),
    viewContext: async () => undefined,
    appInfo: async () => undefined,
    viewState: async () => saved,
    saveViewState: async (state: unknown) => {
      saved = state;
    },
    preference: async () => undefined,
    savePreference: async () => undefined,
    runQuery: async (sql: string) => {
      queries.push(sql);
      if (answer) return answer(sql);
      if (sql.includes("current_setting")) {
        return [{ fields: [{ name: "version" }, { name: "scs" }], rows: [{ version: "170000", scs: "on" }] }];
      }
      return [{ fields: [{ name: "QUERY PLAN" }], rows: [{ "QUERY PLAN": fixture.json }] }];
    },
    setTitle: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    copy: async () => undefined,
    saveFile: async () => undefined,
    openQueryTab: async () => undefined,
    notifyError: async () => undefined,
    onThemeChange: () => undefined,
    ...overrides,
  } as unknown as Host;
  return { host, queries, saved: () => saved as SavedViewState };
}

const editorLaunch = (text: string) => async () =>
  launchInput({ command: "explain-query", params: { text, selectedText: "", selectedQuery: "" } } as never);

describe("explainer", () => {
  it("explains a query from the editor without running it", async () => {
    const { host, queries, saved } = fakeHost();
    const ex = createExplainer(host);
    await ex.init(editorLaunch("SELECT * FROM orders"));

    expect(queries).toEqual([
      "SELECT current_setting('server_version_num') AS version, current_setting('standard_conforming_strings') AS scs",
      "EXPLAIN (FORMAT JSON) SELECT * FROM orders",
    ]);
    expect(ex.state.status).toBe("done");
    expect(ex.plan.value?.nodes.length).toBe(9);
    expect(host.setTitle).toHaveBeenCalledWith("Explain: SELECT * FROM orders");
    expect(saved().result?.rawFormat).toBe("json");
  });

  it("honours an EXPLAIN ANALYZE the user wrote", async () => {
    const { host, queries } = fakeHost();
    const ex = createExplainer(host);
    await ex.init(editorLaunch("explain (analyze, verbose) SELECT 1"));
    expect(queries[1]).toBe("EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON) SELECT 1;\nROLLBACK;");
  });

  it("asks before analyzing a statement that changes data, and stops if declined", async () => {
    const confirm = vi.fn(async () => false);
    const { host, queries } = fakeHost({ confirm });
    const ex = createExplainer(host);
    await ex.init(async () => ({ kind: "empty" }));
    ex.state.query = "DELETE FROM orders";
    await ex.explain(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(queries.filter((q) => q.startsWith("EXPLAIN"))).toEqual([]);
    expect(ex.state.status).toBe("idle");

    confirm.mockResolvedValueOnce(true);
    await ex.explain(true);
    expect(queries.at(-1)).toMatch(/^EXPLAIN \(ANALYZE.*\) DELETE FROM orders;\nROLLBACK;$/);
  });

  it("refuses to analyze writes on a read-only connection", async () => {
    const { host, queries } = fakeHost({}, { readOnly: true });
    const ex = createExplainer(host);
    await ex.init(async () => ({ kind: "empty" }));
    ex.state.query = "UPDATE orders SET total = 0";
    await ex.explain(true);
    expect(queries.filter((q) => q.startsWith("EXPLAIN"))).toEqual([]);
    expect(ex.state.error).toMatch(/read-only/);

    await ex.explain(false);
    expect(ex.state.status).toBe("done");
  });

  it("shows database errors", async () => {
    const { host } = fakeHost({
      runQuery: async (sql: string) => {
        if (sql.includes("current_setting")) return [];
        throw Object.assign(new Error('relation "nope" does not exist'), { name: "Error" });
      },
    });
    const ex = createExplainer(host);
    await ex.init(editorLaunch("SELECT * FROM nope"));
    expect(ex.state.status).toBe("error");
    expect(ex.state.error).toBe('relation "nope" does not exist');
  });

  it("does not run EXPLAIN ANALYZE automatically on read-only connections", async () => {
    const { host, queries } = fakeHost({}, { readOnly: true });
    const ex = createExplainer(host);
    await ex.init(editorLaunch("EXPLAIN ANALYZE SELECT * FROM orders"));
    expect(queries.at(-1)).toBe("EXPLAIN (FORMAT JSON) SELECT * FROM orders");

    await ex.explain(true);
    expect(queries.at(-1)).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders");
  });

  it("refuses to analyze writes when the app can't ask for confirmation", async () => {
    const { host, queries } = fakeHost({ confirm: vi.fn(async () => undefined) });
    const ex = createExplainer(host);
    await ex.init(async () => ({ kind: "empty" }));
    ex.state.query = "DELETE FROM orders";
    await ex.explain(true);
    expect(ex.state.error).toMatch(/can't ask for confirmation/);
    expect(queries.filter((q) => q.startsWith("EXPLAIN"))).toEqual([]);
  });

  it("saves the tab before its first run, so a reload does not run it again", async () => {
    const first = fakeHost({ confirm: vi.fn(async () => false) });
    await createExplainer(first.host).init(editorLaunch("EXPLAIN ANALYZE DELETE FROM orders"));
    expect(first.queries.filter((q) => q.startsWith("EXPLAIN"))).toEqual([]);
    expect(first.saved().query).toBe("EXPLAIN ANALYZE DELETE FROM orders");

    const second = fakeHost({}, { saved: first.saved() });
    await createExplainer(second.host).init(editorLaunch("EXPLAIN ANALYZE DELETE FROM orders"));
    expect(second.queries).toEqual([]);
    expect(second.host.confirm).not.toHaveBeenCalled();
  });

  it("retries the server version after a failure", async () => {
    let calls = 0;
    const { host } = fakeHost({
      runQuery: async (sql: string) => {
        if (sql.includes("current_setting")) {
          calls++;
          if (calls === 1) throw new Error("network blip");
          return [{ fields: [{ name: "version" }, { name: "scs" }], rows: [{ version: "160000", scs: "on" }] }];
        }
        return [{ fields: [{ name: "QUERY PLAN" }], rows: [{ "QUERY PLAN": fixture.json }] }];
      },
    });
    const ex = createExplainer(host);
    await ex.init(editorLaunch("SELECT 1"));
    expect(ex.state.server).toBeUndefined();
    await ex.explain(false);
    expect(ex.state.server?.version).toBe(160000);
  });

  it("restores a saved tab without running anything", async () => {
    const first = fakeHost();
    const ex1 = createExplainer(first.host);
    await ex1.init(editorLaunch("SELECT * FROM orders"));
    ex1.state.view = "table";
    ex1.persist();

    const second = fakeHost({}, { saved: first.saved() });
    const ex2 = createExplainer(second.host);
    await ex2.init(editorLaunch("SELECT 'ignored'"));
    expect(second.queries).toEqual([]);
    expect(ex2.state.view).toBe("table");
    expect(ex2.state.query).toBe("SELECT * FROM orders");
    expect(ex2.plan.value?.query).toBe("SELECT * FROM orders");
    expect(ex2.plan.value?.nodes.length).toBe(9);
  });

  it("visualizes a plan from a results cell, even on unsupported databases", async () => {
    const { host, queries } = fakeHost({}, { db: "oracle" });
    const ex = createExplainer(host);
    await ex.init(async () =>
      launchInput({ command: "visualize-cell", params: { target: { type: "cell", value: fixture.json } } } as never)
    );
    expect(ex.engine.value).toBeUndefined();
    expect(ex.unsupportedDatabase.value).toBe(true);
    expect(ex.state.mode).toBe("paste");
    expect(ex.plan.value?.root.operation).toBe("Sort");
    expect(queries).toEqual([]);
  });

  it("visualizes a text plan from the Visualize menu", async () => {
    const { host } = fakeHost();
    const ex = createExplainer(host);
    const rows = fixture.text.split("\n").map((line) => [line]);
    await ex.init(async () =>
      launchInput({ command: "visualize-result", params: { source: "result", target: { value: rows } } } as never)
    );
    expect(ex.result.value?.rawFormat).toBe("text");
    expect(ex.state.pasteText).toBe(fixture.text);
  });

  it("visualizes a text plan from a results column", async () => {
    const { host } = fakeHost();
    const ex = createExplainer(host);
    const column = fixture.text.split("\n").map((line) => [line]);
    await ex.init(async () =>
      launchInput({ command: "visualize-column", params: { target: { type: "column", value: column } } } as never)
    );
    expect(ex.result.value?.rawFormat).toBe("text");
    expect(ex.state.pasteText).toBe(fixture.text);
  });

  it("explains pasted text that is not a plan as an error", async () => {
    const { host } = fakeHost();
    const ex = createExplainer(host);
    await ex.init(async () => ({ kind: "empty" }));
    ex.state.pasteText = "hello world";
    ex.visualize();
    expect(ex.state.error).toMatch(/doesn't look like a query plan/);
  });
});

describe("explainer with MySQL, MariaDB and SQLite", () => {
  const tree = mysqlFixture("mysql-8.4-join-aggregate").outputs;
  /** A host for MySQL-family servers that answers EXPLAIN like the given server. */
  function mysqlHost(version: string, options: { readOnly?: boolean; db?: string } = {}) {
    return fakeHost(
      {
        runQuery: async (sql: string) => {
          if (sql.startsWith("SELECT VERSION()")) {
            return [{ fields: [{ name: "version" }, { name: "sql_mode" }], rows: [{ version, sql_mode: "" }] }];
          }
          const output = sql.startsWith("EXPLAIN ANALYZE") ? tree.treeAnalyze : tree.tree;
          return [{ fields: [{ name: "EXPLAIN" }], rows: [{ EXPLAIN: output }] }];
        },
      },
      { db: options.db ?? "mysql", readOnly: options.readOnly }
    );
  }
  const sent = (queries: string[]) => queries.filter((q) => !q.startsWith("SELECT VERSION()"));

  it("explains a MySQL query with the tree format and shows the server", async () => {
    const { host, queries } = mysqlHost("8.4.2");
    const ex = createExplainer(host);
    await ex.init(editorLaunch("SELECT * FROM orders"));
    expect(sent(queries)).toEqual(["EXPLAIN FORMAT=TREE SELECT * FROM orders"]);
    expect(ex.state.server).toMatchObject({ productName: "MySQL", versionLabel: "8.4.2" });
    expect(ex.plan.value?.engine).toBe("mysql");
  });

  it("runs an EXPLAIN ANALYZE the user wrote for a SELECT", async () => {
    const { host, queries } = mysqlHost("8.4.2");
    await createExplainer(host).init(editorLaunch("EXPLAIN ANALYZE SELECT * FROM orders"));
    expect(sent(queries)).toEqual(["EXPLAIN ANALYZE SELECT * FROM orders"]);
  });

  it("explains, rather than analyzes, a write: MySQL would commit it", async () => {
    const { host, queries } = mysqlHost("8.4.2");
    const ex = createExplainer(host);
    await ex.init(editorLaunch("EXPLAIN ANALYZE UPDATE orders SET total = 0"));
    expect(sent(queries)).toEqual(["EXPLAIN FORMAT=TREE UPDATE orders SET total = 0"]);
    expect(host.confirm).not.toHaveBeenCalled();
    expect(ex.analyzePolicy.value.blocked).toMatch(/would commit/);

    await ex.explain(true);
    expect(ex.state.error).toMatch(/would commit/);
    expect(sent(queries)).toHaveLength(1);
  });

  it("explains instead of analyzing on servers without EXPLAIN ANALYZE", async () => {
    const { host, queries } = mysqlHost("5.7.44");
    const ex = createExplainer(host);
    await ex.init(editorLaunch("EXPLAIN ANALYZE SELECT 1"));
    expect(sent(queries)).toEqual(["EXPLAIN FORMAT=JSON SELECT 1"]);
    expect(ex.analyzePolicy.value.blocked).toMatch(/8\.0\.18/);
  });

  it("names MariaDB, even on a MySQL connection, and blocks its ANALYZE on read-only connections", async () => {
    const { host } = mysqlHost("11.4.2-MariaDB", { readOnly: true });
    const ex = createExplainer(host);
    await ex.init(editorLaunch("SELECT 1"));
    expect(ex.state.server?.productName).toBe("MariaDB");
    expect(ex.analyzePolicy.value.blocked).toMatch(/read-only/i);
  });

  it("explains a SQLite query, and has no Explain Analyze", async () => {
    const fixture = sqliteFixture("sqlite-3.45-join-aggregate");
    const { host, queries } = fakeHost(
      {
        runQuery: async (sql: string) =>
          sql.startsWith("SELECT sqlite_version()")
            ? [{ fields: [{ name: "version" }], rows: [{ version: "3.45.1" }] }]
            : [sqliteResult(fixture)],
      },
      { db: "sqlite" }
    );
    const ex = createExplainer(host);
    await ex.init(editorLaunch("EXPLAIN QUERY PLAN SELECT 1"));
    expect(queries.at(-1)).toBe("EXPLAIN QUERY PLAN SELECT 1");
    expect(ex.plan.value?.root.operation).toBe("Query plan");
    expect(ex.stats.value?.metrics).toEqual({ time: false, cost: false, estimatedRows: false, actualRows: false });

    await ex.explain(true);
    expect(ex.state.error).toMatch(/SQLite can't measure/);
  });

  it("visualizes another database's plan on any connection", async () => {
    const { host } = fakeHost({}, { db: "sqlite" });
    const ex = createExplainer(host);
    await ex.init(async () => ({ kind: "empty" }));
    ex.visualize(tree.treeAnalyze);
    expect(ex.result.value?.engineId).toBe("mysql");
    ex.visualize(fixture.text);
    expect(ex.result.value?.engineId).toBe("postgresql");
  });
});

describe("launchInput", () => {
  it("prefers the selection, then the statement under the cursor, then the editor", () => {
    const ctx = (params: object) => ({ command: "explain-query", params }) as never;
    expect(launchInput(ctx({ text: "a", selectedText: "b", selectedQuery: "c" }))).toEqual({ kind: "query", sql: "b" });
    expect(launchInput(ctx({ text: "a", selectedText: " ", selectedQuery: "c" }))).toEqual({ kind: "query", sql: "c" });
    expect(launchInput(ctx({ text: "a", selectedText: "", selectedQuery: "" }))).toEqual({ kind: "query", sql: "a" });
    expect(launchInput(ctx({ text: "", selectedText: "", selectedQuery: "" }))).toEqual({ kind: "empty" });
  });

  it("uses the selected range for a text plan cell", () => {
    const value = launchInput({
      command: "visualize-cell",
      params: { target: { value: "Seq Scan on t" }, activeRange: { value: [["Limit"], ["  ->  Seq Scan on t"]] } },
    } as never);
    expect(value).toEqual({ kind: "plan", value: [["Limit"], ["  ->  Seq Scan on t"]] });
  });

  it("takes the whole result from the Visualize menu", () => {
    const ctx = (value: unknown[][]) =>
      ({ command: "visualize-result", params: { source: "result", target: { value } } }) as never;
    // A JSON plan is a single cell
    expect(launchInput(ctx([['[{"Plan": {}}]']]))).toEqual({ kind: "plan", value: '[{"Plan": {}}]' });
    // A text plan is one row per line
    expect(launchInput(ctx([["Limit"], ["  ->  Seq Scan on t"]]))).toEqual({
      kind: "plan",
      value: [["Limit"], ["  ->  Seq Scan on t"]],
    });
    expect(launchInput(ctx([]))).toEqual({ kind: "empty" });
  });

  it("opens empty from the new tab menu", () => {
    expect(launchInput({ command: "new-explain" } as never)).toEqual({ kind: "empty" });
    expect(launchInput(undefined)).toEqual({ kind: "empty" });
  });
});
