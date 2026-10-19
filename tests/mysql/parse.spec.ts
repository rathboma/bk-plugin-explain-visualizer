import { describe, expect, it } from "vitest";
import { canParseMysqlPlan, jsonFlavor, NOT_EXECUTABLE_MESSAGE, parseMysqlPlan } from "../../src/engines/mysql/parse";
import { traditionalFlavor } from "../../src/engines/mysql/traditional";
import { parseJsonKeepingDuplicates } from "../../src/engines/shared/json";
import { postgres } from "../../src/engines/postgres";
import { sqlite } from "../../src/engines/sqlite";
import { allInsights } from "../../src/core/analysis";
import type { Plan, PlanNode } from "../../src/core/plan";
import { mysqlFixture, mysqlFixtures, postgresFixture, sqliteFixture, sqliteResult, tableResult } from "../fixtures/load";

const fixtures = mysqlFixtures();
/** Text outputs; the classic tables are tested on their own below. */
const outputs = fixtures.flatMap((f) =>
  Object.entries(f.outputs)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([format, output]) => [`${f.name} ${format}`, f, format, output] as const)
);
/** MySQL's answer for statements its tree can't show; the engine falls back to JSON. */
const notExecutable = (output: string) => /<not executable by iterator executor>/.test(output) && output.length < 200;

const one = (plan: Plan, operation: string, target?: string): PlanNode => {
  const nodes = plan.nodes.filter((n) => n.operation === operation && (target === undefined || n.target === target));
  expect(nodes, `exactly one ${operation} ${target ?? ""}`).toHaveLength(1);
  return nodes[0];
};
const shape = (plan: Plan) => plan.nodes.map((n) => [n.operation, n.target, n.index].filter(Boolean).join(" "));

