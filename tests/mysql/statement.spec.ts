import { describe, expect, it } from "vitest";
import { inspectStatement } from "../../src/engines/mysql/statement";
import { capabilities, parseServerInfo } from "../../src/engines/mysql/server";
import { mysql } from "../../src/engines/mysql";
import type { QueryResultLike, RunQuery } from "../../src/engines/types";
import { mysqlFixture } from "../fixtures/load";

const mysql84 = parseServerInfo("8.4.2", "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES");

describe("reading MySQL statements", () => {
  it.each([
    ["SELECT * FROM t", false],
    ["  select 1;  ", false],
    ["WITH x AS (SELECT 1) SELECT * FROM x", false],
    ["(SELECT 1) UNION (SELECT 2)", false],
    ["TABLE t", false],
    ["VALUES ROW(1, 2)", false],
    ["SELECT * FROM t FOR UPDATE", false],
    ["SELECT REPLACE(name, 'a', 'b'), INSERT(name, 1, 2, 'x') FROM t", false],
    ["UPDATE t SET a = 1", true],
    ["DELETE FROM t", true],
    ["INSERT INTO t VALUES (1)", true],
    ["REPLACE t VALUES (1)", true],
    ["WITH x AS (SELECT 1) DELETE t FROM t JOIN x", true],
    ["SELECT * INTO OUTFILE '/tmp/x' FROM t", true],
    ["SELECT a INTO @a FROM t", true],
    ["CALL proc()", true],
    ["CREATE TABLE t (a int)", true],
  ])("%s → writes: %s", (sql, writes) => {
    const info = inspectStatement(sql, mysql84);
    expect(info.error).toBeUndefined();
    expect(info.modifiesData).toBe(writes);
  });

  it("removes an EXPLAIN prefix the user wrote, and honours ANALYZE", () => {
    expect(inspectStatement("EXPLAIN SELECT 1")).toMatchObject({ statement: "SELECT 1", requestedOptions: {} });
    expect(inspectStatement("EXPLAIN FORMAT=JSON SELECT 1").statement).toBe("SELECT 1");
    expect(inspectStatement("explain analyze select 1;")).toMatchObject({ statement: "select 1", requestedOptions: { analyze: true } });
    expect(inspectStatement("EXPLAIN ANALYZE FORMAT=TREE SELECT 1").requestedOptions).toEqual({ analyze: true });
    expect(inspectStatement("DESCRIBE SELECT 1").statement).toBe("SELECT 1");
    expect(inspectStatement("EXPLAIN EXTENDED SELECT 1").statement).toBe("SELECT 1");
    expect(inspectStatement("EXPLAIN FORMAT=JSON INTO @plan SELECT 1").statement).toBe("SELECT 1");
    // MariaDB's ANALYZE runs the statement.
    expect(inspectStatement("ANALYZE FORMAT=JSON SELECT 1")).toMatchObject({ statement: "SELECT 1", requestedOptions: { analyze: true } });
    // ANALYZE TABLE is a statement of its own.
    expect(inspectStatement("ANALYZE TABLE t").modifiesData).toBe(true);
  });

  it("refuses EXPLAIN forms that have no statement to plan", () => {
    expect(inspectStatement("DESCRIBE orders").error).toMatch(/describes the table/);
    expect(inspectStatement("EXPLAIN orders").error).toMatch(/describes the table/);
    expect(inspectStatement("EXPLAIN FOR CONNECTION 12").error).toMatch(/FOR CONNECTION/);
    expect(inspectStatement("EXPLAIN").error).toMatch(/No SQL statement/);
    expect(inspectStatement("  ").error).toMatch(/No SQL statement/);
  });

  it("refuses placeholders, which EXPLAIN can't plan", () => {
    expect(inspectStatement("SELECT * FROM t WHERE id = ?").error).toMatch(/parameter \(\?\)/);
    expect(inspectStatement("SELECT * FROM t WHERE id = :id").error).toMatch(/parameter \(:id\)/);
    // User and system variables are not placeholders.
    expect(inspectStatement("SELECT @a, @@version").error).toBeUndefined();
  });

  describe("finds hidden statements the way MySQL's scanner would", () => {
    it.each([
      // The contents of /*! ... */ run on MySQL: a semicolon there is a second statement.
      ["SELECT 1 /*! ; DROP TABLE t */", 2],
      ["SELECT 1 /*!50700 ; DROP TABLE t */", 2],
      ["SELECT 1 /*M!100100 ; DROP TABLE t */", 2],
      // Optimizer hints and plain comments are comments.
      ["SELECT /*+ NO_INDEX(t) */ 1 /* ; */", 1],
      ["SELECT 1 # ; DROP TABLE t", 1],
      ["SELECT 1 -- ; DROP TABLE t", 1],
      // Without a space, -- is two minus signs: the ; that follows is real.
      ["SELECT 1--1; DROP TABLE t", 2],
      ["SELECT 'it''s; fine', \"a \"\" ; b\"", 1],
      ["SELECT `odd;name` FROM t", 1],
      // A backslash before a quote: one string, or not, depending on the SQL mode.
      ["SELECT 'it\\'s; fine'", "mode"],
      ['SELECT "a \\" ; b"', "mode"],
    ])("%s → %s statement(s)", (sql, count) => {
      const info = inspectStatement(sql, mysql84);
      if (count === 1) expect(info.error).toBeUndefined();
      else if (count === "mode") expect(info.error).toMatch(/under some SQL modes/);
      else expect(info.error).toMatch(new RegExp(`Found ${count} statements`));
    });

    it("refuses text that reads as several statements under any SQL mode", () => {
      // Without NO_BACKSLASH_ESCAPES this is one string; with it, three
      // statements. A pooled connection may have either mode.
      const sql = "SELECT 'a\\'; DROP TABLE t; SELECT '";
      expect(inspectStatement(sql, parseServerInfo("8.0.36", "NO_BACKSLASH_ESCAPES")).error).toMatch(/Found 3 statements/);
      expect(inspectStatement(sql, mysql84).error).toMatch(/under some SQL modes/);
      expect(inspectStatement('SELECT "a\\"; DROP TABLE t; -- "', mysql84).error).toMatch(/under some SQL modes/);
      // Plain backslashes and quotes are fine in every mode.
      expect(inspectStatement("SELECT 'it\\'s', \"a\\b\" FROM t", mysql84).error).toBeUndefined();
    });

    it("reads ANSI_QUOTES names as names, and treats a write in any mode as a write", () => {
      const ansi = parseServerInfo("8.0.36", "ANSI_QUOTES");
      // "update" is a name with ANSI_QUOTES, a string without: neither writes.
      expect(inspectStatement('SELECT "update" FROM t', ansi).modifiesData).toBe(false);
      expect(inspectStatement('SELECT "update" FROM t', mysql84).modifiesData).toBe(false);
    });
  });
});

