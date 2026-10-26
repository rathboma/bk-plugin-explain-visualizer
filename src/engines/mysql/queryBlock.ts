/**
 * Turns the query-block JSON of MySQL's EXPLAIN FORMAT=JSON (5.6 to 8.x,
 * version 1) and MariaDB's EXPLAIN / ANALYZE FORMAT=JSON into the shared
 * model.
 *
 * These describe a plan as nested operations ("ordering_operation",
 * "filesort", "temporary_table"...) around a list of tables read in a nested
 * loop. The tables become a left-deep chain of join nodes, so the diagram
 * reads like MySQL's tree format. MariaDB's ANALYZE adds measurements, all
 * prefixed with r_: rows and loops per table, and time per table rather than
 * per step.
 */
import type { Condition, DraftNode, NodeKind, Property, ValueFormat } from "../../core/plan";
import { baseKey } from "../shared/json";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** MySQL writes costs and percentages as strings: "20132.25", "10.00". */
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const sum = (values: (number | undefined)[]) => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
};

/** Table access types, as MySQL's tree format names them. */
const ACCESS: Record<string, [string, NodeKind]> = {
  ALL: ["Table scan", "scan"],
  index: ["Index scan", "index"],
  range: ["Index range scan", "index"],
  ref: ["Index lookup", "index"],
  eq_ref: ["Single-row index lookup", "index"],
  ref_or_null: ["Index lookup or null", "index"],
  const: ["Constant row", "other"],
  system: ["Constant row", "other"],
  fulltext: ["Full-text index search", "index"],
  index_merge: ["Index merge", "index"],
  unique_subquery: ["Unique subquery lookup", "index"],
  index_subquery: ["Index subquery lookup", "index"],
};

/** How known keys are labelled in the details panel: [group, label, format]. */
const PROPERTIES: Record<string, [string, string, ValueFormat?]> = {
  possible_keys: ["Node", "Possible keys", "code"],
  key_length: ["Node", "Key length"],
  used_key_parts: ["Node", "Used key parts", "code"],
  used_columns: ["Node", "Used columns", "code"],
  partitions: ["Node", "Partitions", "code"],
  access_type: ["Node", "Access type"],
  using_index: ["Node", "Covering index"],
  using_index_for_group_by: ["Node", "Index for GROUP BY"],
  using_join_buffer: ["Node", "Join buffer"],
  using_MRR: ["Node", "Multi-range read"],
  using_temporary_table: ["Node", "Temporary table"],
  using_filesort: ["Node", "Filesort"],
  dependent: ["Node", "Dependent"],
  cacheable: ["Node", "Cacheable"],
  first_match: ["Node", "First match", "code"],
  loosescan: ["Node", "Loose scan"],
  not_exists: ["Node", "Not exists"],
  distinct: ["Node", "Distinct"],
  join_type: ["Node", "Join type"],
  buffer_type: ["Node", "Buffer type"],
  buffer_size: ["Node", "Buffer size"],
  lateral: ["Node", "Lateral"],
  unique: ["Node", "Unique"],
  state: ["Node", "Cache"],
  rows_examined_per_scan: ["Estimates", "Rows read per scan", "rows"],
  rows_produced_per_join: ["Estimates", "Rows produced", "rows"],
  rows: ["Estimates", "Rows read per scan", "rows"],
  loops: ["Estimates", "Loops", "number"],
  filtered: ["Estimates", "Filtered", "percent"],
  cost: ["Estimates", "Cost", "cost"],
  query_cost: ["Estimates", "Query cost", "cost"],
  read_cost: ["Estimates", "Read cost", "cost"],
  eval_cost: ["Estimates", "Evaluation cost", "cost"],
  prefix_cost: ["Estimates", "Prefix cost", "cost"],
  sort_cost: ["Estimates", "Sort cost", "cost"],
  data_read_per_join: ["Estimates", "Data read"],
  r_loops: ["Runtime", "Loops", "number"],
  r_table_loops: ["Runtime", "Table loops", "number"],
  r_rows: ["Runtime", "Rows read per loop", "rows"],
  r_filtered: ["Runtime", "Filtered", "percent"],
  r_total_time_ms: ["Runtime", "Total time", "ms"],
  r_table_time_ms: ["Runtime", "Table time", "ms"],
  r_other_time_ms: ["Runtime", "Other time", "ms"],
  r_unpack_time_ms: ["Runtime", "Join buffer time", "ms"],
  r_effective_rows: ["Runtime", "Effective rows", "rows"],
  r_output_rows: ["Runtime", "Output rows", "rows"],
  r_used_priority_queue: ["Runtime", "Priority queue"],
  r_buffer_size: ["Runtime", "Buffer size"],
  r_sort_mode: ["Runtime", "Sort mode"],
  r_hit_ratio: ["Runtime", "Cache hit ratio", "percent"],
  pages_accessed: ["Runtime", "Pages accessed", "number"],
  pages_read_count: ["Runtime", "Pages read", "number"],
  pages_read_time_ms: ["Runtime", "Page read time", "ms"],
  old_rows_read: ["Runtime", "Old row versions read", "number"],
};

