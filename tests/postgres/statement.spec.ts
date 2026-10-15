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

  // Each of these hides "DELETE FROM victim" from a lexer that reads SQL
  // differently from PostgreSQL. They must be seen as three statements.
  it.each([
    ["a dollar quote with a long tag", `SELECT $${"t".repeat(70)}$ ' $${"t".repeat(70)}$; DELETE FROM victim; SELECT ' x'`],
    ["a non-breaking space before $$ (part of the name to PostgreSQL)", "SELECT 1 AS\u00a0$$; DELETE FROM victim; SELECT 1 AS\u00a0$$"],
    ["a byte order mark before $$", "SELECT 1 AS\ufeff$$; DELETE FROM victim; SELECT 1 AS\ufeff$$"],
    ["a -- comment ended by a carriage return", "SELECT 1 -- c\r; DELETE FROM victim; --\nSELECT 2"],
  ])("does not let %s hide a statement", (_name, sql) => {
    expect(splitStatements(sql)).toHaveLength(3);
    expect(inspectStatement(sql).error).toMatch(/3 statements/);
  });

  it("reads backslash escapes when standard_conforming_strings is off", () => {
    const sql = "SELECT '\\'' ; DELETE FROM victim; SELECT ''";
    expect(splitStatements(sql)).toHaveLength(1);
    expect(splitStatements(sql, { backslashQuotes: true })).toHaveLength(3);
    expect(inspectStatement(sql, { standardConformingStrings: false }).error).toMatch(/3 statements/);
  });

  it("treats colons inside brackets as array slices", () => {
    expect(inspectStatement("SELECT a[lo:hi], b[1:2] FROM t").error).toBeUndefined();
    expect(inspectStatement("SELECT * FROM t WHERE id = :id").error).toMatch(/:id/);
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
    ["(SELECT 1) UNION (SELECT 2)", false],
    ["((SELECT 1)) UNION (DELETE FROM t RETURNING 1)", true],
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
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1;\nROLLBACK;"
    );
  });

  it("rolls back every analyzed statement, since even a SELECT can call a function that writes", () => {
    expect(buildExplainSql(request("DELETE FROM t WHERE id = 1;", { analyze: true }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM t WHERE id = 1;\nROLLBACK;"
    );
    expect(buildExplainSql(request("SELECT wipe()", { analyze: true }))).toMatch(/;\nROLLBACK;$/);
  });

  it("leaves out the ROLLBACK on read-only connections, which refuse it", () => {
    expect(buildExplainSql(request("SELECT 1", { analyze: true, readOnlyConnection: true }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"
    );
  });

  it("does not add a rollback when only estimating a write", () => {
    expect(buildExplainSql(request("DELETE FROM t"))).toBe("EXPLAIN (FORMAT JSON) DELETE FROM t");
  });

  it("skips options the server does not support", () => {
    const options = { buffers: true, verbose: true, settings: true, wal: true };
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: { version: 110000 } }))).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON) SELECT 1;\nROLLBACK;"
    );
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: { version: 170000 } }))).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, SETTINGS, BUFFERS, WAL, FORMAT JSON) SELECT 1;\nROLLBACK;"
    );
  });

  it("leaves out version-specific options when the version is unknown", () => {
    const options = { buffers: true, verbose: false, settings: true, wal: true };
    expect(buildExplainSql(request("SELECT 1", { analyze: true, options, server: undefined }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1;\nROLLBACK;"
    );
  });

  it("uses a generic plan for parameterized statements on PostgreSQL 16+", () => {
    const sql = "SELECT * FROM t WHERE id = $1";
    expect(buildExplainSql(request(sql))).toBe(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${sql}`);
    expect(buildExplainSql(request(sql, { server: { version: 150000 } }))).toBe(`EXPLAIN (FORMAT JSON) ${sql}`);
  });
});
