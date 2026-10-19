import { finishPlan } from "../../core/analysis";
import { computeExclusiveCosts, computeLoopTimings, computeMixedTimings } from "../../core/metrics";
import { finalizeTree, type DraftNode, type Plan, type PlanNode } from "../../core/plan";
import type { ParsedPlan, QueryResultLike } from "../types";
import { parseJsonKeepingDuplicates } from "../shared/json";
import { columnValues, flattenGridValue, isGridValue } from "../shared/results";
import { mysqlInsights, mysqlStopsEarly } from "./insights";
import { iteratorDraft } from "./iterators";
import { QueryBlockConverter } from "./queryBlock";
import { fromJsonV2, isJsonV2, isNotExecutable, jsonV2Root, looksLikeTree, parseTree, type IteratorNode } from "./tree";
import {
  isTraditional,
  parseTraditionalText,
  renderTraditional,
  rowsFromGrid,
  rowsFromResult,
  traditionalFlavor,
  traditionalToQueryBlock,
} from "./traditional";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export const NOT_EXECUTABLE_MESSAGE =
  "MySQL can't show all of this statement's plan as a tree (<not executable by iterator executor>). EXPLAIN FORMAT=JSON shows it.";

/** MySQL marks statements, or parts of them (8.0.17's subqueries), it can't show as iterators. */
const hasNotExecutablePart = (text: string) => /<not executable by iterator executor>/.test(text);

/** Finds the EXPLAIN output among the result sets the host returned. */
export function extractPlanOutput(results: QueryResultLike[]): unknown {
  // MySQL names the column EXPLAIN; MariaDB's ANALYZE names it ANALYZE.
  const values = columnValues(results, ["EXPLAIN", "ANALYZE"]);
  if (!values?.length) throw new Error("The database did not return a query plan.");
  return values.length === 1 ? values[0] : values.map(String).join("\n");
}

/** Which server wrote a plan, when that is known; undefined when the plan could be either's. */
export type PlanFlavor = "mysql" | "mariadb" | undefined;

export interface ParseOptions {
  /** The server the plan came from, which outranks guessing from the plan. */
  flavor?: PlanFlavor;
}

const STATISTICS_ADVICE = {
  mysql:
    "ANALYZE TABLE refreshes index statistics; for columns without an index, a histogram (ANALYZE TABLE … UPDATE HISTOGRAM ON …) gives the optimizer better estimates.",
  mariadb: "ANALYZE TABLE … PERSISTENT FOR ALL collects the column statistics MariaDB uses for estimates.",
  either: "ANALYZE TABLE refreshes the statistics the optimizer bases its estimates on.",
};

/**
 * Keys only MariaDB's JSON has, and keys only MySQL's has. Simple plans have
 * neither (MySQL 5.6 and MariaDB 10.x describe a single table alike).
 */
const MARIADB_KEYS = /"(?:r_loops|r_total_time_ms|query_optimization|block-nl-join|read_sorted_file|expression_cache|subquery_cache|rowid_filter|r_engine_stats|filesort|temporary_table|window_functions_computation)"\s*:/;
const MYSQL_KEYS = /"(?:cost_info|rows_examined_per_scan|rows_produced_per_join|ordering_operation|grouping_operation|windowing|using_join_buffer|used_columns|materialized_from_subquery|attached_subqueries|select_list_subqueries)"\s*:/;

export function jsonFlavor(top: Obj): PlanFlavor {
  const text = JSON.stringify(top);
  // Repeated keys ("table#2") only come from MariaDB before 11.
  if (MARIADB_KEYS.test(text) || /"[a-z_-]+#\d+"\s*:/.test(text)) return "mariadb";
  if (MYSQL_KEYS.test(text)) return "mysql";
  return undefined;
}

function finish(plan: Plan, flavor: PlanFlavor): Plan {
  computeExclusiveCosts(plan.root);
  // Some steps have no cost (sorts, temporary tables), and MySQL's query cost
  // leaves out subqueries, so the plan's cost is the largest one known.
  const costs = plan.nodes.map((n) => n.totalCost).filter((c): c is number => c !== undefined);
  plan.totalCost = costs.length ? Math.max(...costs) : undefined;
  mysqlInsights(plan);
  return finishPlan(plan, { statisticsAdvice: STATISTICS_ADVICE[flavor ?? "either"], stopsEarly: mysqlStopsEarly });
}

function newPlan(draft: DraftNode, sourceFormat: string): Plan {
  const { root, nodes } = finalizeTree(draft);
  return {
    engine: "mysql",
    sourceFormat,
    analyzed: nodes.some((n) => n.loops !== undefined),
    root,
    nodes,
    properties: [],
    insights: [],
  };
}