describe("MySQL servers", () => {
  it("reads the version string of every server family", () => {
    expect(parseServerInfo("8.4.2")).toMatchObject({ flavor: "mysql", productName: "MySQL", version: 80402, versionLabel: "8.4.2" });
    expect(parseServerInfo("5.7.44-log")).toMatchObject({ flavor: "mysql", version: 50744 });
    expect(parseServerInfo("10.6.18-MariaDB-1:10.6.18+maria~ubu2004")).toMatchObject({ flavor: "mariadb", productName: "MariaDB", version: 100618 });
    expect(parseServerInfo("8.0.11-TiDB-v7.5.0")).toMatchObject({ flavor: "tidb", productName: "TiDB", versionLabel: "7.5.0" });
    expect(parseServerInfo("8.0.36", "ANSI,NO_BACKSLASH_ESCAPES")).toMatchObject({ ansiQuotes: true, noBackslashEscapes: true });
  });

  it("uses each server's newest way to explain", () => {
    expect(capabilities(parseServerInfo("8.4.2"))).toEqual({ tree: true, json: true, analyze: "explain-analyze" });
    expect(capabilities(parseServerInfo("8.0.18"))).toEqual({ tree: true, json: true, analyze: "explain-analyze" });
    expect(capabilities(parseServerInfo("8.0.17"))).toMatchObject({ tree: false, json: true, noAnalyzeReason: expect.stringMatching(/8\.0\.18/) });
    expect(capabilities(parseServerInfo("5.7.44"))).toMatchObject({ tree: false, json: true, noAnalyzeReason: expect.stringMatching(/8\.0\.18/) });
    expect(capabilities(parseServerInfo("5.5.62"))).toMatchObject({ tree: false, json: false });
    expect(capabilities(parseServerInfo("10.4.34-MariaDB"))).toEqual({ tree: false, json: true, analyze: "mariadb-analyze" });
    expect(capabilities(parseServerInfo("10.0.38-MariaDB"))).toMatchObject({ json: false, noAnalyzeReason: expect.stringMatching(/10\.1/) });
    expect(capabilities(undefined)).toEqual({ tree: true, json: true, analyze: "explain-analyze" });
  });
});

