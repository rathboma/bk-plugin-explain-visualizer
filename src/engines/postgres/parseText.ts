import type { PgNode } from "./nodeTypes";

/**
 * Parses PostgreSQL's default text EXPLAIN output (what psql prints) into the
 * same structure as EXPLAIN (FORMAT JSON), so both share one normalizer.
 *
 * Text output carries less information than JSON (no parent relationships,
 * some properties only as prose), so a few fields are inferred.
 */

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const COST = /\(cost=([\d.]+)\.\.([\d.]+) rows=([\d.]+) width=(\d+)\)/;
const ACTUAL = /\(actual(?: time=([\d.]+)\.\.([\d.]+))? rows=([\d.]+) loops=(\d+)\)/;
const NEVER = /\(never executed\)/;
const SUBPLAN = /^(InitPlan \d+.*|SubPlan \d+.*|CTE \S.*)$/;
const JOIN_TYPES = "Left|Right|Full|Semi|Anti|Right Anti|Right Semi";

const toValue = (text: string): string | number => (NUMBER.test(text) ? Number(text) : text);
const kb = (text: string) => Number(text.replace(/kB$/, ""));

/** Removes psql/GUI decorations: header, separator, row count, quotes. */
export function cleanPlanText(input: string): string[] {
  const lines = input.replace(/\t/g, "    ").split(/\r?\n/);
  const out: string[] = [];
  for (let line of lines) {
    // Quoted cells from CSV exports or GUI copies.
    const quoted = /^(\s*)"(.*)"\s*,?\s*$/.exec(line);
    if (quoted) line = quoted[1] + quoted[2].replace(/""/g, '"');
    // psql wraps multi-line cells with a trailing "+".
    line = line.replace(/\s+\+$/, "").replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^QUERY PLAN$/i.test(trimmed)) continue;
    if (/^-{3,}$/.test(trimmed)) continue;
    if (/^\(\d+ rows?\)$/.test(trimmed)) continue;
    out.push(line);
  }
  return out;
}

/** Whether a string looks like text EXPLAIN output. */
export function looksLikeTextPlan(input: string): boolean {
  const lines = cleanPlanText(input);
  if (!lines.length) return false;
  // MySQL's tree format starts with "-> "; PostgreSQL's root line has no arrow.
  if (/^\s*(?:EXPLAIN:\s*)?->/.test(lines[0])) return false;
  return lines.some((l) => COST.test(l) || ACTUAL.test(l) || /^\s*->\s/.test(l));
}

function parseNodeName(text: string): PgNode {
  const node: PgNode = {};
  let rest = text.trim();

  if (rest.startsWith("Parallel ")) {
    node["Parallel Aware"] = true;
    rest = rest.slice(9);
  }
  if (rest.startsWith("Async ")) {
    node["Async Capable"] = true;
    rest = rest.slice(6);
  }
  const partial = /^(Partial|Finalize) /.exec(rest);
  if (partial) {
    node["Partial Mode"] = partial[1];
    rest = rest.slice(partial[0].length);
  }

  let target: string | undefined;
  let index: string | undefined;
  const on = rest.indexOf(" on ");
  if (on !== -1) {
    target = rest.slice(on + 4).trim();
    rest = rest.slice(0, on);
  }
  const using = rest.indexOf(" using ");
  if (using !== -1) {
    index = rest.slice(using + 7).trim();
    rest = rest.slice(0, using);
  }
  let op = rest.trim();
  let match: RegExpExecArray | null;

  if ((match = new RegExp(`^(Hash|Merge) (?:(${JOIN_TYPES}) )?Join$`).exec(op))) {
    node["Node Type"] = `${match[1]} Join`;
    node["Join Type"] = match[2] ?? "Inner";
  } else if ((match = new RegExp(`^Nested Loop(?: (${JOIN_TYPES}) Join)?$`).exec(op))) {
    node["Node Type"] = "Nested Loop";
    node["Join Type"] = match[1] ?? "Inner";
  } else if ((match = /^(Hash|Group|Mixed)?Aggregate$/.exec(op))) {
    node["Node Type"] = "Aggregate";
    node["Strategy"] = { Hash: "Hashed", Group: "Sorted", Mixed: "Mixed" }[match[1] ?? ""] ?? "Plain";
  } else if ((match = /^(Hash)?SetOp (.+)$/.exec(op))) {
    node["Node Type"] = "SetOp";
    node["Strategy"] = match[1] ? "Hashed" : "Sorted";
    node["Command"] = match[2];
  } else if (/^(Insert|Update|Delete|Merge)$/.test(op)) {
    node["Node Type"] = "ModifyTable";
    node["Operation"] = op;
  } else if ((match = /^(Index (?:Only )?Scan) Backward$/.exec(op))) {
    node["Node Type"] = match[1];
    node["Scan Direction"] = "Backward";
  } else if ((match = /^Custom Scan \((.+)\)$/.exec(op))) {
    node["Node Type"] = "Custom Scan";
    node["Custom Plan Provider"] = match[1];
  } else {
    node["Node Type"] = op;
  }
  op = node["Node Type"] as string;

  if (index) node["Index Name"] = index;
  if (target) {
    if (op === "Bitmap Index Scan") {
      node["Index Name"] = target;
    } else {
      const [qualified, ...aliasParts] = splitIdentifier(target);
      const name = qualifiedParts(qualified).join(".");
      const alias = aliasParts.length ? unquote(aliasParts.join(" ")) : undefined;
      if (op === "CTE Scan" || op === "WorkTable Scan") node["CTE Name"] = name;
      else if (op === "Function Scan") node["Function Name"] = name;
      else if (op === "Subquery Scan" || op === "Values Scan") node["Alias"] = name;
      else if (op === "Named Tuplestore Scan") node["Tuplestore Name"] = name;
      else {
        const parts = qualifiedParts(qualified);
        node["Relation Name"] = parts.pop();
        if (parts.length) node["Schema"] = parts.join(".");
      }
      if (alias) node["Alias"] = alias;
      else if (node["Relation Name"] && !node["Alias"]) node["Alias"] = node["Relation Name"];
    }
  }
  return node;
}

