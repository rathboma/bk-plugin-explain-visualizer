/**
 * Reads the `detail` text of SQLite's EXPLAIN QUERY PLAN rows. The wording
 * changed over time: before 3.36, "SCAN TABLE orders AS o"; since, "SCAN o".
 * Before 3.24, subqueries were "EXECUTE SCALAR SUBQUERY 1" and unions
 * "COMPOUND SUBQUERIES 1 AND 2".
 */
import type { Condition, NodeKind } from "../../core/plan";

export interface DetailInfo {
  operation: string;
  kind: NodeKind;
  target?: string;
  index?: string;
  description?: string;
  subplanName?: string;
  conditions: Condition[];
  /** Very old SQLite printed "(~N rows)". */
  estimatedRows?: number;
  /** The step reads a table (SCAN or SEARCH): one loop of a join. */
  loop?: boolean;
  /** A full read of a table: SCAN without an index, or SEARCH without one. */
  fullScan?: boolean;
  /** Old-format references to other subqueries: "SCAN SUBQUERY 1", "COMPOUND SUBQUERIES 1 AND 2". */
  references?: number[];
}

/** First words SQLite uses in plan details, for recognising pasted plans. */
export const DETAIL_START =
  /^(SCAN|SEARCH|USE TEMP B-TREE|CO-ROUTINE|MATERIALIZE|COMPOUND|LEFT-MOST SUBQUERY|UNION|EXCEPT|INTERSECT|MERGE|LEFT|RIGHT|MULTI-INDEX OR|INDEX \d|CORRELATED|SCALAR SUBQUERY|LIST SUBQUERY|EXECUTE|BLOOM FILTER|SETUP|RECURSIVE STEP|RIGHT-JOIN|USING)\b/;

/** "TABLE orders AS o" or "o", with what follows. */
const TABLE = String.raw`(?:TABLE )?(\S+)(?: AS (\S+))?`;

/** "orders o" (old wording, table and alias) or "o". */
const targetName = (table: string, alias?: string) => (alias && alias !== table ? `${table} ${alias}` : table);

function constraint(text: string | undefined): Condition[] {
  return text ? [{ label: "Constraint", expression: text }] : [];
}

/** SEARCH and SCAN details: what is read, and how. */
function readStep(verb: "SCAN" | "SEARCH", rest: string): DetailInfo {
  const m = new RegExp(String.raw`^${TABLE}(?: (.*))?$`).exec(rest)!;
  const table = m[1];
  const alias = m[2];
  let how = m[3] ?? "";
  const info: DetailInfo = { operation: "", kind: "scan", target: targetName(table, alias), conditions: [], loop: true };

  const estimate = /\s*\(~(\d+) rows?\)$/.exec(how);
  if (estimate) {
    info.estimatedRows = Number(estimate[1]);
    how = how.slice(0, estimate.index);
  }
  const cond = /\s*\((.*)\)$/.exec(how);
  const using = how.replace(/\s*\(.*\)$/, "");

  let m2: RegExpExecArray | null;
  if ((m2 = /^USING (COVERING )?INDEX (\S+)/.exec(using))) {
    info.kind = "index";
    info.index = m2[2];
    info.operation = `${m2[1] ? "Covering index" : "Index"} ${verb === "SCAN" ? "scan" : "search"}`;
  } else if ((m2 = /^USING AUTOMATIC (PARTIAL )?COVERING INDEX/.exec(using))) {
    info.kind = "index";
    info.operation = "Automatic index search";
    info.description = m2[1] ? "temporary partial index" : "temporary index";
  } else if (/^USING INTEGER PRIMARY KEY/.test(using)) {
    info.kind = "index";
    info.operation = "Rowid search";
  } else if (/^USING PRIMARY KEY/.test(using)) {
    info.kind = "index";
    info.operation = "Primary key search";
  } else if ((m2 = /^VIRTUAL TABLE INDEX (.*)$/.exec(using))) {
    info.operation = "Virtual table scan";
    info.description = `index ${m2[1]}`;
  } else {
    // SEARCH without an index happens for min()/max() over a table with no
    // usable index: every row is still read.
    info.operation = verb === "SCAN" ? "Scan" : "Search";
    info.fullScan = true;
    if (verb === "SEARCH") info.description = "no index";
  }
  info.conditions = constraint(cond?.[1]);
  return info;
}