describe("Explain Analyze on MySQL", () => {
  const select = inspectStatement("SELECT * FROM t");
  const update = inspectStatement("UPDATE t SET a = 1");
  const context = (server: string, readOnlyConnection = false) => ({ server: parseServerInfo(server), readOnlyConnection });

  it("only runs statements that read", () => {
    expect(mysql.analyzePolicy(select, context("8.4.2"))).toEqual({});
    // Its changes would be committed: there is no safe way to roll them back.
    expect(mysql.analyzePolicy(update, context("8.4.2")).blocked).toMatch(/MySQL would commit its changes/);
    expect(mysql.analyzePolicy(update, context("11.4.2-MariaDB")).blocked).toMatch(/MariaDB would commit/);
  });

  it("needs a server that has it", () => {
    expect(mysql.analyzePolicy(select, context("5.7.44")).blocked).toMatch(/needs MySQL 8\.0\.18/);
    expect(mysql.analyzePolicy(select, context("8.0.11-TiDB-v7.5.0")).blocked).toMatch(/TiDB/);
  });

  it("is not available for MariaDB on read-only connections, where ANALYZE is refused", () => {
    expect(mysql.analyzePolicy(select, context("11.4.2-MariaDB", true)).blocked).toMatch(/read-only/i);
    expect(mysql.analyzePolicy(select, context("8.4.2", true))).toEqual({});
  });
});