function unquote(identifier: string): string {
  return /^".*"$/.test(identifier) ? identifier.slice(1, -1).replace(/""/g, '"') : identifier;
}

/** Splits `"my schema".orders` into ["my schema", "orders"]. */
function qualifiedParts(name: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of name) {
    if (ch === '"') quoted = !quoted;
    if (ch === "." && !quoted) {
      parts.push(unquote(current));
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(unquote(current));
  return parts;
}

/** Splits "public.orders o" into ["public.orders", "o"], respecting quotes. */
function splitIdentifier(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === " " && !quoted) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseBuffers(value: string, target: Record<string, unknown>, suffix: "Blocks" | "Time") {
  // "shared hit=5 read=10, local hit=1, temp read=1 written=2" or, for
  // pre-16 I/O timings, just "read=1.2 write=0.3".
  for (const segment of value.split(",")) {
    const words = segment.trim().split(/\s+/);
    let kind = "";
    if (words[0] && !words[0].includes("=")) kind = words.shift()!;
    for (const pair of words) {
      const [attr, raw] = pair.split("=");
      if (raw === undefined) continue;
      const Attr = attr.charAt(0).toUpperCase() + attr.slice(1);
      const Kind = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) + " " : "";
      if (suffix === "Blocks") target[`${Kind}${Attr} Blocks`] = Number(raw);
      else target[`${Kind}I/O ${Attr} Time`] = Number(raw);
    }
  }
}

function parseActual(value: string, target: Record<string, unknown>) {
  const m = /(?:time=([\d.]+)\.\.([\d.]+) )?rows=([\d.]+) loops=(\d+)/.exec(value);
  if (!m) return false;
  if (m[1] !== undefined) {
    target["Actual Startup Time"] = Number(m[1]);
    target["Actual Total Time"] = Number(m[2]);
  }
  target["Actual Rows"] = Number(m[3]);
  target["Actual Loops"] = Number(m[4]);
  return true;
}

