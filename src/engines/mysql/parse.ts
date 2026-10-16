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
  traditionalToQueryBlock,
} from "./traditional";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export const NOT_EXECUTABLE_MESSAGE =
  "MySQL can't show this statement as a tree (<not executable by iterator executor>). EXPLAIN FORMAT=JSON shows its plan.";

/** Finds the EXPLAIN output among the result sets the host returned. */
export function extractPlanOutput(results: QueryResultLike[]): unknown {
  // MySQL names the column EXPLAIN; MariaDB's ANALYZE names it ANALYZE.
  const values = columnValues(results, ["EXPLAIN", "ANALYZE"]);
  if (!values?.length) throw new Error("The database did not return a query plan.");
  return values.length === 1 ? values[0] : values.map(String).join("\n");
}

const STATISTICS_ADVICE = {
  mysql:
    "ANALYZE TABLE refreshes index statistics; for columns without an index, a histogram (ANALYZE TABLE … UPDATE HISTOGRAM ON …) gives the optimizer better estimates.",
  mariadb: "ANALYZE TABLE … PERSISTENT FOR ALL collects the column statistics MariaDB uses for estimates.",
};

function finish(plan: Plan, flavor: "mysql" | "mariadb"): Plan {
  computeExclusiveCosts(plan.root);
  // Some steps have no cost (sorts, temporary tables), and MySQL's query cost
  // leaves out subqueries, so the plan's cost is the largest one known.
  const costs = plan.nodes.map((n) => n.totalCost).filter((c): c is number => c !== undefined);
  plan.totalCost = costs.length ? Math.max(...costs) : undefined;
  mysqlInsights(plan);
  return finishPlan(plan, { statisticsAdvice: STATISTICS_ADVICE[flavor], stopsEarly: mysqlStopsEarly });
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
function queryBlockPlan(top: Obj, sourceFormat = "json"): Plan {
  // MySQL's JSON has cost_info and rows_examined_per_scan; MariaDB's doesn't.
  const mariadb = !/"(?:cost_info|rows_examined_per_scan)"/.test(JSON.stringify(top));
  const plan = newPlan(new QueryBlockConverter().block(top["query_block"] as Obj), sourceFormat);
  computeMixedTimings(plan);
  if (plan.analyzed) plan.executionTime = plan.root.inclusiveTime;
  const optimization = top["query_optimization"];
  if (isObj(optimization) && typeof optimization["r_total_time_ms"] === "number") {
    plan.planningTime = optimization["r_total_time_ms"];
  }
  return finish(plan, mariadb ? "mariadb" : "mysql");
}

function jsonPlan(value: unknown, raw: string): ParsedPlan {
  const json = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (isJsonV2(json)) {
    if (isNotExecutable(jsonV2Root(json)["operation"])) throw new Error(NOT_EXECUTABLE_MESSAGE);
    return { plan: iteratorPlan(fromJsonV2(json), "json"), raw, rawFormat: "json" };
  }
  if (isObj(json) && isObj(json["query_block"])) {
    return { plan: queryBlockPlan(json), raw, rawFormat: "json" };
  }
  throw new Error('The JSON does not look like a MySQL or MariaDB plan (no "query_block" or "operation" key).');
}

/** The classic table, as rows keyed by lower-cased column name. */
function traditionalPlan(rows: Record<string, unknown>[]): ParsedPlan {
  const plan = queryBlockPlan(traditionalToQueryBlock(rows), "table");
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

/** Parses tree text, either JSON format, the classic table, or a value from a results grid. */
export function parseMysqlPlan(input: unknown): ParsedPlan {
  const table = traditionalRows(input);
  if (table) return traditionalPlan(table);
  const value = isGridValue(input) ? flattenGridValue(input) : input;
  if (typeof value !== "string") return jsonPlan(value, JSON.stringify(value, null, 2));

  const tableText = parseTraditionalText(value);
  if (tableText) return traditionalPlan(tableText);
  const text = value.trim().replace(/^EXPLAIN:\s*/, "");
  if (isNotExecutable(text)) throw new Error(NOT_EXECUTABLE_MESSAGE);
  if (looksLikeTree(text)) return { plan: iteratorPlan(parseTree(text), "text"), raw: text, rawFormat: "text" };
  if (/^[[{]/.test(text)) {
    let json: unknown;
    try {
      json = parseJsonKeepingDuplicates(text);
    } catch (e) {
      throw new Error(`The plan JSON could not be read: ${(e as Error).message}`);
    }
    return jsonPlan(json, text);
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