describe("explaining through the host", () => {
  const plan = (column: string, value: string): QueryResultLike[] => [{ fields: [{ name: column }], rows: [{ [column]: value }] }];
  function host(answers: Record<string, () => QueryResultLike[]>) {
    const sent: string[] = [];
    const run: RunQuery = async (sql) => {
      sent.push(sql);
      const answer = Object.entries(answers).find(([prefix]) => sql.startsWith(prefix));
      if (!answer) throw new Error(`You have an error in your SQL syntax near '${sql.slice(0, 20)}'`);
      return answer[1]();
    };
    return { run, sent };
  }
  const request = (sql: string, analyze: boolean, server?: string) => ({
    statement: inspectStatement(sql),
    analyze,
    options: {},
    server: server ? parseServerInfo(server) : undefined,
  });

  it("asks MySQL 8.0.18+ for the tree, and EXPLAIN ANALYZE when analyzing", async () => {
    const fixture = mysqlFixture("mysql-8.4-join-aggregate");
    const { run, sent } = host({
      "EXPLAIN FORMAT=TREE": () => plan("EXPLAIN", fixture.outputs.tree!),
      "EXPLAIN ANALYZE": () => plan("EXPLAIN", fixture.outputs.treeAnalyze!),
    });
    const estimate = await mysql.explain(request(fixture.query, false, "8.4.2"), run);
    expect(estimate).toMatchObject({ rawFormat: "text", sql: `EXPLAIN FORMAT=TREE ${fixture.query}` });
    expect(estimate.plan.query).toBe(fixture.query);
    const actual = await mysql.explain(request(fixture.query, true, "8.4.2"), run);
    expect(actual.plan.analyzed).toBe(true);
    expect(sent).toEqual([`EXPLAIN FORMAT=TREE ${fixture.query}`, `EXPLAIN ANALYZE ${fixture.query}`]);
  });

  it("falls back to JSON for statements the tree can't show", async () => {
    const fixture = mysqlFixture("mysql-8.4-update");
    const { run, sent } = host({
      "EXPLAIN FORMAT=TREE": () => plan("EXPLAIN", fixture.outputs.tree!),
      "EXPLAIN FORMAT=JSON": () => plan("EXPLAIN", fixture.outputs.json!),
    });
    const result = await mysql.explain(request(fixture.query, false, "8.4.2"), run);
    expect(result.plan.root.operation).toBe("Select #1");
    expect(result.sql).toBe(`EXPLAIN FORMAT=JSON ${fixture.query}`);
    expect(sent).toHaveLength(2);
  });

  it("uses JSON on older MySQL servers and on MariaDB", async () => {
    const old = mysqlFixture("mysql-5.7-join-aggregate");
    const maria = mysqlFixture("mariadb-10.6-join-aggregate");
    const { run, sent } = host({
      "EXPLAIN FORMAT=JSON SELECT c.country": () => plan("EXPLAIN", old.outputs.json!),
      "ANALYZE FORMAT=JSON": () => plan("ANALYZE", maria.outputs.jsonAnalyze!),
    });
    await mysql.explain(request(old.query, false, "5.7.44"), run);
    const analyzed = await mysql.explain(request(maria.query, true, "10.6.18-MariaDB"), run);
    expect(analyzed.plan.analyzed).toBe(true);
    expect(sent).toEqual([`EXPLAIN FORMAT=JSON ${old.query}`, `ANALYZE FORMAT=JSON ${maria.query}`]);
  });

  it("tries JSON when a server of unknown version doesn't know the tree", async () => {
    const fixture = mysqlFixture("mariadb-11.4-join-aggregate");
    const { run, sent } = host({ "EXPLAIN FORMAT=JSON": () => plan("EXPLAIN", fixture.outputs.json!) });
    const result = await mysql.explain(request(fixture.query, false), run);
    expect(result.rawFormat).toBe("json");
    expect(sent.map((s) => s.slice(0, 19))).toEqual(["EXPLAIN FORMAT=TREE", "EXPLAIN FORMAT=JSON"]);
  });

  it("reports the server's error for a statement that is wrong", async () => {
    const { run } = host({});
    await expect(mysql.explain(request("SELEC 1", false, "8.4.2"), run)).rejects.toThrow(/error in your SQL syntax/);
  });

  it("refuses TiDB rather than misreading its plans", async () => {
    const { run, sent } = host({});
    await expect(mysql.explain(request("SELECT 1", false, "8.0.11-TiDB-v7.5.0"), run)).rejects.toThrow(/TiDB/);
    expect(sent).toEqual([]);
  });

  it("reads the server's version and SQL mode", async () => {
    const run: RunQuery = async () => [
      { fields: [{ name: "version" }, { name: "sql_mode" }], rows: [{ version: "10.6.18-MariaDB", sql_mode: "ANSI_QUOTES" }] },
    ];
    expect(await mysql.loadServerInfo!(run)).toMatchObject({ flavor: "mariadb", version: 100618, ansiQuotes: true });
  });
});