describe("MySQL and MariaDB plans", () => {
  it("covers every server the fixtures come from", () => {
    const servers = new Set(fixtures.map((f) => f.name.replace(/-[a-z-]+$/, "")));
    expect([...servers].sort()).toEqual([
      "mariadb-10.4",
      "mariadb-10.6",
      "mariadb-11.4",
      "mysql-5.7",
      "mysql-8.0",
      "mysql-8.0.17",
      "mysql-8.4",
      "mysql-9.7",
    ]);
  });

  it.each(outputs)("%s parses into a consistent tree", (_name, fixture, format, output) => {
    if (notExecutable(output)) {
      expect(() => parseMysqlPlan(output)).toThrow(NOT_EXECUTABLE_MESSAGE);
      return;
    }
    expect(canParseMysqlPlan(output)).toBe(true);
    const { plan, raw, rawFormat } = parseMysqlPlan(output);
    expect(rawFormat).toBe(format.startsWith("tree") ? "text" : "json");
    // The raw output reads back into the same plan, for restored tabs.
    expect(shape(parseMysqlPlan(raw).plan)).toEqual(shape(plan));

    // MariaDB measures nothing when the WHERE clause can't match.
    if (!/impossible-where/.test(fixture.name)) expect(plan.analyzed).toBe(/Analyze/.test(format));
    plan.nodes.forEach((node, i) => expect(node.id).toBe(i));
    expect(plan.nodes.every((n) => n.operation && n.operation !== "Unknown")).toBe(true);

    if (plan.analyzed) {
      const timed = plan.nodes.filter((n) => n.inclusiveTime !== undefined);
      expect(timed.length).toBeGreaterThan(0);
      for (const node of timed) {
        expect(node.exclusiveTime).toBeGreaterThanOrEqual(0);
        expect(node.exclusiveTime!).toBeLessThanOrEqual(node.inclusiveTime! + 1e-9);
      }
      // Self times add back up to the total (allowing for MySQL's rounding,
      // which can make children take a little longer than their parent).
      const total = timed.reduce((sum, n) => sum + n.exclusiveTime!, 0);
      expect(total).toBeLessThanOrEqual(plan.root.inclusiveTime! * 1.05 + 0.01);
      expect(total).toBeGreaterThanOrEqual(plan.root.inclusiveTime! * 0.95);
    }
    // MySQL's estimates have costs; MariaDB has them since 11.0.
    const costed = fixture.flavor === "mysql" ? fixture.version >= 80018 || format === "json" : fixture.version >= 110000;
    if (costed && !fixture.modifies && !/impossible-where/.test(fixture.name)) {
      expect(plan.totalCost, "total cost").toBeGreaterThan(0);
    }
  });

  it("reads MySQL's tree format", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-join-aggregate").outputs.tree);
    expect(plan.nodes.map((n) => n.operation)).toEqual([
      "Sort",
      "Table scan",
      "Aggregate using temporary table",
      "Nested loop inner join",
      "Filter",
      "Table scan",
      "Single-row index lookup",
    ]);
    const lookup = one(plan, "Single-row index lookup");
    expect(lookup).toMatchObject({ target: "c", index: "PRIMARY", kind: "index", role: "Inner", totalCost: 0.25, estimatedRows: 1 });
    expect(lookup.conditions).toEqual([{ label: "Lookup", expression: "id=o.customer_id" }]);
    expect(lookup.label).toBe("Single-row index lookup on c using PRIMARY (id=o.customer_id)");
    expect(one(plan, "Filter").conditions).toEqual([{ label: "Filter", expression: "(o.`status` = 'pending')" }]);
    expect(one(plan, "Sort").conditions).toEqual([{ label: "Sort key", expression: "revenue DESC" }]);
    expect(one(plan, "Table scan", "o").kind).toBe("scan");
    // Steps without a cost don't hide the plan's cost.
    expect(plan.totalCost).toBe(27125);
  });

  it("reads index ranges, index conditions and flags", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-cte-window").outputs.tree);
    const range = plan.nodes.find((n) => n.operation === "Index range scan")!;
    expect(range.conditions).toEqual([
      { label: "Ranges", expression: "(customer_id < 100)" },
      { label: "Index condition", expression: "(orders.customer_id < 100)" },
    ]);
    expect(one(plan, "Materialize CTE").subplanName).toBe("CTE ranked");
    expect(plan.root.operation).toBe("Append");
    expect(plan.root.kind).toBe("set");

    const limit = parseMysqlPlan(mysqlFixture("mysql-8.4-join-limit").outputs.tree).plan;
    expect(one(limit, "Index scan")).toMatchObject({ target: "o", index: "orders_ordered_at_idx", description: "reverse" });
    expect(one(limit, "Limit").description).toBe("20 row(s)");

    const hash = parseMysqlPlan(mysqlFixture("mysql-8.4-hash-join").outputs.tree).plan;
    const join = one(hash, "Inner hash join");
    expect(join.conditions).toEqual([{ label: "Hash condition", expression: "oi.unit_price = p.price" }]);
    expect(join.children.map((c) => c.role)).toEqual(["Probe", "Build"]);
    expect(join.children[1].operation).toBe("Hash");
  });

  it("reads numbers in every notation MySQL prints", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-antijoin").outputs.treeAnalyze);
    const join = one(plan, "Nested loop antijoin");
    expect(join.totalCost).toBe(399e6);
    expect(join.estimatedRows).toBe(3.99e9);
    const lookup = plan.nodes.find((n) => n.target === "<subquery2>")!;
    expect(lookup.startupCost).toBe(40112);
    expect(lookup.actualRows).toBe(0.0385);
    expect(lookup.loops).toBe(52);
  });

  it.each(["mysql-8.4", "mysql-9.7"])("%s: the tree and JSON version 2 describe the same plan", (server) => {
    for (const fixture of fixtures.filter((f) => f.name.startsWith(`${server}-`))) {
      const { tree, jsonV2, treeAnalyze, jsonV2Analyze } = fixture.outputs;
      if (tree && jsonV2 && !notExecutable(tree)) {
        expect(shape(parseMysqlPlan(jsonV2).plan), fixture.name).toEqual(shape(parseMysqlPlan(tree).plan));
      }
      if (treeAnalyze && jsonV2Analyze) {
        const fromTree = parseMysqlPlan(treeAnalyze).plan;
        const fromJson = parseMysqlPlan(jsonV2Analyze).plan;
        expect(shape(fromJson), fixture.name).toEqual(shape(fromTree));
        // Separate runs: the same loops, and rows, but not the same times.
        expect(fromJson.nodes.map((n) => n.loops)).toEqual(fromTree.nodes.map((n) => n.loops));
      }
    }
  });

  it("adds JSON version 2's table details to the node", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-join-aggregate").outputs.jsonV2);
    const scan = one(plan, "Table scan", "o");
    expect(scan.properties).toContainEqual({ group: "Node", label: "Table", value: "shop.orders", format: "code" });
    expect(scan.properties).toContainEqual({ group: "Node", label: "Used columns", value: "id, customer_id, status, total", format: "code" });
  });

  it("charges subqueries in the select list to the query, not the step they follow", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-dependent-subquery").outputs.treeAnalyze);
    const subquery = plan.nodes.find((n) => n.role === "Select list")!;
    expect(subquery.subplanName).toBe("Select #2");
    expect(subquery.description).toBe("in projection; dependent");
    expect(plan.root.children).toContain(subquery);
    // The root's own measurement doesn't include the subquery: its self time
    // stays small, and its total grows by the subquery's.
    expect(plan.root.exclusiveTime!).toBeLessThan(10);
    expect(plan.root.inclusiveTime!).toBeGreaterThan(subquery.inclusiveTime!);
    expect(allInsights(plan).map((i) => i.rule)).toEqual(
      expect.arrayContaining(["dependent-subquery", "repeated-scan", "full-scan-filter"])
    );
  });

  it("marks steps that never ran", () => {
    for (const name of ["mysql-8.4-never-executed", "mysql-8.0-never-executed"]) {
      const { plan } = parseMysqlPlan(mysqlFixture(name).outputs.treeAnalyze);
      const lookup = one(plan, "Single-row index lookup");
      expect(lookup).toMatchObject({ neverExecuted: true, loops: 0, inclusiveTime: 0 });
    }
    const v2 = parseMysqlPlan(mysqlFixture("mysql-9.7-never-executed").outputs.jsonV2Analyze).plan;
    expect(one(v2, "Single-row index lookup").neverExecuted).toBe(true);
    const mariadb = parseMysqlPlan(mysqlFixture("mariadb-11.4-never-executed").outputs.jsonAnalyze).plan;
    expect(one(mariadb, "Single-row index lookup", "c")).toMatchObject({ neverExecuted: true, actualRows: 0 });
  });

  it("explains statements that return nothing", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-impossible-where").outputs.treeAnalyze);
    expect(plan.root.operation).toBe("Zero rows");
    expect(plan.root.description).toBe("no matching row in const table");
    expect(plan.insights.map((i) => i.rule)).toContain("no-rows");
  });

  it("explains MySQL's statements without a tree with an error", () => {
    expect(() => parseMysqlPlan(mysqlFixture("mysql-8.4-update").outputs.tree)).toThrow(NOT_EXECUTABLE_MESSAGE);
    expect(() => parseMysqlPlan(mysqlFixture("mysql-9.7-update").outputs.jsonV2)).toThrow(NOT_EXECUTABLE_MESSAGE);
  });
});