/** Applies one "Key: value" line from a node (or worker, or summary block). */
function applyProperty(target: Record<string, unknown>, key: string, value: string): void {
  // Lines that pack several fields, separated by two spaces.
  const packed = ["Sort Method", "Buckets", "Batches", "Planned Partitions", "Hits", "Memory", "Storage"];
  if (packed.includes(key)) {
    const segments = `${key}: ${value}`.split(/\s{2,}/);
    const isHash = key === "Buckets";
    for (const segment of segments) {
      const colon = segment.indexOf(":");
      if (colon === -1) continue;
      const k = segment.slice(0, colon).trim();
      const v = segment.slice(colon + 1).trim();
      const originally = /^(\d+) \(originally (\d+)\)$/.exec(v);
      switch (k) {
        case "Sort Method":
          target["Sort Method"] = v;
          break;
        case "Memory":
        case "Disk":
          if (key === "Memory") {
            // Planning "Memory: used=12kB  allocated=16kB" (PostgreSQL 17)
            const used = /used=(\d+)kB/.exec(v);
            const allocated = /allocated=(\d+)kB/.exec(segments.join(" "));
            if (used) target["Memory Used"] = Number(used[1]);
            if (allocated) target["Memory Allocated"] = Number(allocated[1]);
          } else {
            target["Sort Space Used"] = kb(v);
            target["Sort Space Type"] = k;
          }
          break;
        case "Buckets":
          target["Hash Buckets"] = Number(originally ? originally[1] : v);
          if (originally) target["Original Hash Buckets"] = Number(originally[2]);
          break;
        case "Batches":
          if (isHash) {
            target["Hash Batches"] = Number(originally ? originally[1] : v);
            if (originally) target["Original Hash Batches"] = Number(originally[2]);
          } else {
            target["HashAgg Batches"] = Number(v);
          }
          break;
        case "Memory Usage":
          target["Peak Memory Usage"] = kb(v);
          break;
        case "Disk Usage":
        case "Maximum Storage":
          target[k] = kb(v);
          break;
        case "Planned Partitions":
          target["Planned Partitions"] = Number(v);
          break;
        case "Hits":
        case "Misses":
        case "Evictions":
        case "Overflows":
          target[`Cache ${k}`] = Number(v);
          break;
        default:
          target[k] = toValue(v);
      }
    }
    return;
  }

  switch (key) {
    case "Buffers":
      parseBuffers(value, target, "Blocks");
      return;
    case "I/O Timings":
      parseBuffers(value, target, "Time");
      return;
    case "WAL": {
      for (const [, k, v] of value.matchAll(/(records|fpi|bytes|buffers full)=(\d+)/g)) {
        const name = { records: "WAL Records", fpi: "WAL FPI", bytes: "WAL Bytes", "buffers full": "WAL Buffers Full" }[k]!;
        target[name] = Number(v);
      }
      return;
    }
    case "Heap Blocks": {
      const exact = /exact=(\d+)/.exec(value);
      const lossy = /lossy=(\d+)/.exec(value);
      if (exact) target["Exact Heap Blocks"] = Number(exact[1]);
      if (lossy) target["Lossy Heap Blocks"] = Number(lossy[1]);
      return;
    }
    case "Serialization": {
      const time = /time=([\d.]+) ms/.exec(value);
      const output = /output=(\d+)kB/.exec(value);
      const format = /format=(\w+)/.exec(value);
      if (time) target["Time"] = Number(time[1]);
      if (output) target["Output Volume"] = Number(output[1]);
      if (format) target["Format"] = format[1];
      return;
    }
  }

  const worker = /^Worker (\d+)$/.exec(key);
  if (worker) {
    const workers = (target["Workers"] ??= []) as Record<string, unknown>[];
    const number = Number(worker[1]);
    let entry = workers.find((w) => w["Worker Number"] === number);
    if (!entry) {
      entry = { "Worker Number": number };
      workers.push(entry);
    }
    if (!parseActual(value, entry)) {
      const colon = value.indexOf(":");
      if (colon !== -1) applyProperty(entry, value.slice(0, colon).trim(), value.slice(colon + 1).trim());
    }
    return;
  }

  target[key] = toValue(value);
}

const JOIN_NODES = new Set(["Nested Loop", "Hash Join", "Merge Join"]);
const MEMBER_NODES = new Set(["Append", "Merge Append", "BitmapAnd", "BitmapOr", "Recursive Union", "SetOp"]);

/** Text output has no "Parent Relationship"; infer it like JSON would show it. */
function inferRelationships(node: PgNode): void {
  const children = node.Plans ?? [];
  const type = node["Node Type"] as string;
  let position = 0;
  for (const child of children) {
    if (!child["Parent Relationship"]) {
      if (JOIN_NODES.has(type)) child["Parent Relationship"] = position === 0 ? "Outer" : "Inner";
      else if (MEMBER_NODES.has(type)) child["Parent Relationship"] = "Member";
      else if (type === "Subquery Scan") child["Parent Relationship"] = "Subquery";
      else child["Parent Relationship"] = "Outer";
      position++;
    }
    inferRelationships(child);
  }
}

interface Frame {
  node: PgNode;
  indent: number;
  /** A "Worker N:" line; lines indented below it describe that worker. */
  worker?: boolean;
}

