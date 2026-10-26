/**
 * Turns MySQL iterators (tree text or JSON version 2) into the shared model.
 * MySQL describes each iterator in one line of text ("Index lookup on c
 * using PRIMARY (id=o.customer_id)"); the rules below split that into an
 * operation, its table, index and conditions.
 */
import type { Condition, DraftNode, NodeKind, Property } from "../../core/plan";
import type { IteratorNode } from "./tree";

interface Described {
  operation: string;
  kind: NodeKind;
  target?: string;
  index?: string;
  description?: string;
  subplanName?: string;
  conditions: Condition[];
}

/** A table alias or index name: `<temporary>`, `quoted name` or a plain word. */
const NAME = String.raw`(<[^>]*>|\x60(?:[^\x60]|\x60\x60)*\x60|[^\s,()]+)`;

/** Access methods that read a table, as "<method> on <alias> [using <index>]". */
const ACCESS_METHODS: [string, NodeKind][] = [
  ["Single-row covering index lookup", "index"],
  ["Single-row index lookup", "index"],
  ["Covering index lookup", "index"],
  ["Index lookup", "index"],
  ["Covering index range scan", "index"],
  ["Index range scan (Multi-Range Read)", "index"],
  ["Index range scan", "index"],
  ["Covering index skip scan for grouping", "index"],
  ["Covering index skip scan for deduplication", "index"],
  ["Covering index skip scan", "index"],
  ["Index skip scan", "index"],
  ["Group index skip scan", "index"],
  ["Covering index scan", "index"],
  ["Index scan", "index"],
  ["Full-text index search", "index"],
  ["Multi-range index lookup", "index"],
  ["Dynamic range scan", "scan"],
  ["Table scan", "scan"],
];
const ACCESS = new RegExp(
  String.raw`^(${ACCESS_METHODS.map(([m]) => m.replace(/[()]/g, "\\$&")).join("|")}) on ${NAME}(?: using ${NAME})?(.*)$`,
  "i"
);

/** Splits what follows "on t using idx": lookup keys, ranges, index condition, "(reverse)". */
function accessDetails(rest: string, described: Described): void {
  let text = rest;
  const flags: string[] = [];
  for (;;) {
    const flag = /\s*\((reverse|re-planned for each iteration)\)\s*$/i.exec(text);
    if (!flag) break;
    flags.unshift(flag[1]);
    text = text.slice(0, flag.index);
  }
  const indexCondition = /, with index condition: (.*)$/.exec(text);
  if (indexCondition) text = text.slice(0, indexCondition.index);
  const over = /^ over (.*)$/.exec(text);
  const lookup = /^\s*\((.*)\)\s*$/.exec(text);
  if (over) described.conditions.push({ label: "Ranges", expression: over[1] });
  else if (lookup) described.conditions.push({ label: "Lookup", expression: lookup[1] });
  else if (text.trim()) flags.unshift(text.trim().replace(/^,\s*/, ""));
  if (indexCondition) described.conditions.push({ label: "Index condition", expression: indexCondition[1] });
  if (flags.length) described.description = flags.join(", ");
}

/** "Label: rest" → an operation with the rest as a condition. */
function labelled(text: string, kind: NodeKind, conditionLabel: string): Described {
  const colon = text.indexOf(": ");
  const operation = colon === -1 ? text : text.slice(0, colon);
  const rest = colon === -1 ? "" : text.slice(colon + 2);
  return { operation, kind, conditions: rest ? [{ label: conditionLabel, expression: rest }] : [] };
}