describe("MySQL's query-block JSON (5.7 to 8.x)", () => {
  it("builds a chain of joins from the nested loop", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-5.7-join-aggregate").outputs.json);
    expect(plan.root.operation).toBe("Select #1");
    const join = one(plan, "Nested loop");
    expect(join.children.map((c) => [c.operation, c.target, c.role])).toEqual([
      ["Table scan", "o", "Outer"],
      ["Single-row index lookup", "c", "Inner"],
    ]);
    const lookup = join.children[1];
    expect(lookup.conditions).toEqual([{ label: "Lookup", expression: "id = shop.o.customer_id" }]);
    // Costs are per table: what it reads and evaluates.
    expect(lookup.totalCost).toBeGreaterThan(0);
    expect(join.exclusiveCost).toBeCloseTo(0, 1);
    expect(plan.totalCost).toBeCloseTo(Number(JSON.parse(mysqlFixture("mysql-5.7-join-aggregate").outputs.json!).query_block.cost_info.query_cost), 1);
  });

  it("shows subqueries and materialized tables under the table that uses them", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-8.4-subqueries").outputs.json);
    const derived = one(plan, "Index lookup", "s");
    expect(derived.children.map((c) => c.operation)).toEqual(["Select #4", "Materialize"]);
    expect(derived.children[0].role).toBe("Condition");
    const selectList = plan.nodes.find((n) => n.role === "Select list")!;
    expect(selectList).toMatchObject({ operation: "Select #2", description: "dependent, uncacheable" });
  });

  it("names joins by their join buffer", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mysql-5.7-hash-join").outputs.json);
    expect(one(plan, "Block nested loop").children[1].target).toBe("oi");
    expect(allInsights(plan).find((i) => i.rule === "join-without-index")?.severity).toBe("warning");
    const hash = parseMysqlPlan(mysqlFixture("mysql-8.0-hash-join").outputs.json).plan;
    expect(hash.nodes.some((n) => n.operation === "Hash join")).toBe(true);
  });

  it("shows what a statement changes", () => {
    const insert = parseMysqlPlan(mysqlFixture("mysql-5.7-insert-select").outputs.json).plan;
    const node = one(insert, "Insert");
    expect(node).toMatchObject({ kind: "modify", target: "order_items" });
    expect(node.children[0].operation).toBe("Covering index range scan");

    const update = parseMysqlPlan(mysqlFixture("mysql-8.4-update").outputs.json).plan;
    expect(one(update, "Update")).toMatchObject({ target: "products", description: "index scan", index: "PRIMARY" });
  });
});

