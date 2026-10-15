import type { NodeKind } from "../../core/plan";

/** A PostgreSQL JSON plan node. Keys are the ones EXPLAIN (FORMAT JSON) uses. */
export type PgNode = Record<string, unknown> & { Plans?: PgNode[] };

const KINDS: Record<string, NodeKind> = {
  "Seq Scan": "scan",
  "Sample Scan": "scan",
  "Tid Scan": "scan",
  "Tid Range Scan": "scan",
  "Foreign Scan": "scan",
  "Custom Scan": "scan",
  "Index Scan": "index",
  "Index Only Scan": "index",
  "Bitmap Index Scan": "index",
  "Bitmap Heap Scan": "index",
  BitmapAnd: "index",
  BitmapOr: "index",
  "Nested Loop": "join",
  "Hash Join": "join",
  "Merge Join": "join",
  Aggregate: "aggregate",
  Group: "aggregate",
  WindowAgg: "aggregate",
  Unique: "aggregate",
  Sort: "sort",
  "Incremental Sort": "sort",
  Limit: "limit",
  Hash: "materialize",
  Materialize: "materialize",
  Memoize: "materialize",
  Append: "set",
  "Merge Append": "set",
  "Recursive Union": "set",
  SetOp: "set",
  "Subquery Scan": "subquery",
  "CTE Scan": "subquery",
  "Function Scan": "subquery",
  "Table Function Scan": "subquery",
  "Values Scan": "subquery",
  "WorkTable Scan": "subquery",
  "Named Tuplestore Scan": "subquery",
  Result: "subquery",
  ProjectSet: "subquery",
  ModifyTable: "modify",
  Gather: "parallel",
  "Gather Merge": "parallel",
};

export function nodeKind(nodeType: string): NodeKind {
  return KINDS[nodeType] ?? "other";
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * The operator name as psql's text format prints it, which is what most
 * PostgreSQL users recognise: "Hash Left Join", "Partial HashAggregate",
 * "Parallel Seq Scan", "Index Scan Backward", "Update"...
 */
export function displayName(node: PgNode): string {
  const type = str(node["Node Type"]) ?? "Unknown";
  let name = type;

  switch (type) {
    case "Aggregate": {
      const strategy = str(node["Strategy"]);
      if (strategy === "Hashed") name = "HashAggregate";
      else if (strategy === "Sorted") name = "GroupAggregate";
      else if (strategy === "Mixed") name = "MixedAggregate";
      break;
    }
    case "SetOp": {
      const command = str(node["Command"]);
      name = str(node["Strategy"]) === "Hashed" ? "HashSetOp" : "SetOp";
      if (command) name += ` ${command}`;
      break;
    }
    case "ModifyTable":
      name = str(node["Operation"]) ?? "ModifyTable";
      break;
    case "Nested Loop":
    case "Hash Join":
    case "Merge Join": {
      const joinType = str(node["Join Type"]);
      if (joinType && joinType !== "Inner") {
        name = type === "Nested Loop" ? `Nested Loop ${joinType} Join` : type.replace(" Join", ` ${joinType} Join`);
      }
      break;
    }
    case "Index Scan":
    case "Index Only Scan":
      if (node["Scan Direction"] === "Backward") name += " Backward";
      break;
    case "Custom Scan": {
      const provider = str(node["Custom Plan Provider"]);
      if (provider) name += ` (${provider})`;
      break;
    }
  }

  const partial = str(node["Partial Mode"]);
  if (partial && partial !== "Simple") name = `${partial} ${name}`;
  if (node["Parallel Aware"] === true) name = `Parallel ${name}`;
  if (node["Async Capable"] === true && type === "Foreign Scan") name = `Async ${name}`;
  return name;
}

/** "schema.relation alias", skipping parts that add nothing. */
export function targetName(node: PgNode): string | undefined {
  const type = str(node["Node Type"]);
  const alias = str(node["Alias"]);
  let base: string | undefined;

  if (type === "Bitmap Index Scan") return undefined;
  if (str(node["Relation Name"])) {
    const schema = str(node["Schema"]);
    base = schema ? `${schema}.${node["Relation Name"]}` : (node["Relation Name"] as string);
  } else if (str(node["CTE Name"])) {
    base = node["CTE Name"] as string;
  } else if (str(node["Function Name"])) {
    const schema = str(node["Schema"]);
    base = schema ? `${schema}.${node["Function Name"]}` : (node["Function Name"] as string);
  } else if (str(node["Tuplestore Name"])) {
    base = node["Tuplestore Name"] as string;
  } else if (alias) {
    return alias;
  }

  if (!base) return undefined;
  const bare = base.split(".").pop();
  return alias && alias !== bare ? `${base} ${alias}` : base;
}
