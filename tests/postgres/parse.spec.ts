import { describe, expect, it } from "vitest";
import { parsePostgresPlan, postgres, extractPlanOutput } from "../../src/engines/postgres";
import type { Plan, PlanNode } from "../../src/core/plan";
import { postgresFixture, postgresFixtures } from "../fixtures/load";

const fixtures = postgresFixtures();
const byOperation = (plan: Plan, operation: string) => plan.nodes.filter((n) => n.operation === operation);
const one = (plan: Plan, operation: string): PlanNode => {
  const nodes = byOperation(plan, operation);
  expect(nodes, `exactly one ${operation}`).toHaveLength(1);
  return nodes[0];
};

describe("PostgreSQL JSON plans", () => {
  it.each(fixtures.map((f) => [f.name, f] as const))("%s parses into a consistent tree", (_name, fixture) => {
    const { plan, rawFormat } = parsePostgresPlan(fixture.json);
    expect(rawFormat).toBe("json");
    expect(plan.analyzed).toBe(fixture.analyze);
    plan.nodes.forEach((node, i) => expect(node.id).toBe(i));
    expect(plan.nodes.every((n) => n.operation && n.operation !== "Unknown")).toBe(true);
    expect(plan.totalCost).toBeGreaterThan(0);

    if (fixture.analyze) {
      expect(plan.executionTime).toBeGreaterThan(0);
      for (const node of plan.nodes) {
        expect(node.exclusiveTime).toBeGreaterThanOrEqual(0);
        expect(node.exclusiveTime!).toBeLessThanOrEqual(node.inclusiveTime! + 1e-9);
      }
      // Self times add back up to the root's time (allowing for clamping).
      const total = plan.nodes.reduce((sum, n) => sum + n.exclusiveTime!, 0);
      expect(total).toBeLessThanOrEqual(plan.root.inclusiveTime! * 1.05 + 0.01);
      expect(total).toBeGreaterThanOrEqual(plan.root.inclusiveTime! * 0.8);
    }
  });

  it("uses psql-style operator names and targets", () => {
    const { plan } = parsePostgresPlan(postgresFixture("hash-join-aggregate").json);
    expect(plan.nodes.map((n) => n.operation)).toEqual([
      "Sort",
      "Finalize GroupAggregate",
      "Gather Merge",
      "Sort",
      "Partial HashAggregate",
      "Hash Join",
      "Parallel Seq Scan",
      "Hash",
      "Seq Scan",
    ]);
    const scan = one(plan, "Parallel Seq Scan");
    expect(scan.target).toBe("orders o");
    expect(scan.kind).toBe("scan");
    expect(scan.conditions).toContainEqual({ label: "Filter", expression: "(status = 'pending'::text)" });
    expect(one(plan, "Hash Join").children.map((c) => c.role)).toEqual(["Outer", "Inner"]);
  });

  it("measures parallel nodes in wall-clock time", () => {
    const { plan } = parsePostgresPlan(postgresFixture("parallel-aggregate").json);
    const scan = one(plan, "Parallel Seq Scan");
    expect(scan.loops).toBe(3);
    // Three processes ran concurrently, so wall time is the per-loop average.
    expect(scan.inclusiveTime).toBeCloseTo(scan.actualTotalTime!, 5);
    expect(scan.totalActualRows).toBe(600000);
    expect(one(plan, "Partial HashAggregate").operation).toBe("Partial HashAggregate");
    expect(plan.root.operation).toBe("Finalize HashAggregate");
  });

  it.each(["cte-subplans", "pg12-cte-subplans", "pg18-cte-subplans"])("%s: charges CTE time to the CTE scans and InitPlans to the node that evaluates them", (name) => {
    const { plan } = parsePostgresPlan(postgresFixture(name).json);
    const cte = plan.nodes.find((n) => n.subplanName === "CTE spend")!;
    const initPlan = plan.nodes.find((n) => n.subplanName?.startsWith("InitPlan"))!;
    const mainScan = plan.nodes.find((n) => n.target === "spend s")!;
    expect(cte.role).toBe("InitPlan");
    // The filter on the main CTE scan references the InitPlan's output,
    // as "(InitPlan 3).col1" on PostgreSQL 16+ and "$2" before.
    expect(mainScan.conditions.some((c) => /InitPlan|\$2/.test(c.expression))).toBe(true);
    // The scan pays for the CTE and the InitPlan, so little self time is left.
    expect(mainScan.exclusiveTime!).toBeLessThan(mainScan.inclusiveTime! - cte.inclusiveTime! + 0.001);
    // The root does not lose time for both the CTE and the scans reading it.
    expect(plan.root.exclusiveTime).toBeGreaterThan(0);
    expect(plan.root.exclusiveTime!).toBeLessThan(plan.root.inclusiveTime! * 0.2);
    expect(initPlan.inclusiveTime).toBeGreaterThan(0);
  });

  it("marks nodes that never ran", () => {
    const { plan } = parsePostgresPlan(postgresFixture("never-executed").json);
    const never = plan.nodes.filter((n) => n.neverExecuted);
    expect(never.length).toBeGreaterThan(0);
    expect(never.every((n) => n.inclusiveTime === 0)).toBe(true);
  });

  it("reads plans that were not analyzed", () => {
    const { plan } = parsePostgresPlan(postgresFixture("hash-join-aggregate-estimate").json);
    expect(plan.analyzed).toBe(false);
    expect(plan.nodes.every((n) => n.inclusiveTime === undefined)).toBe(true);
    expect(plan.nodes.every((n) => n.exclusiveCost !== undefined)).toBe(true);
    const selfCost = plan.nodes.reduce((sum, n) => sum + n.exclusiveCost!, 0);
    expect(selfCost).toBeCloseTo(plan.totalCost!, 1);
  });

  it("collects plan-wide details", () => {
    const triggers = parsePostgresPlan(postgresFixture("insert-select-triggers").json).plan;
    expect(triggers.root.operation).toBe("Insert");
    expect(triggers.root.kind).toBe("modify");
    expect(triggers.properties.filter((p) => p.group === "Triggers")).toHaveLength(2);

    const settings = parsePostgresPlan(postgresFixture("verbose-buffers-settings").json).plan;
    expect(settings.properties).toContainEqual({ group: "Settings", label: "work_mem", value: "8MB", format: "code" });
    expect(settings.nodes.some((n) => n.conditions.some((c) => c.label === "Output"))).toBe(true);
    expect(settings.nodes.find((n) => n.operation === "Seq Scan")!.target).toBe("public.products p");
  });
});