describe("MariaDB's JSON", () => {
  it.each(["mariadb-10.4", "mariadb-10.6", "mariadb-11.4"])("%s: keeps every table of a join", (server) => {
    const fixture = mysqlFixture(`${server}-join-aggregate`);
    for (const output of [fixture.outputs.json!, fixture.outputs.jsonAnalyze!]) {
      const { plan } = parseMysqlPlan(output);
      const join = one(plan, "Nested loop");
      expect(join.children.map((c) => c.target).sort()).toEqual(["c", "o"]);
    }
  });

  it("times each table and the whole query", () => {
    const fixture = mysqlFixture("mariadb-11.4-join-aggregate");
    const top = JSON.parse(fixture.outputs.jsonAnalyze!);
    const { plan } = parseMysqlPlan(fixture.outputs.jsonAnalyze);
    expect(plan.analyzed).toBe(true);
    expect(plan.executionTime).toBeCloseTo(top.query_block.r_total_time_ms, 6);
    expect(plan.planningTime).toBeCloseTo(top.query_optimization.r_total_time_ms, 6);

    const scan = one(plan, "Table scan", "o");
    const raw = top.query_block.filesort.temporary_table.nested_loop[0].table;
    expect(scan.exclusiveTime).toBeCloseTo(raw.r_table_time_ms + raw.r_other_time_ms, 6);
    // r_rows were read per loop, r_filtered percent of them kept.
    expect(scan.actualRows).toBeCloseTo((raw.r_rows * raw.r_filtered) / 100, 6);
    expect(scan.estimatedRows).toBe(raw.rows);
    expect(scan.properties).toContainEqual({ group: "Runtime", label: "Pages accessed", value: raw.r_engine_stats.pages_accessed, format: "number" });
    expect(allInsights(plan).find((i) => i.rule === "full-scan-filter")?.nodeId).toBe(scan.id);
    expect(one(plan, "Sort").exclusiveTime).toBeCloseTo(top.query_block.filesort.r_total_time_ms, 6);
  });

  it("names MariaDB's join buffer and its time", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mariadb-11.4-hash-join").outputs.jsonAnalyze);
    const join = one(plan, "Block nested loop");
    expect(join.conditions).toEqual([{ label: "Join condition", expression: "oi.unit_price = p.price" }]);
    expect(join.exclusiveTime!).toBeGreaterThan(100);
    // 2000 × 5997 row pairs, 0.2% of them matching.
    expect(join.actualRows).toBeCloseTo(23988, 0);
    expect(allInsights(plan).map((i) => i.rule)).toContain("join-without-index");
  });

  it("flags subqueries that run once per row", () => {
    const { plan } = parseMysqlPlan(mysqlFixture("mariadb-11.4-dependent-subquery").outputs.jsonAnalyze);
    expect(allInsights(plan).map((i) => i.rule)).toContain("dependent-subquery");
  });
});

