/**
 * SQLite's EXPLAIN QUERY PLAN returns one row per step:
 *
 * - since 3.24: (id, parent, notused, detail), a tree through `parent`;
 * - before: (selectid, order, from, detail), flat, with subqueries referred
 *   to by number ("EXECUTE SCALAR SUBQUERY 2" runs the rows of selectid 2).
 *
 * The sqlite3 shell prints the same tree as text, which is also how the Raw
 * view shows it, so a plan can always be read back from its raw text:
 *
 *   QUERY PLAN
 *   |--SCAN c USING COVERING INDEX customers_country_idx
 *   `--SEARCH o USING INDEX orders_customer_id_idx (customer_id=?)
 *
 * SQLite reports no costs, row counts or timings, so plans only have the
 * steps, their tables, indexes and constraints.
 */
import { finishPlan } from "../../core/analysis";
import { finalizeTree, type DraftNode, type Plan } from "../../core/plan";
import type { ParsedPlan, QueryResultLike } from "../types";
import { isGridValue, rowsByName } from "../shared/results";
import { DETAIL_START, describe } from "./details";
import { sqliteInsights } from "./insights";

/** A step before it is described: its text, children and source row. */
interface Step {
  detail: string;
  children: Step[];
  row: Record<string, unknown>;
  /** Old-format "SUBQUERY n" references, resolved into children. */
  references?: number[];
}

