import { describe, expect, it } from "vitest";
import { finishPlan, misestimate, planStats } from "../../src/core/analysis";
import { finalizeTree, type DraftNode, type Plan } from "../../src/core/plan";
import { formatBytes, formatCompact, formatMs, formatPercent, formatValue } from "../../src/core/format";
import { layoutPlan, NODE_HEIGHT, NODE_WIDTH } from "../../src/core/layout";

const draft = (operation: string, extra: Partial<DraftNode> = {}, children: DraftNode[] = []): DraftNode => ({
  operation,
  kind: "other",
  conditions: [],
  properties: [],
  children,
  ...extra,
});

function plan(root: DraftNode, analyzed = true): Plan {
  const { root: r, nodes } = finalizeTree(root);
  return { engine: "test", sourceFormat: "json", analyzed, root: r, nodes, properties: [], insights: [], totalCost: r.totalCost };
}

describe("planStats", () => {
  it("works for engines that report no costs or timings", () => {
    // SQLite's EXPLAIN QUERY PLAN, for example, is only a tree of descriptions.
    const p = plan(draft("SCAN orders", {}, [draft("SEARCH customers USING INDEX")]), false);
    const stats = planStats(p);
    expect(stats.totalTime).toBeUndefined();
    expect(stats.totalCost).toBeUndefined();
    expect(stats.hottest).toEqual([]);
    expect(stats.nodes.get(0)).toEqual({ timeShare: undefined, costShare: undefined, misestimate: undefined, outputRows: undefined });
  });

  it("ranks nodes by self time", () => {
    const p = plan(
      draft("Root", { inclusiveTime: 10, exclusiveTime: 2 }, [
        draft("A", { inclusiveTime: 7, exclusiveTime: 7, actualRows: 5, loops: 1, totalActualRows: 5 }),
        draft("B", { inclusiveTime: 1, exclusiveTime: 1 }),
      ])
    );
    const stats = planStats(p);
    expect(stats.hottest.map((n) => n.operation)).toEqual(["A", "Root", "B"]);
    expect(stats.nodes.get(1)?.timeShare).toBeCloseTo(0.7);
    expect(stats.maxOutputRows).toBe(5);
  });
});

describe("row misestimates", () => {
  it("measures how far off an estimate was", () => {
    expect(misestimate({ estimatedRows: 10, actualRows: 1000 } as never)).toEqual({ factor: 100, direction: "under" });
    expect(misestimate({ estimatedRows: 1000, actualRows: 0 } as never)).toEqual({ factor: 1000, direction: "over" });
    expect(misestimate({ estimatedRows: 10 } as never)).toBeUndefined();
  });

  it("flags underestimates, and overestimates only where nothing stops early", () => {
    const under = plan(draft("Scan", { estimatedRows: 1, actualRows: 5000, loops: 1 }));
    finishPlan(under);
    expect(under.root.insights.map((i) => i.rule)).toEqual(["row-misestimate"]);
    expect(under.root.insights[0].severity).toBe("critical");

    const limited = plan(
      draft("Limit", { kind: "limit", estimatedRows: 10, actualRows: 10, loops: 1 }, [
        draft("Seq Scan", { estimatedRows: 100000, actualRows: 10, loops: 1 }),
      ])
    );
    finishPlan(limited);
    expect(limited.nodes[1].insights).toEqual([]);
  });

  it("ignores tiny row counts", () => {
    const p = plan(draft("Scan", { estimatedRows: 1, actualRows: 20, loops: 1 }));
    finishPlan(p);
    expect(p.root.insights).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations, sizes and counts", () => {
    expect(formatMs(0.0123)).toBe("0.012 ms");
    expect(formatMs(12.345)).toBe("12.3 ms");
    expect(formatMs(2500)).toBe("2.50 s");
    expect(formatMs(125000)).toBe("2m 5s");
    expect(formatBytes(6400 * 1024)).toBe("6.25 MB");
    expect(formatCompact(1234567)).toBe("1.2M");
    expect(formatCompact(950)).toBe("950");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.456)).toBe("46%");
    expect(formatValue(3, "blocks")).toBe("3 (24.0 kB)");
    expect(formatValue(true)).toBe("Yes");
  });
});

describe("layoutPlan", () => {
  it("places children below their parent without overlaps", () => {
    const p = plan(draft("Root", {}, [draft("A", {}, [draft("A1"), draft("A2")]), draft("B")]));
    const layout = layoutPlan(p.root);
    const [root, a, a1, a2, b] = p.nodes.map((n) => layout.byId.get(n.id)!);
    expect(a.y).toBeGreaterThan(root.y + NODE_HEIGHT);
    expect(a1.y).toBe(a2.y);
    expect(Math.abs(a1.x - a2.x)).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(Math.min(...layout.nodes.map((n) => n.x))).toBe(0);
    expect(layout.links).toHaveLength(4);
  });
});