describe("recognising MySQL plans", () => {
  it("accepts every output format, with or without the mysql client's label", () => {
    const fixture = mysqlFixture("mysql-8.4-join-aggregate");
    expect(canParseMysqlPlan(`EXPLAIN: ${fixture.outputs.tree}`)).toBe(true);
    expect(parseMysqlPlan(`EXPLAIN: ${fixture.outputs.tree}`).plan.nodes).toHaveLength(7);
    expect(canParseMysqlPlan(JSON.parse(fixture.outputs.json!))).toBe(true);
    expect(canParseMysqlPlan(JSON.parse(fixture.outputs.jsonV2!))).toBe(true);
    // A cell from the results grid, as a one-cell range.
    expect(parseMysqlPlan([[fixture.outputs.treeAnalyze]]).plan.analyzed).toBe(true);
  });

  it("is not confused with PostgreSQL or SQLite plans", () => {
    const pg = postgresFixture("hash-join-aggregate");
    const tree = mysqlFixture("mysql-8.4-join-aggregate").outputs.treeAnalyze!;
    expect(canParseMysqlPlan(pg.json)).toBe(false);
    expect(canParseMysqlPlan(pg.text)).toBe(false);
    expect(canParseMysqlPlan(sqliteResult(sqliteFixture("sqlite-3.45-join-aggregate")).rows)).toBe(false);
    expect(postgres.canParse(tree)).toBe(false);
    expect(postgres.canParse(mysqlFixture("mysql-8.4-join-aggregate").outputs.json)).toBe(false);
    expect(sqlite.canParse(tree)).toBe(false);
  });

  it("explains JSON it can't read", () => {
    expect(() => parseMysqlPlan('{"query_block": ')).toThrow(/could not be read/);
    expect(() => parseMysqlPlan("SELECT 1")).toThrow(/doesn't look like MySQL/);
  });
});

describe("the classic EXPLAIN table", () => {
  const tables = fixtures.flatMap((f) =>
    (["traditional", "traditionalAnalyze"] as const)
      .filter((format) => f.outputs[format])
      .map((format) => [`${f.name} ${format}`, f, f.outputs[format]!] as const)
  );

  it.each(tables)("%s parses, and reads back from its raw text", (_name, _fixture, output) => {
    const { plan, raw, rawFormat } = parseMysqlPlan(tableResult(output));
    expect(rawFormat).toBe("text");
    expect(plan.sourceFormat).toBe("table");
    // Every row with a table is a node.
    const tables = output.rows.map((r) => r[output.columns.indexOf("table")]).filter((t) => t !== null && !/^<union/.test(String(t)));
    expect(plan.nodes.filter((n) => n.target).map((n) => n.target).sort()).toEqual(tables.map(String).sort());
    expect(shape(parseMysqlPlan(raw).plan)).toEqual(shape(plan));
    expect(canParseMysqlPlan(raw)).toBe(true);
  });

  it("reads the same plan as the JSON, from the same server", () => {
    const fixture = mysqlFixture("mysql-5.7-join-aggregate");
    const fromTable = parseMysqlPlan(tableResult(fixture.outputs.traditional!)).plan;
    const fromJson = parseMysqlPlan(fixture.outputs.json).plan;
    const tablesOf = (plan: Plan) => plan.nodes.filter((n) => n.target).map((n) => [n.operation, n.target, n.index]);
    expect(tablesOf(fromTable)).toEqual(tablesOf(fromJson));
    expect(one(fromTable, "Nested loop").children.map((c) => c.role)).toEqual(["Outer", "Inner"]);
  });

  it("puts derived tables and subqueries under what reads them", () => {
    const { plan } = parseMysqlPlan(tableResult(mysqlFixture("mysql-5.7-subqueries").outputs.traditional!));
    const derived = plan.nodes.find((n) => n.target === "<derived3>")!;
    expect(derived.children[0].operation).toBe("Materialize");
    expect(plan.nodes.some((n) => n.role === "Subquery" && /dependent/.test(n.description ?? ""))).toBe(true);
  });

  it("shows MySQL 9's single-table UPDATE, which only the table can", () => {
    const { plan } = parseMysqlPlan(tableResult(mysqlFixture("mysql-9.7-update").outputs.traditional!));
    expect(one(plan, "Update")).toMatchObject({ target: "products", index: "PRIMARY", description: "index scan" });
  });

  it("reads tables copied as text: tab-separated, boxed and vertical", () => {
    const tsv = `id\tselect_type\ttable\tpartitions\ttype\tpossible_keys\tkey\tkey_len\tref\trows\tfiltered\tExtra
1\tSIMPLE\to\tNULL\tALL\torders_customer_id_idx\tNULL\tNULL\tNULL\t199800\t10.00\tUsing where; Using temporary
1\tSIMPLE\tc\tNULL\teq_ref\tPRIMARY\tPRIMARY\t4\tshop.o.customer_id\t1\t100.00\tNULL`;
    const boxed = `+----+-------------+-------+------------+--------+---------------+---------+---------+--------------------+--------+----------+------------------------------+
| id | select_type | table | partitions | type   | possible_keys | key     | key_len | ref                | rows   | filtered | Extra                        |
+----+-------------+-------+------------+--------+---------------+---------+---------+--------------------+--------+----------+------------------------------+
|  1 | SIMPLE      | o     | NULL       | ALL    | orders_customer_id_idx | NULL    | NULL    | NULL               | 199800 |    10.00 | Using where; Using temporary |
|  1 | SIMPLE      | c     | NULL       | eq_ref | PRIMARY       | PRIMARY | 4       | shop.o.customer_id |      1 |   100.00 | NULL                         |
+----+-------------+-------+------------+--------+---------------+---------+---------+--------------------+--------+----------+------------------------------+`;
    const vertical = `*************************** 1. row ***************************
           id: 1
  select_type: SIMPLE
        table: o
   partitions: NULL
         type: ALL
possible_keys: orders_customer_id_idx
          key: NULL
      key_len: NULL
          ref: NULL
         rows: 199800
     filtered: 10.00
        Extra: Using where; Using temporary
*************************** 2. row ***************************
           id: 1
  select_type: SIMPLE
        table: c
   partitions: NULL
         type: eq_ref
possible_keys: PRIMARY
          key: PRIMARY
      key_len: 4
          ref: shop.o.customer_id
         rows: 1
     filtered: 100.00
        Extra: NULL`;
    const expected = ["Temporary table", "Nested loop", "Table scan o", "Single-row index lookup c PRIMARY"];
    for (const text of [tsv, boxed, vertical]) {
      expect(canParseMysqlPlan(text)).toBe(true);
      const { plan } = parseMysqlPlan(text);
      expect(shape(plan).slice(1)).toEqual(expected);
      expect(one(plan, "Table scan").estimatedRows).toBeCloseTo(19980);
    }
    // A range from the results grid has no header: columns are recognised by their values.
    const range = tsv.split("\n").slice(1).map((line) => line.split("\t"));
    expect(shape(parseMysqlPlan(range).plan).slice(1)).toEqual(expected);
  });
});

describe("unions in the classic table", () => {
  const tree = (name: string) => {
    const { plan } = parseMysqlPlan(tableResult(mysqlFixture(name).outputs.traditional!));
    const lines: string[] = [];
    const walk = (node: PlanNode, depth: number) => {
      lines.push(`${"  ".repeat(depth)}${node.operation}${node.target ? ` ${node.target}` : ""}`);
      node.children.forEach((child) => walk(child, depth + 1));
    };
    walk(plan.root, 0);
    return lines;
  };

  it.each(["mysql-5.7", "mysql-8.4", "mariadb-11.4"])("%s: a UNION in a derived table stays under it", (server) => {
    const lines = tree(`${server}-derived-union`);
    expect(lines[0]).toBe("Select #1");
    const derived = lines.findIndex((l) => /<derived2>$/.test(l));
    expect(lines.slice(derived + 1, derived + 4).map((l) => l.trim())).toEqual(["Materialize", "Query block", "Union"]);
  });

  it.each(["mysql-5.7", "mysql-8.4", "mariadb-11.4"])("%s: a UNION in a subquery stays a subquery", (server) => {
    const { plan } = parseMysqlPlan(tableResult(mysqlFixture(`${server}-subquery-union`).outputs.traditional!));
    expect(plan.root.operation).toBe("Select #1");
    const subquery = plan.nodes.find((n) => n.role === "Subquery")!;
    expect(subquery.description).toBe("dependent");
    expect(subquery.children[0].operation).toBe("Union");
    expect(subquery.children[0].children.map((c) => c.operation)).toEqual(["Select #2", "Select #3"]);
  });

  it.each(["mysql-5.7", "mysql-8.4", "mariadb-11.4"])("%s: a UNION ALL without a result row joins the block before it", (server) => {
    const lines = tree(`${server}-nested-union-all`).map((l) => l.trim());
    expect(lines.slice(0, 3)).toEqual(["Query block", "Union", "Select #1"]);
    const inner = lines.indexOf("Union all");
    expect(inner).toBeGreaterThan(3);
    expect(lines.slice(inner + 1)).toEqual(expect.arrayContaining(["Select #3", "Select #4"]));
    // MySQL 8 numbers the result row: it is not a query block of its own.
    expect(lines.filter((l) => /^Select #\d+$/.test(l))).toHaveLength(4);
  });
});

describe("telling MySQL and MariaDB plans apart", () => {
  it("never mistakes one server's JSON or table for the other's", () => {
    for (const fixture of fixtures) {
      const other = fixture.flavor === "mysql" ? "mariadb" : "mysql";
      for (const output of [fixture.outputs.json, fixture.outputs.jsonAnalyze].filter(Boolean)) {
        const json = parseJsonKeepingDuplicates(output!) as Record<string, unknown>;
        if (!json["query_block"]) continue;
        expect(jsonFlavor(json), fixture.name).not.toBe(other);
      }
      for (const output of [fixture.outputs.traditional, fixture.outputs.traditionalAnalyze].filter(Boolean)) {
        expect(traditionalFlavor(tableResult(output!).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])))), fixture.name).not.toBe(other);
      }
    }
    // MariaDB's ANALYZE and repeated keys, MySQL's cost_info: recognised.
    expect(jsonFlavor(JSON.parse(mysqlFixture("mariadb-11.4-join-aggregate").outputs.jsonAnalyze!))).toBe("mariadb");
    expect(jsonFlavor(parseJsonKeepingDuplicates(mysqlFixture("mariadb-10.6-join-aggregate").outputs.json!) as never)).toBe("mariadb");
    expect(jsonFlavor(JSON.parse(mysqlFixture("mysql-5.7-join-aggregate").outputs.json!))).toBe("mysql");
  });

  it("gives neutral advice when a plan could be either's, and follows the server when it is known", () => {
    // MySQL 5.6 and MariaDB 10 describe a single-table plan the same way.
    const simple = { query_block: { select_id: 1, table: { table_name: "t", access_type: "ALL", rows: 1000, filtered: 100 } } };
    expect(jsonFlavor(simple)).toBeUndefined();
    // Advice shows in row estimate insights, which need measurements.
    const analyzed = mysqlFixture("mariadb-11.4-join-aggregate").outputs.jsonAnalyze!;
    const advice = (plan: Plan) => allInsights(plan).find((i) => i.rule === "row-misestimate")?.detail ?? "";
    expect(advice(parseMysqlPlan(analyzed).plan)).toMatch(/PERSISTENT FOR ALL/);
    expect(advice(parseMysqlPlan(analyzed, { flavor: "mysql" }).plan)).toMatch(/HISTOGRAM/);
  });
});