/** SQLite integers arrive as numbers, strings or (from better-sqlite3) BigInts. */
const int = (value: unknown): number | undefined => {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

type Tuple = [number, number, number, string];

/** Rows of the current format: a tree through `parent`. */
function fromTree(rows: Tuple[]): Step[] {
  const steps = new Map<number, Step>();
  const top: Step[] = [];
  for (const [id, parent, notused, detail] of rows) {
    steps.set(id, { detail, children: [], row: { id, parent, notused, detail } });
  }
  for (const [id, parent] of rows) {
    const step = steps.get(id)!;
    const parentStep = parent !== id ? steps.get(parent) : undefined;
    (parentStep ? parentStep.children : top).push(step);
  }
  return top;
}

/** Rows of the format before 3.24: grouped by selectid, joined up through "SUBQUERY n" references. */
function fromSelectIds(rows: Tuple[]): Step[] {
  const groups = new Map<number, Step[]>();
  for (const [selectid, order, from, detail] of rows) {
    if (!groups.has(selectid)) groups.set(selectid, []);
    groups.get(selectid)!.push({ detail, children: [], row: { selectid, order, from, detail }, references: describe(detail).references });
  }
  const referenced = new Set<number>();
  const attach = (steps: Step[], ancestors: Set<number>) => {
    for (const step of steps) {
      for (const ref of step.references ?? []) {
        // A recursive CTE refers to the query it is part of.
        if (ancestors.has(ref) || !groups.has(ref)) continue;
        referenced.add(ref);
        const children = groups.get(ref)!.map((child) => ({ ...child, children: [...child.children] }));
        step.children.push(...children);
        attach(children, new Set([...ancestors, ref]));
      }
    }
  };
  const main = groups.has(0) ? 0 : Math.min(...groups.keys());
  attach(groups.get(main)!, new Set([main]));
  // Anything the main query doesn't refer to follows it.
  const rest = [...groups.keys()].filter((id) => id !== main && !referenced.has(id));
  return [...groups.get(main)!, ...rest.flatMap((id) => groups.get(id)!)];
}

/** Whether 4-column tuples are the current (id, parent, notused, detail) format. */
function isTreeFormat(rows: Tuple[], header?: string[]): boolean {
  if (header?.length) return header[0] === "id" || header[1] === "parent";
  // Before 3.24 the first column numbers the queries, 0 being the main one.
  // Since, every row has a positive id, and its parent's id or 0. (The third
  // column, "notused", holds a cost estimate in recent versions.)
  if (rows.some((r) => r[0] === 0)) return false;
  const ids = new Set(rows.map((r) => r[0]));
  return ids.size === rows.length && rows.every((r) => r[1] === 0 || ids.has(r[1]));
}

/**
 * The steps, and the raw text to show for them when the shell's tree would
 * lose something: the old format's rows say which steps are one loop.
 */
interface Steps {
  steps: Step[];
  raw?: string;
}

function fromTuples(rows: Tuple[], header?: string[]): Steps {
  if (!rows.length) return { steps: [] };
  if (isTreeFormat(rows, header)) return { steps: fromTree(rows) };
  const raw = ["selectid|order|from|detail", ...rows.map((r) => r.join("|"))].join("\n");
  return { steps: fromSelectIds(rows), raw };
}

/** Reads a result set of EXPLAIN QUERY PLAN, in either format. */
export function stepsFromResult(result: QueryResultLike): Steps {
  const rows = rowsByName(result);
  const header = result.fields.map((f) => f.name.toLowerCase());
  if (header.includes("selectid")) {
    return fromTuples(rows.map((r) => [int(r["selectid"]) ?? 0, int(r["order"]) ?? 0, int(r["from"]) ?? 0, String(r["detail"] ?? "")]), header);
  }
  return fromTuples(rows.map((r) => [int(r["id"]) ?? 0, int(r["parent"]) ?? 0, int(r["notused"]) ?? 0, String(r["detail"] ?? "")]), header);
}

const GLYPH_LINE = /^((?:\|  |   )*)(?:\|--|`--)(.*)$/;
const ROW_LINE = /^\s*(-?\d+)\s*[|\t,]\s*(-?\d+)\s*[|\t,]\s*(-?\d+)\s*[|\t,]\s*(.*)$/;
const HEADER_LINE = /^\s*(id|selectid)\s*[|\t,]/i;

/** The lines of a plan, without the shell's header or blank lines. */
function planLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() && !/^\s*QUERY PLAN$/i.test(line));
}

/** Reads the shell's tree, rows copied as text (tab, comma or | separated), or bare details. */
function stepsFromText(text: string): Steps {
  const lines = planLines(text);
  const headerLine = lines.find((l) => HEADER_LINE.test(l));
  const body = lines.filter((l) => l !== headerLine);
  if (body.length && body.every((l) => ROW_LINE.test(l))) {
    const header = headerLine?.split(/[|\t,]/).map((h) => h.trim().toLowerCase());
    return fromTuples(
      body.map((l) => {
        const m = ROW_LINE.exec(l)!;
        return [Number(m[1]), Number(m[2]), Number(m[3]), m[4].trim().replace(/^"(.*)"$/, "$1")];
      }),
      header
    );
  }

  const top: Step[] = [];
  const stack: Step[] = [];
  for (const line of body) {
    const glyph = GLYPH_LINE.exec(line);
    const depth = glyph ? glyph[1].length / 3 : 0;
    const step: Step = { detail: (glyph ? glyph[2] : line).trim(), children: [], row: {} };
    step.row = { detail: step.detail };
    stack.length = Math.min(stack.length, depth);
    (stack.length ? stack[stack.length - 1].children : top).push(step);
    stack.push(step);
  }
  return { steps: top };
}

/** Reads a 2D range or a column from the results grid. */
function stepsFromGrid(input: unknown[]): Steps {
  const rows = input.map((r) => (Array.isArray(r) ? r : [r]));
  if (rows.every((r) => r.length >= 4 && int(r[0]) !== undefined && int(r[1]) !== undefined)) {
    return fromTuples(rows.map((r) => [int(r[0])!, int(r[1])!, int(r[2]) ?? 0, String(r[3])]));
  }
  return stepsFromText(rows.map((r) => String(r[r.length - 1] ?? "")).join("\n"));
}

/** The shell's tree text for the steps. */
export function renderSteps(steps: Step[]): string {
  const lines = ["QUERY PLAN"];
  const render = (list: Step[], prefix: string) => {
    list.forEach((step, i) => {
      const last = i === list.length - 1;
      lines.push(`${prefix}${last ? "`--" : "|--"}${step.detail}`);
      render(step.children, prefix + (last ? "   " : "|  "));
    });
  };
  render(steps, "");
  return lines.join("\n");
}

function toDraft(step: Step, subplans: Set<string>, role?: string): DraftNode {
  const info = describe(step.detail);
  // "SCAN s" reads the subquery or CTE called s, not a table.
  if (info.loop && info.target && (subplans.has(info.target) || /^\(subquery-\d+\)$/.test(info.target))) {
    info.kind = "subquery";
    info.operation = info.operation.startsWith("Search") ? "Search subquery" : "Scan subquery";
    info.fullScan = false;
  }

  // Tables read one after another in the same query are nested loops,
  // outermost first. Before 3.24, rows say which query (selectid) and loop
  // (order) they belong to: two rows of one loop are the branches of an OR.
  const loops = step.children.filter((child) => describe(child.detail).loop);
  const queryOf = (s: Step) => s.row["selectid"] ?? "";
  const roleOf = (child: Step) => {
    if (!loops.includes(child)) return undefined;
    const sameQuery = loops.filter((l) => queryOf(l) === queryOf(child));
    const orders = [...new Set(sameQuery.map((l) => (typeof l.row["order"] === "number" ? l.row["order"] : sameQuery.indexOf(l))))];
    if (orders.length < 2) return undefined;
    const index = orders.indexOf(typeof child.row["order"] === "number" ? child.row["order"] : sameQuery.indexOf(child));
    return index === 0 ? "Outer loop" : orders.length === 2 ? "Inner loop" : `Inner loop ${index}`;
  };

  return {
    operation: info.operation,
    label: step.detail,
    kind: info.kind,
    target: info.target,
    index: info.index,
    description: info.description,
    subplanName: info.subplanName,
    role,
    estimatedRows: info.estimatedRows,
    conditions: info.conditions,
    properties: [],
    children: step.children.map((child) => toDraft(child, subplans, roleOf(child))),
    raw: step.row,
  };
}

/**
 * SQLite lists no steps for statements that read no table, such as
 * INSERT ... VALUES. That is a plan too, with one node saying so.
 */
function emptyPlan(sourceFormat: string): ParsedPlan {
  const { root, nodes } = finalizeTree({
    operation: "No steps",
    label: "QUERY PLAN",
    kind: "other",
    description: "the statement reads no tables",
    conditions: [],
    properties: [],
    children: [],
    raw: {},
  });
  const plan: Plan = { engine: "sqlite", sourceFormat, analyzed: false, root, nodes, properties: [], insights: [] };
  return { plan: finishPlan(plan), raw: renderSteps([]), rawFormat: "text" };
}

function planFrom({ steps, raw }: Steps, sourceFormat: string): ParsedPlan {
  if (!steps.length) return emptyPlan(sourceFormat);
  const subplans = new Set<string>();
  const collect = (list: Step[]) =>
    list.forEach((step) => {
      const name = describe(step.detail).subplanName;
      if (name) subplans.add(name);
      if (/^(CO-ROUTINE|MATERIALIZE) /.test(step.detail)) subplans.add(step.detail.replace(/^\S+ /, ""));
      collect(step.children);
    });
  collect(steps);

  // The shell shows the steps under "QUERY PLAN"; one step needs no root above it.
  const top: Step = steps.length === 1 ? steps[0] : { detail: "QUERY PLAN", children: steps, row: {} };
  const draft = toDraft(top, subplans);
  if (steps.length > 1) {
    draft.operation = "Query plan";
    draft.label = "QUERY PLAN";
    draft.kind = "other";
  }
  const { root, nodes } = finalizeTree(draft);
  const plan: Plan = { engine: "sqlite", sourceFormat, analyzed: false, root, nodes, properties: [], insights: [] };
  sqliteInsights(plan);
  return { plan: finishPlan(plan), raw: raw ?? renderSteps(steps), rawFormat: "text" };
}

/** Parses query results, the shell's text, copied rows or a grid range. */
export function parseSqlitePlan(input: unknown): ParsedPlan {
  if (isResult(input)) return planFrom(stepsFromResult(input), "rows");
  if (isGridValue(input)) return planFrom(stepsFromGrid(input), "rows");
  if (Array.isArray(input) && input.every((r) => r && typeof r === "object" && "detail" in r)) {
    const rows = input as Record<string, unknown>[];
    return planFrom(stepsFromResult({ fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows }), "rows");
  }
  if (typeof input === "string") {
    // The shell's header alone: a plan without steps, as the Raw view saves it.
    if (/^\s*QUERY PLAN\s*$/i.test(input)) return emptyPlan("text");
    if (!looksLikeSqlitePlan(input)) throw new Error("This doesn't look like SQLite EXPLAIN QUERY PLAN output.");
    return planFrom(stepsFromText(input), "text");
  }
  throw new Error("This doesn't look like SQLite EXPLAIN QUERY PLAN output.");
}

function isResult(input: unknown): input is QueryResultLike {
  return !!input && typeof input === "object" && Array.isArray((input as QueryResultLike).fields) && Array.isArray((input as QueryResultLike).rows);
}

/** The detail of a line: after the shell's glyphs, or the last column of a copied row. */
function detailOf(line: string): string {
  const glyph = GLYPH_LINE.exec(line);
  if (glyph) return glyph[2].trim();
  const row = ROW_LINE.exec(line);
  return (row ? row[4] : line).trim().replace(/^"(.*)"$/, "$1");
}

/** Whether text reads like SQLite's plan details. */
export function looksLikeSqlitePlan(text: string): boolean {
  const lines = planLines(text).filter((l) => !HEADER_LINE.test(l));
  if (!lines.length) return false;
  const details = lines.map(detailOf);
  return DETAIL_START.test(details[0]) && details.filter((d) => DETAIL_START.test(d)).length >= details.length / 2;
}

export function canParseSqlitePlan(input: unknown): boolean {
  if (typeof input === "string") return looksLikeSqlitePlan(input);
  if (isGridValue(input)) {
    const rows = input.map((r) => (Array.isArray(r) ? r : [r]));
    return looksLikeSqlitePlan(rows.map((r) => String(r[r.length - 1] ?? "")).join("\n"));
  }
  return false;
}
