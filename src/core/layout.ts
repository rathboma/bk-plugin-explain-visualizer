import { hierarchy, tree } from "d3-hierarchy";
import type { PlanNode } from "./plan";

export const NODE_WIDTH = 236;
export const NODE_HEIGHT = 96;
const H_GAP = 28;
const V_GAP = 64;

export interface PositionedNode {
  node: PlanNode;
  /** Top-left corner of the card. */
  x: number;
  y: number;
}

export interface PositionedLink {
  parent: PositionedNode;
  child: PositionedNode;
  /** Position of the child among its siblings, used to spread links apart. */
  index: number;
  siblings: number;
}

export interface PlanLayout {
  nodes: PositionedNode[];
  links: PositionedLink[];
  width: number;
  height: number;
  byId: Map<number, PositionedNode>;
}

/**
 * Lays the plan out top-down, root first, like the plan reads in text form.
 * Data flows upwards along the links, from the leaves to the root.
 */
export function layoutPlan(root: PlanNode): PlanLayout {
  const h = hierarchy(root, (n) => n.children);
  tree<PlanNode>()
    .nodeSize([NODE_WIDTH + H_GAP, NODE_HEIGHT + V_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.2))(h);

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  h.each((d) => {
    minX = Math.min(minX, d.x!);
    maxX = Math.max(maxX, d.x!);
    maxY = Math.max(maxY, d.y!);
  });

  const byId = new Map<number, PositionedNode>();
  const nodes: PositionedNode[] = [];
  h.each((d) => {
    const positioned = { node: d.data, x: d.x! - minX, y: d.y! };
    byId.set(d.data.id, positioned);
    nodes.push(positioned);
  });

  const links: PositionedLink[] = h.links().map((l) => ({
    parent: byId.get(l.source.data.id)!,
    child: byId.get(l.target.data.id)!,
    index: l.source.data.children.indexOf(l.target.data),
    siblings: l.source.data.children.length,
  }));

  return {
    nodes,
    links,
    width: maxX - minX + NODE_WIDTH,
    height: maxY + NODE_HEIGHT,
    byId,
  };
}

/** A smooth vertical curve from the bottom of the parent to the top of the child. */
export function linkPath(link: PositionedLink): string {
  // Links leave the parent side by side instead of from a single point.
  const spread = Math.min(18, (NODE_WIDTH * 0.6) / Math.max(1, link.siblings - 1));
  const x1 = link.parent.x + NODE_WIDTH / 2 + (link.index - (link.siblings - 1) / 2) * spread;
  const y1 = link.parent.y + NODE_HEIGHT;
  const x2 = link.child.x + NODE_WIDTH / 2;
  const y2 = link.child.y;
  const mid = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
}
