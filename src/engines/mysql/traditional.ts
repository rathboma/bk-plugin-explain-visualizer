/**
 * MySQL's and MariaDB's classic, tabular EXPLAIN: one row per table read,
 * in join order, with the query block (`id`) each belongs to. It is what most
 * tools show, and the only format MySQL 9 has for single-table UPDATE and
 * DELETE.
 *
 *   id  select_type  table  type    possible_keys  key      rows    filtered  Extra
 *   1   SIMPLE       o      ALL     ...            NULL     199800  10.00     Using where; Using temporary
 *   1   SIMPLE       c      eq_ref  PRIMARY        PRIMARY  1       100.00
 *
 * The rows are rebuilt into query-block JSON, so they become the same nodes
 * as EXPLAIN FORMAT=JSON: joins in order, derived tables and subqueries
 * under what reads them.
 */
import type { QueryResultLike } from "../types";
import { rowsByName } from "../shared/results";

type Row = Record<string, unknown>;
type Obj = Record<string, unknown>;

const COLUMNS = ["id", "select_type", "table", "partitions", "type", "possible_keys", "key", "key_len", "ref", "rows", "r_rows", "filtered", "r_filtered", "extra"];
const SELECT_TYPES =
  /^(SIMPLE|PRIMARY|UNION|DEPENDENT UNION|UNION RESULT|SUBQUERY|DEPENDENT SUBQUERY|DERIVED|DEPENDENT DERIVED|LATERAL DERIVED|MATERIALIZED|UNCACHEABLE SUBQUERY|UNCACHEABLE UNION|INSERT|UPDATE|DELETE|REPLACE)$/i;
const ACCESS_TYPES = /^(ALL|index|range|ref|eq_ref|ref_or_null|const|system|fulltext|index_merge|unique_subquery|index_subquery|hash_\w+|NULL)$/i;

const isNull = (v: unknown) => v === null || v === undefined || v === "" || v === "NULL";
const text = (v: unknown) => (isNull(v) ? undefined : String(v).trim());
const number = (v: unknown) => {
  const n = typeof v === "bigint" ? Number(v) : Number(text(v));
  return text(v) !== undefined && Number.isFinite(n) ? n : undefined;
};
const list = (v: unknown) => text(v)?.split(",").map((s) => s.trim()).filter(Boolean);

/** Whether rows, keyed by lower-cased column name, are a tabular EXPLAIN. */
export function isTraditional(rows: Row[]): boolean {
  return rows.length > 0 && rows.every((r) => "select_type" in r && "table" in r && "type" in r);
}

export function rowsFromResult(result: QueryResultLike): Row[] {
  return rowsByName(result);
}

/** The table as tab-separated text with a header: what the Raw view shows, and reads back. */
export function renderTraditional(rows: Row[]): string {
  const columns = COLUMNS.filter((c) => rows.some((r) => c in r));
  const cell = (v: unknown) => (isNull(v) ? "NULL" : String(v));
  return [columns.join("\t"), ...rows.map((r) => columns.map((c) => cell(r[c])).join("\t"))].join("\n");
}

/**
 * Reads a tabular EXPLAIN pasted as text: tab-separated with a header (a
 * grid copy, or `mysql -e`), the mysql client's boxed table, or its vertical
 * `\G` format.
 */
export function parseTraditionalText(input: string): Row[] | undefined {
  const lines = input.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return undefined;

  // Vertical: "*** 1. row ***" then "  select_type: SIMPLE" lines.
  if (/^\*+ \d+\. row \*+$/.test(lines[0].trim())) {
    const rows: Row[] = [];
    for (const line of lines) {
      if (/^\*+ \d+\. row \*+$/.test(line.trim())) {
        rows.push({});
        continue;
      }
      const m = /^\s*([\w ]+?):\s?(.*)$/.exec(line);
      if (m && rows.length) rows[rows.length - 1][m[1].toLowerCase()] = m[2].trim();
    }
    return isTraditional(rows) ? rows : undefined;
  }

  // Boxed: "| id | select_type | ..." between "+----+" lines.
  const boxed = lines.filter((l) => !/^\+[-+]+\+$/.test(l.trim()));
  const split = boxed.every((l) => l.trim().startsWith("|"))
    ? boxed.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
    : lines.map((l) => l.split("\t").map((c) => c.trim()));
  const [header, ...body] = split;
  const names = header.map((h) => h.toLowerCase());
  if (!names.includes("select_type") || !names.includes("table")) return undefined;
  const rows = body.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i]])));
  return isTraditional(rows) ? rows : undefined;
}

/**
 * Reads a range copied from a results grid, which has no header: columns are
 * recognised by their values (select_type, then type a column or two later).
 */