/** Tree text or JSON version 2: MySQL's iterators. */
function iteratorPlan(roots: IteratorNode[], sourceFormat: string): Plan {
  const [main, ...selectList] = roots.map((root) => iteratorDraft(root));
  // Subqueries in the select list run as rows are sent, outside the main tree.
  for (const subquery of selectList) {
    subquery.role = "Select list";
    main.children.push(subquery);
  }
  const plan = newPlan(main, sourceFormat);
  const isSelectList = (child: PlanNode, parent: PlanNode) => parent === plan.root && child.role === "Select list";
  computeLoopTimings(plan, { measuredSeparately: isSelectList });
  return finish(plan, "mysql");
}

/** MySQL's FORMAT=JSON version 1, and MariaDB's JSON. */
function queryBlockPlan(top: Obj, sourceFormat: string, flavor: PlanFlavor): Plan {
  const plan = newPlan(new QueryBlockConverter().block(top["query_block"] as Obj), sourceFormat);
  computeMixedTimings(plan);
  if (plan.analyzed) plan.executionTime = plan.root.inclusiveTime;
  const optimization = top["query_optimization"];
  if (isObj(optimization) && typeof optimization["r_total_time_ms"] === "number") {
    plan.planningTime = optimization["r_total_time_ms"];
  }
  return finish(plan, flavor);
}

function jsonPlan(value: unknown, raw: string, options: ParseOptions): ParsedPlan {
  const json = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (isJsonV2(json)) {
    if (isNotExecutable(jsonV2Root(json)["operation"]) || hasNotExecutablePart(raw)) throw new Error(NOT_EXECUTABLE_MESSAGE);
    return { plan: iteratorPlan(fromJsonV2(json), "json"), raw, rawFormat: "json" };
  }
  if (isObj(json) && isObj(json["query_block"])) {
    return { plan: queryBlockPlan(json, "json", options.flavor ?? jsonFlavor(json)), raw, rawFormat: "json" };
  }
  throw new Error('The JSON does not look like a MySQL or MariaDB plan (no "query_block" or "operation" key).');
}

/** The classic table, as rows keyed by lower-cased column name. */
function traditionalPlan(rows: Record<string, unknown>[], options: ParseOptions): ParsedPlan {
  const plan = queryBlockPlan(traditionalToQueryBlock(rows), "table", options.flavor ?? traditionalFlavor(rows));
  return { plan, raw: renderTraditional(rows), rawFormat: "text" };
}

const isResult = (v: unknown): v is QueryResultLike =>
  isObj(v) && Array.isArray(v["fields"]) && Array.isArray(v["rows"]);

/** Rows of the classic table, from query results, a grid range or row objects. */
function traditionalRows(input: unknown): Record<string, unknown>[] | undefined {
  if (isResult(input)) {
    const rows = rowsFromResult(input);
    return isTraditional(rows) ? rows : undefined;
  }
  if (!Array.isArray(input) || !input.length) return undefined;
  if (input.every((r) => Array.isArray(r))) return rowsFromGrid(input as unknown[][]);
  if (input.every(isObj)) {
    const rows = (input as Obj[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
    return isTraditional(rows) ? rows : undefined;
  }
  return undefined;
}

/**
 * Parses tree text, either JSON format, the classic table, or a value from a
 * results grid. Pass the server's flavor when known: some plans look the same
 * from MySQL and MariaDB.
 */
export function parseMysqlPlan(input: unknown, options: ParseOptions = {}): ParsedPlan {
  const table = traditionalRows(input);
  if (table) return traditionalPlan(table, options);
  const value = isGridValue(input) ? flattenGridValue(input) : input;
  if (typeof value !== "string") return jsonPlan(value, JSON.stringify(value, null, 2), options);

  const tableText = parseTraditionalText(value);
  if (tableText) return traditionalPlan(tableText, options);
  const text = value.trim().replace(/^EXPLAIN:\s*/, "");
  if (looksLikeTree(text) && hasNotExecutablePart(text)) throw new Error(NOT_EXECUTABLE_MESSAGE);
  if (looksLikeTree(text)) return { plan: iteratorPlan(parseTree(text), "text"), raw: text, rawFormat: "text" };
  if (/^[[{]/.test(text)) {
    let json: unknown;
    try {
      json = parseJsonKeepingDuplicates(text);
    } catch (e) {
      throw new Error(`The plan JSON could not be read: ${(e as Error).message}`);
    }
    return jsonPlan(json, text, options);
  }
  throw new Error("This doesn't look like MySQL or MariaDB EXPLAIN output.");
}

/** Whether a value looks like a plan this engine reads. */
export function canParseMysqlPlan(input: unknown): boolean {
  if (traditionalRows(input)) return true;
  const value = isGridValue(input) ? flattenGridValue(input) : input;
  if (typeof value === "string") {
    if (parseTraditionalText(value)) return true;
    const text = value.trim().replace(/^EXPLAIN:\s*/, "");
    if (looksLikeTree(text)) return true;
    if (!/^[[{]/.test(text)) return false;
    return /"query_block"\s*:/.test(text) || (/"operation"\s*:/.test(text) && /"(?:access_type|inputs|query_type)"\s*:/.test(text));
  }
  const json = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return isJsonV2(json) || (isObj(json) && isObj(json["query_block"]));
}
