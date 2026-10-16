import { describe, expect, it } from "vitest";
import { computeExclusiveCosts, computeLoopTimings, computeMixedTimings } from "../../src/core/metrics";
import { finalizeTree, type DraftNode, type Plan } from "../../src/core/plan";

const node = (operation: string, fields: Partial<DraftNode> = {}, children: DraftNode[] = []): DraftNode => ({
  operation,
  kind: "other",
  conditions: [],
  properties: [],
  children,
  ...fields,
});

function plan(draft: DraftNode): Plan {
  const { root, nodes } = finalizeTree(draft);
  return { engine: "test", sourceFormat: "json", analyzed: true, root, nodes, properties: [], insights: [] };
}

describe("computeLoopTimings", () => {
  it("multiplies per-loop times by loops and takes children out of self time", () => {
    const p = plan(
      node("Join", { actualTotalTime: 10, loops: 1, actualRows: 5 }, [
        node("Outer", { actualTotalTime: 4, loops: 1, actualRows: 100 }),
        node("Inner", { actualTotalTime: 0.05, loops: 100, actualRows: 0.5 }),
      ])
    );
    computeLoopTimings(p);
    const [join, outer, inner] = p.nodes;
    expect(inner).toMatchObject({ inclusiveTime: 5, exclusiveTime: 5, totalActualRows: 50 });
    expect(outer.exclusiveTime).toBe(4);
    expect(join).toMatchObject({ inclusiveTime: 10, exclusiveTime: 1 });
  });

  it("passes children's time through steps without their own, and counts separate children on top", () => {
    const p = plan(
      node("Root", { actualTotalTime: 3, loops: 1 }, [
        node("Hash", {}, [node("Scan", { actualTotalTime: 2, loops: 1 })]),
        node("Subquery", { role: "Select list" }, [node("Lookup", { actualTotalTime: 0.01, loops: 400 })]),
        node("Skipped", { neverExecuted: true, loops: 0 }),
      ])
    );
    computeLoopTimings(p, { measuredSeparately: (child) => child.role === "Select list" });
    const [root, hash, , subquery, , skipped] = p.nodes;
    expect(hash).toMatchObject({ inclusiveTime: 2, exclusiveTime: 0 });
    expect(subquery.inclusiveTime).toBeCloseTo(4);
    expect(skipped).toMatchObject({ inclusiveTime: 0, exclusiveTime: 0 });
    // Measured 3 ms, plus 4 ms of select-list subquery; 2 ms of that was the hash.
    expect(root.inclusiveTime).toBeCloseTo(7);
    expect(root.exclusiveTime).toBeCloseTo(1);
  });
});

describe("computeMixedTimings", () => {
  it("combines whole-block timers with per-step timers", () => {
    const p = plan(
      node("Block", { actualTotalTime: 50, loops: 2 }, [
        node("Sort", { exclusiveTime: 5 }, [node("Table", { exclusiveTime: 60 }), node("Untimed")]),
      ])
    );
    computeMixedTimings(p);
    const [block, sort, table, untimed] = p.nodes;
    expect(table).toMatchObject({ inclusiveTime: 60, exclusiveTime: 60 });
    expect(untimed.inclusiveTime).toBeUndefined();
    expect(sort).toMatchObject({ inclusiveTime: 65, exclusiveTime: 5 });
    expect(block).toMatchObject({ inclusiveTime: 100, exclusiveTime: 35 });
  });

  it("never gives a block less time than its steps took", () => {
    const p = plan(node("Block", { actualTotalTime: 1, loops: 1 }, [node("Table", { exclusiveTime: 3 })]));
    computeMixedTimings(p);
    expect(p.root).toMatchObject({ inclusiveTime: 3, exclusiveTime: 0 });
  });
});

describe("computeExclusiveCosts", () => {
  it("subtracts the children's cost and never goes negative", () => {
    const p = plan(node("Root", { totalCost: 10 }, [node("A", { totalCost: 4 }), node("B", { totalCost: 8 }), node("C")]));
    computeExclusiveCosts(p.root);
    expect(p.nodes.map((n) => n.exclusiveCost)).toEqual([0, 4, 8, undefined]);
  });
});