describe("PostgreSQL insights", () => {
  const rules = (name: string) => {
    const { plan } = parsePostgresPlan(postgresFixture(name).json);
    return [...plan.insights, ...plan.nodes.flatMap((n) => n.insights)].map((i) => i.rule);
  };

  it("flags sorts that spill to disk", () => {
    expect(rules("disk-sort")).toContain("sort-on-disk");
  });

  it("flags sequential scans that discard most rows", () => {
    expect(rules("seq-scan-filter")).toContain("seq-scan-filter");
  });

  it("does not flag simple index lookups", () => {
    expect(rules("index-scan")).toEqual([]);
  });

  it("does not report over-estimates below a LIMIT", () => {
    expect(rules("nested-loop-limit")).not.toContain("row-misestimate");
  });
});

describe("PostgreSQL text plans", () => {
  it.each(fixtures.map((f) => [f.name, f] as const))("%s matches the JSON plan", (_name, fixture) => {
    const fromText = parsePostgresPlan(fixture.text).plan;
    const fromJson = parsePostgresPlan(fixture.json).plan;
    expect(fromText.sourceFormat).toBe("text");

    // Before PostgreSQL 14 a ModifyTable's input was a "Member"; text output
    // can't tell the versions apart, so it always says "Outer".
    const modifyChildren = (plan: Plan) =>
      new Set(plan.nodes.filter((n) => n.kind === "modify").flatMap((n) => n.children.map((c) => c.id)));
    const shape = (plan: Plan) =>
      plan.nodes.map((n) => ({
        operation: n.operation,
        target: n.target,
        index: n.index,
        subplanName: n.subplanName,
        role: modifyChildren(plan).has(n.id) && n.role === "Member" ? "Outer" : n.role,
        // Writes rolled back between the two captures change the estimates.
        estimatedRows: fixture.modifies ? undefined : n.estimatedRows,
        actualRows: n.actualRows,
        loops: n.loops,
        conditions: n.conditions.map((c) => c.label),
        children: n.children.length,
      }));
    expect(shape(fromText)).toEqual(shape(fromJson));
    expect(fromText.analyzed).toBe(fromJson.analyzed);
    expect(fromText.planningTime === undefined).toBe(fromJson.planningTime === undefined);
    expect(fromText.executionTime === undefined).toBe(fromJson.executionTime === undefined);

    // The same properties are found. Text output does not print some flags
    // that JSON always has, and buffer counts depend on what was cached when
    // each capture ran, so those are left out.
    const jsonOnly = new Set(["Parallel Aware", "Async Capable", "Inner Unique", "Join Type", "Strategy", "Scan Direction", "Disabled", "Alias"]);
    const labels = (plan: Plan) =>
      plan.nodes.map((n) =>
        n.properties
          .filter((p) => p.group !== "Buffers" && !jsonOnly.has(p.label))
          .map((p) => `${p.group}/${p.label}`)
          .sort()
      );
    const textLabels = labels(fromText);
    labels(fromJson).forEach((jsonLabels, i) => {
      expect(textLabels[i], `node ${i} (${fromJson.nodes[i].operation})`).toEqual(jsonLabels);
    });

    const groups = (plan: Plan) =>
      [...new Set(plan.properties.map((p) => p.group))].filter((g) => g !== "Planning Buffers").sort();
    expect(groups(fromText)).toEqual(groups(fromJson));
  });

  it("accepts psql's aligned output with header and row count", () => {
    const text = [
      "                          QUERY PLAN",
      "---------------------------------------------------------------",
      " Limit  (cost=0.00..0.04 rows=1 width=4) (actual time=0.010..0.011 rows=1 loops=1)",
      "   ->  Seq Scan on t  (cost=0.00..35.50 rows=2550 width=4) (actual time=0.009..0.009 rows=1 loops=1)",
      " Planning Time: 0.050 ms",
      " Execution Time: 0.020 ms",
      "(4 rows)",
    ].join("\n");
    const { plan } = parsePostgresPlan(text);
    expect(plan.nodes.map((n) => n.operation)).toEqual(["Limit", "Seq Scan"]);
    expect(plan.nodes[1].target).toBe("t");
    expect(plan.executionTime).toBe(0.02);
  });

  it("accepts plans copied as quoted CSV cells and grid values", () => {
    const lines = postgresFixture("index-scan").text.split("\n");
    const csv = lines.map((l) => `"${l.replace(/"/g, '""')}"`).join("\n");
    expect(parsePostgresPlan(csv).plan.root.operation).toBe("Bitmap Heap Scan");
    // A column of rows from the results grid: string[][]
    expect(parsePostgresPlan(lines.map((l) => [l])).plan.root.operation).toBe("Bitmap Heap Scan");
  });

  it("parses COSTS OFF output", () => {
    const text = "Hash Join\n  Hash Cond: (a.id = b.id)\n  ->  Seq Scan on a\n  ->  Hash\n        ->  Seq Scan on b";
    const { plan } = parsePostgresPlan(text);
    expect(plan.nodes.map((n) => n.operation)).toEqual(["Hash Join", "Seq Scan", "Hash", "Seq Scan"]);
    expect(plan.nodes[1].role).toBe("Outer");
    expect(plan.nodes[2].role).toBe("Inner");
  });
});