/** Keys turned into nodes, conditions or model fields rather than properties. */
const MODELLED = new Set([
  "select_id",
  "table_name",
  "key",
  "ref",
  "attached_condition",
  "index_condition",
  "having_condition",
  "sort_key",
  "message",
  "insert",
  "update",
  "delete",
  "operation",
  "windows",
  "r_unpack_time_ms",
]);

/** Containers of nodes: never shown as properties. */
const CONTAINERS = new Set([
  "query_block",
  "table",
  "block-nl-join",
  "nested_loop",
  "ordering_operation",
  "grouping_operation",
  "duplicates_removal",
  "windowing",
  "buffer_result",
  "union_result",
  "query_specifications",
  "filesort",
  "temporary_table",
  "read_sorted_file",
  "window_functions_computation",
  "sorts",
  "subqueries",
  "attached_subqueries",
  "select_list_subqueries",
  "having_subqueries",
  "order_by_subqueries",
  "group_by_subqueries",
  "optimized_away_subqueries",
  "update_value_subqueries",
  "materialized_from_subquery",
  "materialized",
  "materialization",
  "expression_cache",
  "subquery_cache",
  "insert_from",
]);

const SUBQUERY_ROLES: Record<string, string> = {
  attached_subqueries: "Condition",
  select_list_subqueries: "Select list",
  having_subqueries: "Having",
  order_by_subqueries: "Order by",
  group_by_subqueries: "Group by",
  optimized_away_subqueries: "Optimized away",
  update_value_subqueries: "Update value",
  subqueries: "Subquery",
};

function formatValue(value: unknown, format?: ValueFormat): Property["value"] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.map((v) => (isObj(v) ? JSON.stringify(v) : String(v))).join(", ");
  if (isObj(value)) return JSON.stringify(value);
  if (format === "percent") {
    const n = num(value);
    return n === undefined ? String(value) : n / 100;
  }
  if (format && ["cost", "rows", "number", "ms"].includes(format)) return num(value) ?? String(value);
  return value as Property["value"];
}

/** Scalar keys (and the cost_info and r_engine_stats objects) as details-panel properties. */
function properties(obj: Obj): Property[] {
  const props: Property[] = [];
  const add = (key: string, value: unknown) => {
    const [group, label, format] = PROPERTIES[key] ?? ["Other", key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())];
    const formatted = formatValue(value, format);
    if (formatted === undefined || formatted === false) return;
    props.push({ group, label, value: formatted, format: format ?? (typeof formatted === "number" ? "number" : "text") });
  };
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = baseKey(rawKey);
    if (MODELLED.has(key) || CONTAINERS.has(key)) continue;
    if ((key === "cost_info" || key === "r_engine_stats") && isObj(value)) {
      for (const [k, v] of Object.entries(value)) add(k, v);
    } else {
      add(key, value);
    }
  }
  return props;
}

/** The object without its child containers, shown as the node's raw JSON. */
function rawOf(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !CONTAINERS.has(baseKey(k))));
}

/** "id = shop.o.customer_id" from MySQL's used_key_parts and ref lists. */
function lookupCondition(table: Obj): string | undefined {
  const refs = Array.isArray(table["ref"]) ? (table["ref"] as unknown[]).map(String) : [];
  if (!refs.length) return undefined;
  const parts = Array.isArray(table["used_key_parts"]) ? (table["used_key_parts"] as unknown[]).map(String) : [];
  return refs.map((ref, i) => (parts[i] ? `${parts[i]} = ${ref}` : ref)).join(" AND ");
}