/** Reads one iterator description. Unknown ones keep their text. */
export function describe(text: string): Described {
  const access = ACCESS.exec(text);
  if (access) {
    const method = ACCESS_METHODS.find(([m]) => m.toLowerCase() === access[1].toLowerCase())!;
    const described: Described = { operation: method[0], kind: method[1], target: access[2], index: access[3], conditions: [] };
    accessDetails(access[4], described);
    return described;
  }

  let m: RegExpExecArray | null;
  if ((m = /^Select #(\d+) \((.*)\)$/.exec(text))) {
    return {
      operation: "Subquery",
      kind: "subquery",
      subplanName: `Select #${m[1]}`,
      description: m[2].replace(/^subquery /, ""),
      conditions: [],
    };
  }
  if ((m = /^Filter: (.*)$/.exec(text))) return { operation: "Filter", kind: "filter", conditions: [{ label: "Filter", expression: m[1] }] };
  if ((m = /^Nested loop (.*)$/i.exec(text))) {
    return { operation: `Nested loop ${m[1]}`, kind: "join", conditions: [] };
  }
  if ((m = /^(.*\bhash (?:join|semijoin|antijoin)(?: \(FirstMatch\))?)(?: \((.*)\))?$/i.exec(text))) {
    // "Inner hash join (a = b), extra conditions: (c > d)"
    const conditions: Condition[] = [];
    const extra = m[2]?.split("), extra conditions: (") ?? [];
    if (extra[0]) conditions.push({ label: "Hash condition", expression: extra[0] });
    if (extra[1]) conditions.push({ label: "Extra conditions", expression: extra[1] });
    return { operation: m[1], kind: "join", conditions };
  }
  if (/^Batched key access/i.test(text)) return { operation: text, kind: "join", conditions: [] };
  if (/^Hash$/.test(text)) return { operation: "Hash", kind: "materialize", conditions: [] };
  if ((m = /^Constant row from (.*)$/.exec(text))) return { operation: "Constant row", kind: "other", target: m[1], conditions: [] };
  if ((m = /^Count rows in (.*)$/.exec(text))) return { operation: "Count rows", kind: "aggregate", target: m[1], conditions: [] };
  if ((m = /^(Insert into|Update|Delete from) ([^\s,]+)(.*)$/.exec(text))) {
    return {
      operation: m[1] === "Update" ? "Update" : m[1] === "Delete from" ? "Delete" : "Insert",
      kind: "modify",
      target: m[2],
      description: m[3].replace(/^[\s,]*\(?|\)?\s*$/g, "") || undefined,
      conditions: [],
    };
  }
  if ((m = /^(Limit|Limit\/Offset|Limit table size): (.*)$/.exec(text))) {
    return { operation: m[1] === "Limit table size" ? m[1] : "Limit", kind: "limit", description: m[2], conditions: [] };
  }
  if (/^Sort(?: row IDs| with duplicate removal)?: /.test(text)) {
    const described = labelled(text, "sort", "Sort key");
    const limit = /, limit input to (\d+) row\(s\) per chunk$/.exec(described.conditions[0]?.expression ?? "");
    if (limit) {
      described.conditions[0].expression = described.conditions[0].expression.slice(0, limit.index);
      described.description = `Top ${limit[1]} rows`;
    }
    return described;
  }
  if (/^(Group aggregate|Aggregate|Window (?:multi-pass )?aggregate|Group \(no aggregates\))/.test(text)) {
    return labelled(text, "aggregate", /^Window/.test(text) ? "Window" : "Aggregates");
  }
  if (/^(Remove duplicates|Remove duplicate|Temporary table with deduplication|Aggregate using temporary table)/.test(text)) {
    return labelled(text, "aggregate", "Key");
  }
  if ((m = /^Materialize (recursive )?CTE (\S+)(.*)$/.exec(text))) {
    return {
      operation: `Materialize ${m[1] ? "recursive " : ""}CTE`,
      kind: "materialize",
      subplanName: `CTE ${m[2]}`,
      description: m[3].trim() || undefined,
      conditions: [],
    };
  }
  if (/^(Union|Intersect|Except)\b.*materialize/i.test(text) || /^(Append|Repeat until convergence)/.test(text)) {
    return { operation: text, kind: "set", conditions: [] };
  }
  if (/^(Sort-deduplicate by row ID|Deduplicate rows sorted by row ID|Intersect rows sorted by row ID)/.test(text)) {
    return { operation: text, kind: "set", conditions: [] };
  }
  if (/^(Materialize|Temporary table|Buffer)/.test(text)) {
    const described = labelled(text, "materialize", "Detail");
    const paren = /^(Materialize[^(]*?)\s*\((.*)\)$/.exec(text);
    if (paren) return { operation: paren[1], kind: "materialize", description: paren[2], conditions: [] };
    return described;
  }
  if ((m = /^Zero (input )?rows \((.*?)\)(.*)$/.exec(text))) {
    return { operation: m[1] ? "Zero input rows" : "Zero rows", kind: "other", description: m[2] + m[3], conditions: [] };
  }
  if (/^(Rows fetched before execution|Stream results|Table value constructor)/.test(text)) {
    return { operation: text, kind: /^Table value/.test(text) ? "subquery" : "other", conditions: [] };
  }
  return labelled(text, "other", "Detail");
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Table, index and other details JSON version 2 has beyond the text. */
function v2Properties(fields: Record<string, unknown> | undefined): Property[] {
  if (!fields) return [];
  const props: Property[] = [];
  const table = str(fields["table_name"]);
  if (table) {
    const schema = str(fields["schema_name"]);
    props.push({ group: "Node", label: "Table", value: schema ? `${schema}.${table}` : table, format: "code" });
  }
  const add = (key: string, label: string, group = "Node") => {
    const value = fields[key];
    if (value === undefined || value === null || value === "") return;
    props.push({
      group,
      label,
      value: Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : (value as Property["value"]),
      format: Array.isArray(value) || key.endsWith("_name") ? "code" : undefined,
    });
  };
  add("index_name", "Index");
  add("covering", "Covering index");
  add("access_type", "Access type");
  add("index_access_type", "Index access");
  add("join_algorithm", "Join algorithm");
  add("join_type", "Join type");
  add("zero_rows_cause", "Reason");
  add("used_columns", "Used columns");
  add("functions", "Functions");
  add("subquery_location", "Subquery location");
  add("dependent", "Dependent");
  add("cacheable", "Cacheable");
  add("estimated_first_row_cost", "First row cost", "Estimates");
  return props.filter((p) => p.value !== false);
}

/** Converts iterators into draft nodes. `roles` names the children of joins. */
export function iteratorDraft(node: IteratorNode, role?: string): DraftNode {
  const described = describe(node.operation);
  const isJoin = described.kind === "join" && node.children.length === 2;
  const hashJoin = /hash/i.test(described.operation);
  const roles = isJoin ? (hashJoin ? ["Probe", "Build"] : ["Outer", "Inner"]) : [];

  return {
    operation: described.operation,
    label: node.operation,
    kind: described.kind,
    target: described.target ?? str(node.fields?.["alias"]),
    index: described.index ?? str(node.fields?.["index_name"]),
    description: described.description,
    subplanName: described.subplanName,
    role,
    startupCost: node.startupCost,
    totalCost: node.totalCost,
    estimatedRows: node.estimatedRows,
    actualStartupTime: node.firstRowMs,
    actualTotalTime: node.lastRowMs,
    actualRows: node.actualRows,
    loops: node.loops,
    neverExecuted: node.neverExecuted,
    conditions: described.conditions,
    properties: v2Properties(node.fields),
    children: node.children.map((child, i) => iteratorDraft(child, roles[i])),
    raw: node.fields ?? { iterator: node.operation },
  };
}