describe("postgres engine input handling", () => {
  it("detects JSON and text plans", () => {
    const fixture = postgresFixture("index-scan");
    expect(postgres.canParse(fixture.json)).toBe(true);
    expect(postgres.canParse(JSON.stringify(fixture.json))).toBe(true);
    expect(postgres.canParse(fixture.text)).toBe(true);
    expect(postgres.canParse("SELECT 1")).toBe(false);
    expect(postgres.canParse({ hello: "world" })).toBe(false);
  });

  it("gives a readable error for invalid input", () => {
    expect(() => parsePostgresPlan("[{ not json")).toThrow(/could not be read/);
    expect(() => parsePostgresPlan("hello")).toThrow(/doesn't look like/);
    expect(() => parsePostgresPlan({ foo: 1 })).toThrow(/does not look like a PostgreSQL plan/);
  });

  it("finds the plan among several result sets", () => {
    const json = postgresFixture("index-scan").json;
    const output = extractPlanOutput([
      { fields: [{ name: "QUERY PLAN" }], rows: [{ "QUERY PLAN": json }] },
      { fields: [], rows: [] },
    ]);
    expect(output).toBe(json);
    expect(() => extractPlanOutput([{ fields: [{ name: "x" }], rows: [{ x: 1 }] }])).toThrow(/did not return/);
  });
});