export function rowsFromGrid(range: unknown[][]): Row[] | undefined {
  if (!range.length || !range.every((r) => Array.isArray(r) && r.length >= 10)) return undefined;
  if (!range.every((r) => SELECT_TYPES.test(String(r[1])))) return undefined;
  const base = ["id", "select_type", "table"];
  const keys = ["possible_keys", "key", "key_len", "ref", "rows"];
  let columns: string[];
  switch (range[0].length) {
    case 12: // MySQL 5.7+
      columns = [...base, "partitions", "type", ...keys, "filtered", "extra"];
      break;
    case 13: // MariaDB's ANALYZE
      columns = [...base, "type", ...keys, "r_rows", "filtered", "r_filtered", "extra"];
      break;
    case 11: {
      // EXPLAIN PARTITIONS or EXPLAIN EXTENDED (filtered): the type column says which.
      const partitions = !range.every((r) => ACCESS_TYPES.test(String(r[3] ?? "NULL")));
      columns = partitions ? [...base, "partitions", "type", ...keys, "extra"] : [...base, "type", ...keys, "filtered", "extra"];
      break;
    }
    default:
      columns = [...base, "type", ...keys, "extra"];
  }
  if (!range.every((r) => ACCESS_TYPES.test(String(r[columns.indexOf("type")] ?? "NULL")))) return undefined;
  return range.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/** "Using join buffer (hash join)" → what the JSON calls using_join_buffer or join_type. */
function joinBuffer(extra: string): string | undefined {
  const m = /Using join buffer \(([^)]*)\)/i.exec(extra);
  if (!m) return undefined;
  if (/hash|BNLH|BKAH/i.test(m[1])) return "hash join";
  if (/BKA|Batched Key Access/i.test(m[1])) return "Batched Key Access";
  return "Block Nested Loop";
}

function tableObject(row: Row): Obj {
  const extra = text(row["extra"]) ?? "";
  const selectType = (text(row["select_type"]) ?? "").toUpperCase();
  const table: Obj = {
    table_name: text(row["table"]),
    partitions: text(row["partitions"]),
    access_type: text(row["type"]),
    possible_keys: list(row["possible_keys"]),
    key: text(row["key"]),
    key_length: text(row["key_len"]),
    ref: list(row["ref"]),
    rows_examined_per_scan: number(row["rows"]),
    filtered: number(row["filtered"]),
    r_rows: number(row["r_rows"]),
    r_filtered: number(row["r_filtered"]),
    using_index: /Using index(?! condition| for)/i.test(extra) || undefined,
    using_join_buffer: joinBuffer(extra),
    extra: extra || undefined,
  };
  if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(selectType)) table[selectType === "REPLACE" ? "insert" : selectType.toLowerCase()] = true;
  // "Impossible WHERE", "No tables used"...: the row has no table.
  if (!table.table_name && extra) table["message"] = extra;
  return Object.fromEntries(Object.entries(table).filter(([, v]) => v !== undefined));
}

/** Rebuilds `{"query_block": ...}` from the rows. */
export function traditionalToQueryBlock(rows: Row[]): Obj {
  const blocks = new Map<number, Row[]>();
  const unions: Row[] = [];
  for (const row of rows) {
    const id = number(row["id"]);
    if (id === undefined) {
      unions.push(row);
      continue;
    }
    if (!blocks.has(id)) blocks.set(id, []);
    blocks.get(id)!.push(row);
  }
  const used = new Set<number>();

  const block = (id: number): Obj => {
    used.add(id);
    const blockRows = blocks.get(id) ?? [];
    const tables = blockRows.map((row) => {
      const table = tableObject(row);
      const ref = /^<(derived|subquery)(\d+)>$/.exec(String(table["table_name"] ?? ""));
      if (ref && blocks.has(Number(ref[2])) && !used.has(Number(ref[2]))) {
        table["materialized_from_subquery"] = { query_block: block(Number(ref[2])) };
      }
      return { table };
    });
    let content: Obj = tables.length === 1 ? tables[0] : { nested_loop: tables };
    const extras = blockRows.map((r) => text(r["extra"]) ?? "").join("; ");
    if (/Using temporary/i.test(extras)) content = { temporary_table: content };
    if (/Using filesort/i.test(extras)) content = { filesort: content };
    const selectType = (text(blockRows[0]?.["select_type"]) ?? "").toUpperCase();
    return {
      select_id: id,
      ...(/UNION/.test(selectType) && selectType !== "UNION RESULT" ? { operation: "UNION" } : {}),
      ...content,
    };
  };

  const subqueryEntry = (id: number) => {
    const selectType = (text(blocks.get(id)?.[0]?.["select_type"]) ?? "").toUpperCase();
    return {
      dependent: /DEPENDENT/.test(selectType) || undefined,
      cacheable: /UNCACHEABLE/.test(selectType) ? false : undefined,
      query_block: block(id),
    };
  };

  // A UNION's result row names the blocks it combines: <union1,2>.
  const unionOf = (row: Row): Obj => {
    const ids = (/^<union([\d,]+)>$/.exec(text(row["table"]) ?? "")?.[1] ?? "").split(",").map(Number).filter((id) => blocks.has(id));
    return {
      union_result: {
        table_name: text(row["table"]),
        access_type: text(row["type"]),
        query_specifications: ids.map(subqueryEntry),
      },
    };
  };

  const firstId = Math.min(...blocks.keys());
  const selectType = (id: number) => (text(blocks.get(id)?.[0]?.["select_type"]) ?? "").toUpperCase();
  // UNION ALL has no result row in MySQL 8: its blocks are marked UNION.
  const unionAll = [...blocks.keys()].filter((id) => id !== firstId && /UNION/.test(selectType(id)));
  let main: Obj;
  if (unions.length) main = unionOf(unions[unions.length - 1]);
  else if (unionAll.length) main = { union_result: { query_specifications: [firstId, ...unionAll].map(subqueryEntry) } };
  else main = block(firstId);

  // Subqueries nothing else refers to hang off the main query.
  const subqueries: Obj[] = [];
  for (const id of blocks.keys()) if (!used.has(id)) subqueries.push(subqueryEntry(id));
  if (subqueries.length) main["subqueries"] = subqueries;
  return { query_block: main };
}
