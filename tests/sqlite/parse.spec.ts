import { describe, expect, it } from "vitest";
import { canParseSqlitePlan, parseSqlitePlan } from "../../src/engines/sqlite/parse";
import { inspectStatement } from "../../src/engines/sqlite/statement";
import { sqlite } from "../../src/engines/sqlite";
import { postgres } from "../../src/engines/postgres";
import { mysql } from "../../src/engines/mysql";
import { allInsights } from "../../src/core/analysis";
import type { Plan, PlanNode } from "../../src/core/plan";
import { postgresFixture, sqliteFixture, sqliteFixtures, sqliteResult } from "../fixtures/load";

const fixtures = sqliteFixtures();
const shape = (plan: Plan) =>
  plan.nodes.map((n) => [n.operation, n.target, n.index, n.role, n.subplanName].filter(Boolean).join(" "));
const one = (plan: Plan, operation: string): PlanNode => {
  const nodes = plan.nodes.filter((n) => n.operation === operation);
  expect(nodes, `exactly one ${operation}`).toHaveLength(1);
  return nodes[0];
};
const parse = (name: string) => parseSqlitePlan(sqliteResult(sqliteFixture(name))).plan;

describe("SQLite plans", () => {
  it("covers both row formats and both wordings", () => {
    expect([...new Set(fixtures.map((f) => f.name.replace(/-[a-z-]+$/, "")))]).toEqual(["sqlite-3.16", "sqlite-3.27", "sqlite-3.45"]);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))("%s parses, and reads back from its raw text", (_name, fixture) => {
    const { plan, raw, rawFormat } = parseSqlitePlan(sqliteResult(fixture));
    expect(rawFormat).toBe("text");
    expect(plan.analyzed).toBe(false);
    plan.nodes.forEach((node, i) => expect(node.id).toBe(i));
    // Every step SQLite listed is a node (plus "Query plan" above several).
    const steps = plan.nodes.filter((n) => n.label !== "QUERY PLAN");
    expect(steps.map((n) => n.label).sort()).toEqual(fixture.rows.map((r) => String(r[3])).sort());
    expect(plan.nodes.every((n) => n.operation)).toBe(true);
    expect(shape(parseSqlitePlan(raw).plan)).toEqual(shape(plan));
    expect(canParseSqlitePlan(raw)).toBe(true);
  });

  it("names steps and splits out tables, indexes and constraints", () => {
    const plan = parse("sqlite-3.45-join-aggregate");
    expect(plan.root.operation).toBe("Query plan");
    expect(plan.root.children.map((n) => [n.operation, n.target, n.index, n.role])).toEqual([
      ["Covering index scan", "c", "customers_country_idx", "Outer loop"],
      ["Index search", "o", "orders_customer_id_idx", "Inner loop"],
      ["Sort", undefined, undefined, undefined],
    ]);
    expect(plan.root.children[1].conditions).toEqual([{ label: "Constraint", expression: "customer_id=?" }]);
    expect(plan.root.children[1].label).toBe("SEARCH o USING INDEX orders_customer_id_idx (customer_id=?)");
    // The old wording names the table and its alias.
    const old = parse("sqlite-3.16-join-aggregate");
    expect(old.root.children.map((n) => n.target)).toEqual(["customers c", "orders o", undefined]);
    expect(old.root.children.map((n) => n.role)).toEqual(["Outer loop", "Inner loop", undefined]);
  });

  it("uses the single step as the root", () => {
    const plan = parse("sqlite-3.45-index-search");
    expect(plan.nodes).toHaveLength(1);
    expect(plan.root).toMatchObject({ operation: "Index search", kind: "index", target: "orders" });
  });

  it("nests subqueries, co-routines and unions", () => {
    const plan = parse("sqlite-3.45-subqueries");
    expect(one(plan, "Co-routine")).toMatchObject({ subplanName: "s", kind: "subquery" });
    expect(one(plan, "Scan subquery").target).toBe("s");
    expect(one(plan, "Correlated scalar subquery").children[0].operation).toBe("Covering index search");

    const union = parse("sqlite-3.45-cte-window");
    expect(union.root.operation).toBe("Compound query");
    expect(union.root.children.map((n) => n.operation)).toEqual(["Left-most subquery", "Union all"]);
    expect(union.nodes.filter((n) => n.operation === "Scan subquery").map((n) => n.target)).toEqual(["(subquery-4)", "ranked"]);
  });

  it("rebuilds the tree of SQLite before 3.24 from its subquery numbers", () => {
    const plan = parse("sqlite-3.16-subqueries");
    expect(one(plan, "Scan subquery").children.map((n) => n.operation)).toEqual(["Index scan"]);
    expect(one(plan, "Correlated scalar subquery").children.map((n) => n.target)).toEqual(["orders o2"]);

    const union = parse("sqlite-3.16-union");
    expect(union.root.operation).toBe("Union");
    expect(union.root.children.map((n) => n.target)).toEqual(["orders", "customers"]);
    // Branches of a union are not nested loops.
    expect(union.root.children.map((n) => n.role)).toEqual([undefined, undefined]);
    // Two rows of the same loop are the branches of an OR.
    expect(parse("sqlite-3.16-multi-index-or").nodes.map((n) => n.role)).toEqual([undefined, undefined, undefined]);
    // A recursive CTE refers to itself; that must not loop forever.
    expect(parse("sqlite-3.16-recursive-cte").nodes.length).toBeGreaterThan(2);
  });

  it("points at automatic indexes, scans inside loops and temporary B-trees", () => {
    const automatic = parse("sqlite-3.45-automatic-index");
    const insights = allInsights(automatic);
    expect(insights.find((i) => i.rule === "automatic-index")).toMatchObject({
      severity: "warning",
      nodeId: one(automatic, "Automatic index search").id,
    });
    expect(insights.find((i) => i.rule === "automatic-index")?.detail).toMatch(/on price/);
    expect(insights.map((i) => i.rule)).toContain("temp-b-tree");

    // max() over a table without an index: SEARCH, but every row is read, once per product.
    const correlated = parse("sqlite-3.45-correlated-scan");
    const search = one(correlated, "Search");
    expect(search).toMatchObject({ kind: "scan", description: "no index" });
    expect(search.insights.map((i) => i.rule)).toEqual(["repeated-scan"]);

    expect(allInsights(parse("sqlite-3.45-index-search"))).toEqual([]);
  });

  it("plans have no numbers, and say so", () => {
    const plan = parse("sqlite-3.45-join-aggregate");
    expect(plan.totalCost).toBeUndefined();
    expect(plan.nodes.every((n) => n.estimatedRows === undefined && n.exclusiveCost === undefined)).toBe(true);
  });
});

