import { describe, expect, it } from "vitest";
import { splitStatements, tokenize } from "../../src/engines/postgres/lexer";
import { buildExplainSql, inspectStatement } from "../../src/engines/postgres/statement";
import type { ExplainRequest } from "../../src/engines/types";

describe("tokenize / splitStatements", () => {
  it("ignores semicolons inside strings, identifiers, comments and dollar quotes", () => {
    const sql = `SELECT 'a;b', "c;d", $$e;f$$, $tag$g;$$;h$tag$ -- i;j
      /* k; /* nested; */ l; */ FROM t; SELECT 2;`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[1].text).toBe("SELECT 2");
  });

  it("handles escape strings and doubled quotes", () => {
    expect(splitStatements(`SELECT E'it\\'s;', 'it''s;'`)).toHaveLength(1);
  });

  it("distinguishes parameters from casts and dollar quotes", () => {
    const types = tokenize("SELECT $1::int, :name, a::text").map((t) => `${t.type}:${t.text}`);
    expect(types).toContain("param:$1");
    expect(types).toContain("param::name");
    expect(types).not.toContain("param::text");
    expect(types).not.toContain("param::int");
  });

  it("drops statements that are only comments", () => {
    expect(splitStatements("-- nothing here\n;  /* or here */ ;")).toHaveLength(0);
  });
});

describe("inspectStatement", () => {
  it("accepts a single SELECT with a trailing semicolon", () => {
    const info = inspectStatement("  SELECT * FROM users;  ");
    expect(info.error).toBeUndefined();
    expect(info.statement).toBe("SELECT * FROM users");
    expect(info.modifiesData).toBe(false);
  });

  it("rejects empty input and multiple statements", () => {
    expect(inspectStatement("  -- hi\n").error).toMatch(/No SQL statement/);
    expect(inspectStatement("SELECT 1; SELECT 2").error).toMatch(/2 statements/);
  });

  it.each([
    ["SELECT * FROM t", false],
    ["VALUES (1), (2)", false],
    ["TABLE t", false],
    ["WITH x AS (SELECT 1) SELECT * FROM x", false],
    ["SELECT * FROM t FOR UPDATE", false],
    ["SELECT * FROM t FOR NO KEY UPDATE", false],
    ["SELECT * INTO new_table FROM t", true],
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", true],
    ["INSERT INTO t VALUES (1)", true],
    ["UPDATE t SET a = 1", true],
    ["DELETE FROM t", true],
    ["MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE", true],
    ["CREATE TABLE x AS SELECT 1", true],
    ["EXECUTE my_statement(1)", true],
    ["SELECT 'delete from t'", false],
    [`SELECT "update" FROM t`, false],
  ])("classifies %s (modifies data: %s)", (sql, modifies) => {
    expect(inspectStatement(sql).modifiesData).toBe(modifies);
  });

  it("strips an existing EXPLAIN prefix and remembers its options", () => {
    const info = inspectStatement("EXPLAIN ANALYZE VERBOSE SELECT 1");
    expect(info.statement).toBe("SELECT 1");
    expect(info.requestedOptions).toEqual({ analyze: true, verbose: true });

    const parens = inspectStatement("explain (analyse, buffers off, format json) select 1");
    expect(parens.statement).toBe("select 1");
    expect(parens.requestedOptions).toEqual({ analyze: true, buffers: false });
  });

  it("flags positional parameters and rejects named ones", () => {
    expect(inspectStatement("SELECT * FROM t WHERE id = $1").hasParameters).toBe(true);
    expect(inspectStatement("SELECT * FROM t WHERE id = $1").error).toBeUndefined();
    expect(inspectStatement("SELECT * FROM t WHERE id = :id").error).toMatch(/:id/);
    expect(inspectStatement("SELECT now()::date").error).toBeUndefined();
  });
});

describe("buildExplainSql", () => {
  const request = (sql: string, overrides: Partial<ExplainRequest> = {}): ExplainRequest => ({
    statement: inspectStatement(sql),
    analyze: false,
    options: { buffers: true, verbose: false, settings: false, wal: false },
    server: { version: 170000 },
    ...overrides,
  });

  it("explains without executing by default", () => {
    expect(buildExplainSql(request("SELECT 1"))).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
  });

  it("adds analyze-only options when analyzing", () => {
    expect(buildExplainSql(request("SELECT 1", { analyze: true }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"
    );
  });

  it("rolls back data-modifying statements that are analyzed", () => {
    const sql = buildExplainSql(request("DELETE FROM t WHERE id = 1;", { analyze: true }));
    expect(sql).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM t WHERE id = 1;\nROLLBACK;");
  });

  it("does not add a rollback when only estimating a write", () => {
    expect(buildExplainSql(request("DELETE FROM t"))).toBe("EXPLAIN (FORMAT JSON) DELETE FROM t");
  });

  it("skips options the server does not support", () => {
    const options = { buffers: true, verbose: true, settings: true, wal: true };
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: { version: 110000 } }))).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON) SELECT 1"
    );
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: { version: 170000 } }))).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, SETTINGS, BUFFERS, WAL, FORMAT JSON) SELECT 1"
    );
  });

  it("leaves out version-specific options when the version is unknown", () => {
    const options = { buffers: true, verbose: false, settings: true, wal: true };
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: undefined }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"
    );
  });

  it("uses a generic plan for parameterized statements on PostgreSQL 16+", () => {
    const sql = "SELECT * FROM t WHERE id = $1";
    expect(buildExplainSql(request(sql))).toBe(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${sql}`);
    expect(buildExplainSql(request(sql, { server: { version: 150000 } }))).toBe(`EXPLAIN (FORMAT JSON) ${sql}`);
  });
});