export class QueryBlockConverter {
  /** Child nodes from an object's containers, in the order the server listed them. */
  content(obj: Obj): DraftNode[] {
    const nodes: DraftNode[] = [];
    // Tables listed one after another (MariaDB before 11 repeats "table") are a join.
    let tables: Obj[] = [];
    const flush = () => {
      if (tables.length) nodes.push(this.joinChain(tables));
      tables = [];
    };
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = baseKey(rawKey);
      if ((key === "table" || key === "block-nl-join") && isObj(value)) {
        tables.push({ [key]: value });
        continue;
      }
      flush();
      nodes.push(...this.container(key, value, obj));
    }
    flush();
    return nodes;
  }

  private container(key: string, value: unknown, parent: Obj): DraftNode[] {
    const items = Array.isArray(value) ? value.filter(isObj) : [];
    switch (key) {
      case "query_block":
        return isObj(value) ? [this.block(value)] : [];
      case "nested_loop":
        return items.length ? [this.joinChain(items)] : [];
      case "query_specifications":
        return items.map((spec) => this.subquery(spec));
      case "insert_from":
        // Children of the Insert node; see block().
        return isObj(parent["table"]) && (parent["table"] as Obj)["insert"] ? [] : this.content(value as Obj);
    }
    if (key in SUBQUERY_ROLES) return items.map((item) => this.subquery(item, SUBQUERY_ROLES[key]));
    if (!isObj(value)) {
      // MariaDB lists the tables of a semi-join weedout in an array.
      if (key === "duplicates_removal" && items.length) {
        return [this.wrapper("Remove duplicates", "aggregate", {}, [this.joinChain(items)])];
      }
      return items.flatMap((item) => this.content(item));
    }
    switch (key) {
      case "ordering_operation":
        // Without a filesort the order comes from an index: nothing to show.
        return value["using_filesort"] || value["using_temporary_table"]
          ? [this.wrapper("Sort", "sort", value)]
          : this.content(value);
      case "grouping_operation":
        return [this.wrapper("Group", "aggregate", value)];
      case "duplicates_removal":
        return [this.wrapper("Remove duplicates", "aggregate", value)];
      case "windowing":
        return [this.wrapper("Window", "aggregate", value)];
      case "buffer_result":
        return [this.wrapper("Buffer result", "materialize", value)];
      case "union_result":
        return [this.wrapper(value["table_name"] || value["using_temporary_table"] ? "Union" : "Union all", "set", value)];
      case "filesort":
        return [this.wrapper("Sort", "sort", value)];
      case "temporary_table":
        return [this.wrapper("Temporary table", "materialize", value)];
      case "window_functions_computation":
        return [this.wrapper("Window functions", "aggregate", value)];
      case "materialized_from_subquery":
      case "materialized":
        return [this.wrapper("Materialize", "materialize", value)];
      default:
        // read_sorted_file, sorts and unknown wrappers: their contents only.
        return this.content(value);
    }
  }

  /** An operation around other nodes: sort, group, temporary table... */
  private wrapper(operation: string, kind: NodeKind, obj: Obj, children = this.content(obj)): DraftNode {
    const conditions: Condition[] = [];
    if (str(obj["sort_key"])) conditions.push({ label: "Sort key", expression: obj["sort_key"] as string });
    if (Array.isArray(obj["windows"])) {
      for (const window of (obj["windows"] as unknown[]).filter(isObj)) {
        const parts = [
          Array.isArray(window["functions"]) ? (window["functions"] as unknown[]).join(", ") : undefined,
          Array.isArray(window["filesort_key"]) ? `sorted by ${(window["filesort_key"] as unknown[]).join(", ")}` : undefined,
        ].filter(Boolean);
        conditions.push({ label: String(window["name"] ?? "Window"), expression: parts.join(" ") });
      }
    }
    const flags = [
      obj["using_temporary_table"] === true && kind !== "materialize" ? "temporary table" : undefined,
      obj["using_filesort"] === true && kind !== "sort" ? "filesort" : undefined,
      obj["lateral"] ? "lateral" : undefined,
      obj["unique"] ? "deduplicated" : undefined,
      obj["dependent"] === true ? "dependent" : undefined,
    ].filter(Boolean);

    const node: DraftNode = {
      operation,
      kind,
      description: flags.length ? flags.join(", ") : undefined,
      conditions,
      properties: properties(obj),
      children,
      raw: rawOf(obj),
    };
    // Costs roll up through wrappers; MySQL adds a sort's own cost.
    const sortCost = num((obj["cost_info"] as Obj | undefined)?.["sort_cost"]);
    const childCost = sum(children.map((c) => c.totalCost));
    if (sortCost !== undefined || childCost !== undefined) node.totalCost = (sortCost ?? 0) + (childCost ?? 0);

    // MariaDB times a filesort on its own.
    const loops = num(obj["r_loops"]);
    if (loops !== undefined) {
      node.loops = loops;
      node.neverExecuted = loops === 0;
      const time = num(obj["r_total_time_ms"]);
      if (time !== undefined) node.exclusiveTime = time;
      const output = num(obj["r_output_rows"]);
      if (output !== undefined) node.actualRows = loops ? output / loops : 0;
    }
    return node;
  }

  /** A query block: "Select #2". */
  block(block: Obj, flags: string[] = [], role?: string): DraftNode {
    const id = block["select_id"];
    const table = isObj(block["table"]) ? (block["table"] as Obj) : undefined;
    let children: DraftNode[];
    if (table?.["insert"] && isObj(block["insert_from"])) {
      // INSERT ... SELECT: the rows inserted come from insert_from.
      const insert = this.table(table);
      insert.children.push(...this.content(block["insert_from"] as Obj));
      children = [insert];
    } else {
      children = this.content(block);
    }

    const description = [
      ...flags,
      str(block["operation"])?.toLowerCase(),
      str(block["message"]),
    ].filter(Boolean);
    const node: DraftNode = {
      operation: id !== undefined ? `Select #${id}` : "Query block",
      kind: "subquery",
      description: description.length ? description.join(", ") : undefined,
      role,
      totalCost:
        num((block["cost_info"] as Obj | undefined)?.["query_cost"]) ??
        num(block["cost"]) ??
        sum(children.map((c) => c.totalCost)),
      conditions: str(block["having_condition"]) ? [{ label: "Having", expression: block["having_condition"] as string }] : [],
      properties: properties(block),
      children,
      raw: rawOf(block),
    };
    // MariaDB measures a whole block, including what it reads.
    const loops = num(block["r_loops"]);
    const time = num(block["r_total_time_ms"]);
    if (loops !== undefined) {
      node.loops = loops;
      node.neverExecuted = loops === 0;
      if (time !== undefined && loops > 0) node.actualTotalTime = time / loops;
    }
    return node;
  }

  /** A subquery entry: a query block, maybe inside an expression cache or materialization. */
  private subquery(item: Obj, role?: string): DraftNode {
    const flags: string[] = [];
    if (item["dependent"] === true) flags.push("dependent");
    if (item["cacheable"] === false) flags.push("uncacheable");
    let current: Obj = item;
    for (const key of ["expression_cache", "subquery_cache", "materialization"]) {
      if (isObj(current[key])) {
        flags.push(key === "materialization" ? "materialized" : `cache ${(current[key] as Obj)["state"] ?? ""}`.trim());
        current = current[key] as Obj;
      }
    }
    if (!isObj(current["query_block"])) {
      return this.wrapper("Subquery", "subquery", item);
    }
    const node = this.block(current["query_block"] as Obj, flags, role);
    if (current !== item) node.properties.push(...properties(current));
    return node;
  }

  /** One table read. */
  table(table: Obj, role?: string): DraftNode {
    const access = str(table["access_type"]) ?? "";
    const hashed = access.startsWith("hash_");
    const [name, kind] = ACCESS[hashed ? access.slice(5) : access] ?? ["Table access", "other"];
    const covering = table["using_index"] === true && kind === "index";
    let operation = covering ? `Covering ${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
    if (hashed) operation += " (hashed)";
    let nodeKind: NodeKind = kind;
    let description: string | undefined;

    const modify = table["insert"] ? "Insert" : table["update"] ? "Update" : table["delete"] ? "Delete" : undefined;
    if (modify) {
      // How the rows to change are found; an INSERT's table is not read.
      description = access && modify !== "Insert" ? operation.toLowerCase() : undefined;
      operation = modify;
      nodeKind = "modify";
    }
    const message = str(table["message"]);
    if (message && !table["table_name"]) {
      operation = message;
      nodeKind = "other";
    }

    const conditions: Condition[] = [];
    const lookup = lookupCondition(table);
    if (lookup) conditions.push({ label: "Lookup", expression: lookup });
    if (str(table["index_condition"])) conditions.push({ label: "Index condition", expression: table["index_condition"] as string });
    if (str(table["attached_condition"])) conditions.push({ label: "Filter", expression: table["attached_condition"] as string });

    const readPerScan = num(table["rows_examined_per_scan"]) ?? num(table["rows"]);
    const filtered = num(table["filtered"]);
    const children = this.content(table);
    const costInfo = table["cost_info"] as Obj | undefined;
    const ownCost = costInfo
      ? sum([num(costInfo["read_cost"]), num(costInfo["eval_cost"])])
      : num(table["cost"]);

    const node: DraftNode = {
      operation,
      kind: nodeKind,
      target: str(table["table_name"]),
      index: str(table["key"]),
      description,
      role,
      // Rows that pass the table's own condition, per scan.
      estimatedRows: readPerScan !== undefined ? readPerScan * (filtered ?? 100) / 100 : undefined,
      // What the table's subqueries and materializations cost comes on top.
      totalCost: sum([ownCost, sum(children.map((c) => c.totalCost))]),
      conditions,
      properties: properties(table),
      children,
      raw: rawOf(table),
    };

    // MariaDB's ANALYZE: rows read per loop, the share kept, and time spent
    // reading (r_table_time_ms) and checking conditions (r_other_time_ms).
    const loops = num(table["r_loops"]);
    if (loops !== undefined) {
      node.loops = loops;
      node.neverExecuted = loops === 0;
      const read = num(table["r_rows"]);
      node.actualRows = loops === 0 ? 0 : read !== undefined ? (read * (num(table["r_filtered"]) ?? 100)) / 100 : undefined;
      node.exclusiveTime =
        sum([num(table["r_table_time_ms"]), num(table["r_other_time_ms"])]) ?? num(table["r_total_time_ms"]);
    }
    return node;
  }

  /** Tables read in order, as a left-deep chain of joins: ((t1 ⋈ t2) ⋈ t3). */
  private joinChain(items: Obj[]): DraftNode {
    const parts = items.map((item) => {
      if (isObj(item["table"])) return { node: this.table(item["table"] as Obj), table: item["table"] as Obj };
      const bnl = item["block-nl-join"];
      if (isObj(bnl) && isObj(bnl["table"])) return { node: this.table(bnl["table"] as Obj), table: bnl["table"] as Obj, bnl };
      const nodes = this.content(item);
      const node = nodes.length === 1 ? nodes[0] : this.wrapper("Steps", "other", {}, nodes);
      return { node, table: undefined, bnl: undefined };
    });

    let outer = parts[0].node;
    for (const part of parts.slice(1)) outer = this.join(outer, part.node, part.table, part.bnl);
    return outer;
  }

  private join(outer: DraftNode, inner: DraftNode, table: Obj | undefined, bnl: Obj | undefined): DraftNode {
    let operation = "Nested loop";
    const buffer = String(table?.["using_join_buffer"] ?? bnl?.["join_type"] ?? "");
    if (/hash join|^BNLH$/i.test(buffer)) operation = "Hash join";
    else if (/block nested loop|^BNL$/i.test(buffer)) operation = "Block nested loop";
    else if (/batched key access|^BKAH?$/i.test(buffer)) operation = "Batched key access";
    const description = table?.["not_exists"] ? "antijoin" : table?.["first_match"] ? "semijoin (first match)" : undefined;
    outer.role ??= "Outer";
    inner.role ??= "Inner";

    const node: DraftNode = {
      operation,
      kind: "join",
      description,
      conditions: str(bnl?.["attached_condition"]) ? [{ label: "Join condition", expression: bnl!["attached_condition"] as string }] : [],
      properties: bnl ? properties(bnl) : [],
      children: [outer, inner],
      raw: bnl ? rawOf(bnl) : { join: operation },
    };

    // MySQL: the rows the join produces and the cost of the whole prefix.
    const produced = num(table?.["rows_produced_per_join"]);
    const prefix = num((table?.["cost_info"] as Obj | undefined)?.["prefix_cost"]);
    if (produced !== undefined) node.estimatedRows = produced;
    const childCost = sum([outer.totalCost, inner.totalCost]);
    if (prefix !== undefined || childCost !== undefined) node.totalCost = Math.max(prefix ?? 0, childCost ?? 0);

    // MariaDB 11 estimates loops per table: the inner table runs once per joined row.
    const innerLoops = num(table?.["loops"]);
    if (produced === undefined && innerLoops !== undefined && inner.estimatedRows !== undefined) {
      node.estimatedRows = innerLoops * inner.estimatedRows;
    }

    // MariaDB's ANALYZE: rows out of the join, and time in its join buffer.
    if (inner.loops !== undefined && inner.actualRows !== undefined) {
      const outerTotal = (outer.actualRows ?? 0) * (outer.loops ?? 1);
      const joinFiltered = num(bnl?.["r_filtered"]);
      const total = bnl
        ? outerTotal * (num(table?.["r_rows"]) ?? 0) * ((num(table?.["r_filtered"]) ?? 100) / 100) * ((joinFiltered ?? 100) / 100)
        : inner.actualRows * inner.loops;
      const loops = outer.loops ?? 1;
      node.loops = loops;
      node.actualRows = loops ? total / loops : 0;
      if (bnl) node.exclusiveTime = sum([num(bnl["r_unpack_time_ms"]), num(bnl["r_other_time_ms"])]);
    }
    return node;
  }
}