describe("pasted SQLite plans", () => {
  const shell = `QUERY PLAN
|--SCAN c USING COVERING INDEX customers_country_idx
|--SEARCH o USING INDEX orders_customer_id_idx (customer_id=?)
\`--USE TEMP B-TREE FOR ORDER BY`;

  it("reads the sqlite3 shell's tree", () => {
    expect(shape(parseSqlitePlan(shell).plan)).toEqual(shape(parse("sqlite-3.45-join-aggregate")));
  });

  it("reads rows copied from a grid, with or without a header", () => {
    const expected = shape(parse("sqlite-3.45-join-aggregate"));
    const tsv = "id\tparent\tnotused\tdetail\n9\t0\t0\tSCAN c USING COVERING INDEX customers_country_idx\n11\t0\t0\tSEARCH o USING INDEX orders_customer_id_idx (customer_id=?)\n51\t0\t0\tUSE TEMP B-TREE FOR ORDER BY";
    expect(shape(parseSqlitePlan(tsv).plan)).toEqual(expected);
    expect(shape(parseSqlitePlan(tsv.split("\n").slice(1).join("\n").replace(/\t/g, "|")).plan)).toEqual(expected);
    // A range from Beekeeper Studio's grid; better-sqlite3 returns BigInts.
    const range = [
      [9n, 0n, 0n, "SCAN c USING COVERING INDEX customers_country_idx"],
      [11n, 0n, 0n, "SEARCH o USING INDEX orders_customer_id_idx (customer_id=?)"],
      [51n, 0n, 0n, "USE TEMP B-TREE FOR ORDER BY"],
    ];
    expect(sqlite.canParse(range)).toBe(true);
    const { plan } = parseSqlitePlan(range);
    expect(shape(plan)).toEqual(expected);
    expect(() => JSON.stringify(plan.nodes.map((n) => n.raw))).not.toThrow();
  });

  it("reads the detail column alone, without the nesting", () => {
    const column = [["SCAN c"], ["SEARCH o USING INDEX orders_customer_id_idx (customer_id=?)"]];
    const { plan } = parseSqlitePlan(column);
    expect(plan.root.children.map((n) => n.operation)).toEqual(["Scan", "Index search"]);
  });

  it("is not confused with other databases' plans", () => {
    const pg = postgresFixture("hash-join-aggregate");
    expect(canParseSqlitePlan(pg.text)).toBe(false);
    expect(canParseSqlitePlan(JSON.stringify(pg.json))).toBe(false);
    expect(postgres.canParse(shell)).toBe(false);
    expect(mysql.canParse(shell)).toBe(false);
    expect(() => parseSqlitePlan("SELECT 1")).toThrow(/doesn't look like SQLite/);
  });
});

describe("reading SQLite statements", () => {
  it.each([
    ["SELECT * FROM t", false],
    ["WITH x AS (SELECT 1) SELECT * FROM x", false],
    ["SELECT replace(name, 'a', 'b') FROM t", false],
    ["UPDATE t SET a = 1", true],
    ["INSERT INTO t SELECT * FROM u", true],
    ["REPLACE INTO t VALUES (1)", true],
  ])("%s → writes: %s", (sql, writes) => {
    expect(inspectStatement(sql).modifiesData).toBe(writes);
  });

  it("removes EXPLAIN QUERY PLAN or EXPLAIN", () => {
    expect(inspectStatement("EXPLAIN QUERY PLAN SELECT 1;").statement).toBe("SELECT 1");
    expect(inspectStatement("explain select 1").statement).toBe("select 1");
  });

  it("follows SQLite's quoting and placeholders", () => {
    expect(inspectStatement("SELECT [a;b], `c;d`, \"e;f\", 'g;h' FROM t").error).toBeUndefined();
    // Backslashes don't escape in SQLite: the string ends at the second quote.
    expect(inspectStatement("SELECT 'a\\'; DELETE FROM t").error).toMatch(/Found 2 statements/);
    for (const param of ["?", "?1", ":id", "@id", "$id"]) {
      expect(inspectStatement(`SELECT * FROM t WHERE id = ${param}`).error).toMatch(/parameter/);
    }
  });

  it("has no Explain Analyze", () => {
    expect(sqlite.supportsAnalyze).toBe(false);
    expect(sqlite.analyzePolicy(inspectStatement("SELECT 1"), { readOnlyConnection: false }).blocked).toMatch(/SQLite/);
  });
});