export function describe(detail: string): DetailInfo {
  const text = detail.trim();
  let m: RegExpExecArray | null;

  // Old wording for subqueries and unions, referring to subqueries by number.
  if ((m = /^SCAN SUBQUERY (\d+)(?: AS (\S+))?/.exec(text))) {
    return { operation: "Scan subquery", kind: "subquery", target: m[2], subplanName: `Subquery ${m[1]}`, conditions: [], references: [Number(m[1])], loop: true };
  }
  if ((m = /^EXECUTE (CORRELATED )?(SCALAR|LIST) SUBQUERY (\d+)/.exec(text))) {
    return {
      operation: `${m[1] ? "Correlated " : ""}${m[2].toLowerCase()} subquery`.replace(/^./, (c) => c.toUpperCase()),
      kind: "subquery",
      subplanName: `Subquery ${m[3]}`,
      conditions: [],
      references: [Number(m[3])],
    };
  }
  if ((m = /^COMPOUND SUBQUERIES (\d+) AND (\d+)(?: USING TEMP B-TREE)? \((.*)\)$/.exec(text))) {
    return { operation: m[3].charAt(0) + m[3].slice(1).toLowerCase(), kind: "set", conditions: [], references: [Number(m[1]), Number(m[2])] };
  }

  if (text === "SCAN CONSTANT ROW" || /^SCAN \d+ CONSTANT ROWS?$/.test(text)) {
    return { operation: "Constant row", kind: "other", conditions: [] };
  }
  if ((m = /^(SCAN|SEARCH) (.*)$/.exec(text))) return readStep(m[1] as "SCAN" | "SEARCH", m[2]);

  if ((m = /^USE TEMP B-TREE FOR (.*)$/.exec(text))) {
    const what = m[1];
    if (/ORDER BY/.test(what)) {
      return { operation: "Sort", kind: "sort", description: `temporary B-tree${/RIGHT PART|LAST/.test(what) ? `, ${what.replace(/ OF ORDER BY$/, "").toLowerCase()}` : ""}`, conditions: [] };
    }
    if (/GROUP BY/.test(what)) return { operation: "Group", kind: "aggregate", description: "temporary B-tree", conditions: [] };
    if (/DISTINCT/.test(what)) return { operation: "Distinct", kind: "aggregate", description: `temporary B-tree${what === "DISTINCT" ? "" : ` for ${what}`}`, conditions: [] };
    return { operation: "Temporary B-tree", kind: "materialize", description: what.toLowerCase(), conditions: [] };
  }
  if ((m = /^(CORRELATED )?(SCALAR|LIST) SUBQUERY(?: (\d+))?$/.exec(text))) {
    return {
      operation: `${m[1] ? "Correlated " : ""}${m[2].toLowerCase()} subquery`.replace(/^./, (c) => c.toUpperCase()),
      kind: "subquery",
      subplanName: m[3] ? `Subquery ${m[3]}` : undefined,
      conditions: [],
    };
  }
  if ((m = /^(CO-ROUTINE|MATERIALIZE) (.*)$/.exec(text))) {
    const name = m[2].replace(/^\((subquery-\d+)\)$/, "$1");
    return {
      operation: m[1] === "CO-ROUTINE" ? "Co-routine" : "Materialize",
      kind: m[1] === "CO-ROUTINE" ? "subquery" : "materialize",
      subplanName: /^\d+$/.test(name) ? `Subquery ${name}` : name,
      conditions: [],
    };
  }
  if ((m = /^BLOOM FILTER ON (\S+)(?: \((.*)\))?$/.exec(text))) {
    return { operation: "Bloom filter", kind: "filter", target: m[1], conditions: constraint(m[2]) };
  }
  if ((m = /^RIGHT-JOIN (\S+)$/.exec(text))) return { operation: "Right join", kind: "join", target: m[1], conditions: [] };
  if (text === "MULTI-INDEX OR") return { operation: "Multi-index OR", kind: "index", conditions: [] };
  if ((m = /^INDEX (\d+)$/.exec(text))) return { operation: `Index ${m[1]}`, kind: "index", description: "branch of the OR", conditions: [] };
  if (text === "COMPOUND QUERY") return { operation: "Compound query", kind: "set", conditions: [] };
  if (text === "LEFT-MOST SUBQUERY") return { operation: "Left-most subquery", kind: "set", conditions: [] };
  if ((m = /^(UNION ALL|UNION|EXCEPT|INTERSECT)(?: USING TEMP B-TREE)?$/.exec(text))) {
    return { operation: m[1].charAt(0) + m[1].slice(1).toLowerCase(), kind: "set", description: /TEMP B-TREE/.test(text) ? "temporary B-tree" : undefined, conditions: [] };
  }
  if ((m = /^MERGE \((.*)\)$/.exec(text))) return { operation: `Merge ${m[1].toLowerCase()}`, kind: "set", conditions: [] };
  if (text === "LEFT" || text === "RIGHT") return { operation: text === "LEFT" ? "Left" : "Right", kind: "set", conditions: [] };
  if (text === "SETUP") return { operation: "Setup", kind: "set", description: "first rows of the recursive CTE", conditions: [] };
  if (text === "RECURSIVE STEP") return { operation: "Recursive step", kind: "set", conditions: [] };
  if ((m = /^USING (.*) FOR IN-OPERATOR$/.exec(text))) {
    return { operation: "IN lookup", kind: "index", description: m[1].toLowerCase(), conditions: [] };
  }
  return { operation: text, kind: "other", conditions: [] };
}
