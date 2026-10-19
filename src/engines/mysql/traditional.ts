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

/**
 * Which server wrote a table, from what only one of them prints: MySQL 5.7+
 * always has a partitions column, MariaDB's ANALYZE has r_rows, and their join
 * buffers read "(Block Nested Loop)" or "(hash join)" against "(flat, BNL join)".
 */
export function traditionalFlavor(rows: Row[]): "mysql" | "mariadb" | undefined {
  const extras = rows.map((r) => text(r["extra"]) ?? "").join("; ");
  if (rows.some((r) => "r_rows" in r || "r_filtered" in r) || /\b(?:BNLH?|BKAH?) join\b|\(flat,|\(incremental,/.test(extras)) {
    return "mariadb";
  }
  if (rows.some((r) => "partitions" in r) || /Block Nested Loop|hash join|Batched Key Access/.test(extras)) return "mysql";
  return undefined;
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

/**
 * Rebuilds `{"query_block": ...}` from the rows.
 *
 * Rows are grouped by `id` into query blocks. A UNION's blocks are named by
 * its result row (`<union2,3>`; MySQL 8 gives that row an id of its own,
 * older servers NULL). UNION ALL has no result row on MySQL 8, so a block
 * marked UNION joins the closest block before it that isn't one. A union is
 * placed wherever its first block would be: the top of the query, a derived
 * table or a subquery.
 */
export function traditionalToQueryBlock(rows: Row[]): Obj {
  const selectTypeOf = (row: Row | undefined) => (text(row?.["select_type"]) ?? "").toUpperCase();
  const blocks = new Map<number, Row[]>();
  const resultRows: Row[] = [];
  for (const row of rows) {
    const id = number(row["id"]);
    if (selectTypeOf(row) === "UNION RESULT" || id === undefined) {
      resultRows.push(row);
      continue;
    }
    if (!blocks.has(id)) blocks.set(id, []);
    blocks.get(id)!.push(row);
  }
  const ids = [...blocks.keys()].sort((a, b) => a - b);
  const selectType = (id: number) => selectTypeOf(blocks.get(id)?.[0]);
  const isUnionMember = (id: number) => /UNION/.test(selectType(id));

  // Unions by their first block.
  const unions = new Map<number, { members: number[]; row?: Row }>();
  const grouped = new Set<number>();
  for (const row of resultRows) {
    const members = (/^<union([\d,]+)>$/.exec(text(row["table"]) ?? "")?.[1] ?? "")
      .split(",")
      .map(Number)
      .filter((id) => blocks.has(id));
    if (!members.length) continue;
    unions.set(members[0], { members, row });
    members.forEach((id) => grouped.add(id));
  }
  for (const id of ids) {
    if (grouped.has(id) || !isUnionMember(id)) continue;
    const head = ids.filter((other) => other < id && !isUnionMember(other)).at(-1);
    if (head === undefined) continue;
    if (!unions.has(head)) unions.set(head, { members: [head] });
    unions.get(head)!.members.push(id);
    grouped.add(head).add(id);
  }

  const used = new Set<number>();

  const block = (id: number): Obj => {
    used.add(id);
    const blockRows = blocks.get(id) ?? [];
    const tables = blockRows.map((row) => {
      const table = tableObject(row);
      const ref = /^<(derived|subquery)(\d+)>$/.exec(String(table["table_name"] ?? ""));
      if (ref && blocks.has(Number(ref[2])) && !used.has(Number(ref[2]))) {
        table["materialized_from_subquery"] = { query_block: unit(Number(ref[2])) };
      }
      return { table };
    });
    let content: Obj = tables.length === 1 ? tables[0] : { nested_loop: tables };
    const extras = blockRows.map((r) => text(r["extra"]) ?? "").join("; ");
    if (/Using temporary/i.test(extras)) content = { temporary_table: content };
    if (/Using filesort/i.test(extras)) content = { filesort: content };
    return {
      select_id: id,
      ...(isUnionMember(id) ? { operation: "UNION" } : {}),
      ...content,
    };
  };

  /** A subquery's flags, from its select_type. */
  const entry = (id: number, queryBlock: Obj): Obj => ({
    dependent: /DEPENDENT/.test(selectType(id)) || undefined,
    cacheable: /UNCACHEABLE/.test(selectType(id)) ? false : undefined,
    query_block: queryBlock,
  });

  /** The block that starts at `id`, or the union it begins. */
  const unit = (id: number): Obj => {
    const union = unions.get(id);
    if (!union) return block(id);
    union.members.forEach((member) => used.add(member));
    return {
      union_result: {
        table_name: text(union.row?.["table"]),
        access_type: text(union.row?.["type"]),
        query_specifications: union.members.map((member) => entry(member, block(member))),
      },
    };
  };

  const main = unit(ids[0]);
  // Subqueries nothing else refers to hang off the main query.
  const subqueries: Obj[] = [];
  for (const id of ids) if (!used.has(id)) subqueries.push(entry(id, unit(id)));
  if (subqueries.length) main["subqueries"] = subqueries;
  return { query_block: main };
}