/** Parses text EXPLAIN output into `[{ Plan, ...summary }]` JSON form. */
export function parseTextPlan(input: string): Record<string, unknown>[] {
  const lines = cleanPlanText(input);
  const top: Record<string, unknown> = {};
  const stack: Frame[] = [];
  let root: PgNode | undefined;
  let rootIndent = 0;
  let pendingSubplan: { name: string; indent: number } | undefined;
  let section: Record<string, unknown> | undefined;
  let treeDone = false;

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    // Summary lines after the tree, at the root's indentation.
    if (root && indent <= rootIndent) {
      treeDone = true;
      section = undefined;
      const trigger = /^Trigger (?:for constraint (.+?)|(.+?))(?: on (.+?))?: time=([\d.]+) calls=(\d+)$/.exec(content);
      if (trigger) {
        const triggers = (top["Triggers"] ??= []) as Record<string, unknown>[];
        const entry: Record<string, unknown> = { Time: Number(trigger[4]), Calls: Number(trigger[5]) };
        if (trigger[1]) entry["Constraint Name"] = trigger[1];
        if (trigger[2]) entry["Trigger Name"] = trigger[2];
        if (trigger[3]) entry["Relation"] = trigger[3];
        triggers.push(entry);
        continue;
      }
      const colon = content.indexOf(":");
      if (colon === -1) continue;
      const key = content.slice(0, colon).trim();
      const value = content.slice(colon + 1).trim();
      if (key === "Planning Time" || key === "Execution Time") {
        top[key] = Number.parseFloat(value);
      } else if (key === "Planning" || key === "JIT") {
        section = (top[key] = {}) as Record<string, unknown>;
      } else if (key === "Settings") {
        const settings: Record<string, string> = {};
        for (const [, name, v] of value.matchAll(/([\w.]+) = '((?:[^']|'')*)'/g)) {
          settings[name] = v.replace(/''/g, "'");
        }
        top["Settings"] = settings;
      } else if (key === "Serialization") {
        applyProperty((top["Serialization"] = {}) as Record<string, unknown>, key, value);
      } else {
        top[key] = toValue(value);
      }
      continue;
    }

    if (treeDone) {
      if (!section) continue;
      const colon = content.indexOf(":");
      if (colon === -1) continue;
      const key = content.slice(0, colon).trim();
      const value = content.slice(colon + 1).trim();
      if (section === top["JIT"]) {
        if (key === "Functions") section["Functions"] = Number(value);
        else if (key === "Options") {
          const options: Record<string, boolean> = {};
          for (const part of value.split(",")) {
            const [name, flag] = part.trim().split(/\s+/);
            if (name) options[name] = flag === "true";
          }
          section["Options"] = options;
        } else if (key === "Timing") {
          const timing: Record<string, number> = {};
          for (const [, name, ms] of value.matchAll(/(\w+) ([\d.]+) ms/g)) {
            if (!(name in timing)) timing[name] = Number(ms);
          }
          section["Timing"] = timing;
        }
      } else {
        applyProperty(section, key, value);
      }
      continue;
    }

    const arrow = /^->\s+(.*)$/.exec(content);
    const subplan = !arrow && root ? SUBPLAN.exec(content) : null;

    if (subplan) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      pendingSubplan = { name: subplan[1], indent };
      continue;
    }

    if (arrow || !root) {
      const text = arrow ? arrow[1] : content;
      const nameEnd = text.search(/\s+\((?:cost=|actual|never executed)/);
      const node = parseNodeName(nameEnd === -1 ? text : text.slice(0, nameEnd));
      const cost = COST.exec(text);
      if (cost) {
        node["Startup Cost"] = Number(cost[1]);
        node["Total Cost"] = Number(cost[2]);
        node["Plan Rows"] = Number(cost[3]);
        node["Plan Width"] = Number(cost[4]);
      }
      const actual = ACTUAL.exec(text);
      if (actual) {
        parseActual(actual[0], node);
      } else if (NEVER.test(text)) {
        node["Actual Startup Time"] = 0;
        node["Actual Total Time"] = 0;
        node["Actual Rows"] = 0;
        node["Actual Loops"] = 0;
      }

      if (!root) {
        root = node;
        rootIndent = indent;
        stack.push({ node, indent });
        continue;
      }

      while (stack.length && (stack[stack.length - 1].indent >= indent || stack[stack.length - 1].worker)) {
        stack.pop();
      }
      const parent = stack[stack.length - 1]?.node ?? root;
      if (pendingSubplan && pendingSubplan.indent < indent) {
        const name = pendingSubplan.name;
        node["Subplan Name"] = name;
        node["Parent Relationship"] = name.startsWith("SubPlan") ? "SubPlan" : "InitPlan";
        pendingSubplan = undefined;
      }
      (parent.Plans ??= []).push(node);
      stack.push({ node, indent });
      continue;
    }

    // A property line belongs to the closest node indented less than it.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const owner = stack[stack.length - 1].node;
    const colon = content.indexOf(":");
    if (colon === -1) continue;
    const key = content.slice(0, colon).trim();
    applyProperty(owner, key, content.slice(colon + 1).trim());
    // With VERBOSE, a worker's buffers and I/O follow on deeper lines.
    const worker = /^Worker (\d+)$/.exec(key);
    if (worker) {
      const workers = (owner["Workers"] ?? []) as PgNode[];
      const entry = workers.find((w) => w["Worker Number"] === Number(worker[1]));
      if (entry) stack.push({ node: entry, indent, worker: true });
    }
  }

  if (!root) throw new Error("No plan nodes found in the text.");
  inferRelationships(root);
  return [{ Plan: root, ...top }];
}
