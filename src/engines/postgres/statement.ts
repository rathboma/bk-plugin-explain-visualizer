import type { ExplainRequest, StatementInfo } from "../types";
import { splitStatements, type Token } from "./lexer";

/** Statements that only read data, as long as they contain no DML. */
const READ_STATEMENTS = new Set(["SELECT", "VALUES", "TABLE", "WITH"]);
const DML_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "TRUNCATE"]);

/** EXPLAIN options that are plain booleans, by the name PostgreSQL uses. */
const BOOLEAN_EXPLAIN_OPTIONS = new Set([
  "ANALYZE",
  "ANALYSE",
  "VERBOSE",
  "COSTS",
  "SETTINGS",
  "GENERIC_PLAN",
  "BUFFERS",
  "WAL",
  "TIMING",
  "SUMMARY",
  "MEMORY",
]);

const word = (t: Token | undefined) => (t?.type === "word" ? t.text.toUpperCase() : undefined);

function emptyInfo(statement: string, error?: string): StatementInfo {
  return { statement, modifiesData: false, requestedOptions: {}, hasParameters: false, error };
}

/**
 * Reads an `EXPLAIN [ANALYZE] [VERBOSE]` or `EXPLAIN (option, ...)` prefix.
 * Returns the index of the first token after it.
 */
function readExplainPrefix(
  tokens: Token[],
  requested: StatementInfo["requestedOptions"]
): number {
  let i = 1;
  const setOption = (name: string, value: boolean) => {
    const key = name === "ANALYSE" ? "analyze" : name.toLowerCase();
    if (BOOLEAN_EXPLAIN_OPTIONS.has(name)) requested[key] = value;
  };

  if (tokens[i]?.text === "(") {
    i++;
    while (i < tokens.length && tokens[i].text !== ")") {
      const name = word(tokens[i]);
      i++;
      let value = true;
      const valueToken = tokens[i];
      if (valueToken && valueToken.text !== "," && valueToken.text !== ")") {
        const raw = valueToken.text.replace(/'/g, "").toUpperCase();
        value = !["FALSE", "OFF", "0", "NO"].includes(raw);
        i++;
      }
      if (name) setOption(name, value);
      if (tokens[i]?.text === ",") i++;
    }
    return i + 1;
  }

  while (["ANALYZE", "ANALYSE", "VERBOSE"].includes(word(tokens[i]) ?? "")) {
    setOption(word(tokens[i])!, true);
    i++;
  }
  return i;
}

function containsDml(tokens: Token[]): boolean {
  return tokens.some((token, i) => {
    const w = word(token);
    if (!w || !DML_WORDS.has(w)) return false;
    // SELECT ... FOR [NO KEY] UPDATE is a row lock, not a write.
    if (w === "UPDATE") {
      const prev = word(tokens[i - 1]);
      if (prev === "FOR" || prev === "KEY") return false;
    }
    return true;
  });
}

/** Classifies a statement for EXPLAIN. Never throws. */
export function inspectStatement(sql: string): StatementInfo {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return emptyInfo("", "No SQL statement to explain.");
  }
  if (statements.length > 1) {
    return emptyInfo(
      sql.trim(),
      `Found ${statements.length} statements. Only one statement can be explained at a time.`
    );
  }

  const [{ tokens }] = statements;
  const requestedOptions: StatementInfo["requestedOptions"] = {};
  let start = 0;
  if (word(tokens[0]) === "EXPLAIN") {
    start = readExplainPrefix(tokens, requestedOptions);
  }

  const body = tokens.slice(start);
  if (body.length === 0) {
    return { ...emptyInfo("", "No SQL statement to explain."), requestedOptions };
  }
  const statement = sql.slice(body[0].start, body[body.length - 1].end);
  const first = word(body[0]);
  const modifiesData = !first || !READ_STATEMENTS.has(first) || containsDml(body);
  const hasParameters = body.some((t) => t.type === "param");
  const named = body.find((t) => t.type === "param" && t.text.startsWith(":"));

  return {
    statement,
    modifiesData,
    requestedOptions,
    hasParameters,
    error: named
      ? `The statement uses a query parameter (${named.text}). Replace parameters with values to explain it.`
      : undefined,
  };
}

/** Option names in the order PostgreSQL documents them. */
const OPTION_SQL: [string, string][] = [
  ["verbose", "VERBOSE"],
  ["settings", "SETTINGS"],
  ["buffers", "BUFFERS"],
  ["wal", "WAL"],
];

export function buildExplainSql(request: ExplainRequest): string {
  const { statement, analyze, options, server } = request;
  // Without a known version, only use options every supported version has.
  const version = server?.version ?? 0;
  const parts: string[] = [];

  if (analyze) parts.push("ANALYZE");
  for (const [key, sqlName] of OPTION_SQL) {
    if (!options[key]) continue;
    // BUFFERS and WAL only report execution data, and SETTINGS needs PG 12.
    if ((key === "buffers" || key === "wal") && !analyze) continue;
    if (key === "settings" && version < 120000) continue;
    if (key === "wal" && version < 130000) continue;
    parts.push(sqlName);
  }
  // A generic plan lets statements with $1 placeholders be explained (PG 16+).
  if (!analyze && statement.hasParameters && version >= 160000) {
    parts.push("GENERIC_PLAN");
  }
  parts.push("FORMAT JSON");

  const explain = `EXPLAIN (${parts.join(", ")}) ${statement.statement}`;
  if (analyze && statement.modifiesData) {
    // Sent as one simple-protocol query, both statements share an implicit
    // transaction. The ROLLBACK discards everything EXPLAIN ANALYZE changed,
    // and if EXPLAIN fails the implicit transaction is aborted on its own, so
    // the pooled connection is never left inside an open transaction.
    return `${explain};\nROLLBACK;`;
  }
  return explain;
}
