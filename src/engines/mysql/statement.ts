import type { StatementInfo } from "../types";
import { splitStatements, type LexerDialect, type Token } from "../shared/lexer";
import { ambiguity, emptyStatement, firstKeyword, onlyStatement, parameterError, sourceOf, word } from "../shared/statement";
import type { MysqlServerInfo } from "./server";

/**
 * MySQL's and MariaDB's scanner rules (sql_lex.cc): `#` and `-- ` comments
 * that end only at a line feed, `--` that needs a space or control character
 * after it, backslash escapes, and `/*! ... *\/` comments whose contents the
 * server runs.
 */
export function mysqlDialect(server?: MysqlServerInfo): LexerDialect {
  const backslash = !server?.noBackslashEscapes;
  return {
    dashComments: "followed-by-space",
    lineCommentEnd: "lf",
    hashComments: true,
    executableComments: true,
    quotes: [
      { open: "'", type: "string", backslash },
      server?.ansiQuotes ? { open: '"', type: "identifier" } : { open: '"', type: "string", backslash },
      { open: "`", type: "identifier" },
    ],
    // `?` placeholders, and :name parameters some clients add. @name is a
    // user variable, which the server knows.
    params: { question: true, colonName: true },
  };
}

/** Statements that only read, as long as they contain none of WRITE_WORDS. */
const READ_STATEMENTS = new Set(["SELECT", "TABLE", "WITH", "VALUES"]);
/** Words that make a statement write: INTO also covers SELECT ... INTO OUTFILE and INTO @variable. */
const WRITE_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "INTO", "LOAD", "CALL", "HANDLER"]);
/** What may follow EXPLAIN or DESCRIBE when it explains a statement rather than describing a table. */
const EXPLAINABLE = new Set([...READ_STATEMENTS, "INSERT", "UPDATE", "DELETE", "REPLACE"]);

function writes(tokens: Token[]): boolean {
  return tokens.some((token, i) => {
    const w = word(token);
    if (!w || !WRITE_WORDS.has(w)) return false;
    // INSERT(str, pos, len, new) and REPLACE(str, from, to) are string functions.
    if ((w === "INSERT" || w === "REPLACE") && tokens[i + 1]?.text === "(") return false;
    // SELECT ... FOR UPDATE locks rows; it doesn't change them.
    if (w === "UPDATE" && word(tokens[i - 1]) === "FOR") return false;
    return true;
  });
}

/**
 * Reads `EXPLAIN [ANALYZE] [FORMAT=...] [EXTENDED|PARTITIONS] [INTO @var]`,
 * `DESCRIBE ...` and MariaDB's `ANALYZE [FORMAT=JSON]`. Returns the index of
 * the statement after it, or an error.
 */
function readExplainPrefix(tokens: Token[], requested: StatementInfo["requestedOptions"]): number | string {
  const first = word(tokens[0]);
  let i = 0;
  if (first === "ANALYZE") {
    // ANALYZE TABLE updates statistics; ANALYZE SELECT ... is MariaDB's EXPLAIN ANALYZE.
    const next = word(tokens[1]);
    if (next === "TABLE" || next === "NO_WRITE_TO_BINLOG" || next === "LOCAL") return 0;
    requested.analyze = true;
    i = 1;
  } else if (first === "EXPLAIN" || first === "DESCRIBE" || first === "DESC") {
    i = 1;
  } else {
    return 0;
  }

  for (;;) {
    const w = word(tokens[i]);
    if (w === "ANALYZE") {
      requested.analyze = true;
      i++;
    } else if (w === "EXTENDED" || w === "PARTITIONS") {
      i++;
    } else if (w === "FORMAT" && tokens[i + 1]?.text === "=") {
      i += 3;
    } else if (w === "INTO" && tokens[i + 1]?.text === "@") {
      i += 3;
    } else {
      break;
    }
  }

  const next = word(tokens[i]) ?? tokens[i]?.text;
  if (next === "FOR") return "EXPLAIN FOR CONNECTION and FOR SCHEMA can't be visualized. Explain the statement itself.";
  if (first !== "ANALYZE" && next !== "(" && next !== undefined && !EXPLAINABLE.has(next)) {
    return `${first} followed by a table name describes the table's columns, not a query plan.`;
  }
  return i;
}

/**
 * Every combination of the SQL modes that change how text is read. The mode
 * read when the tab opened may not be the one of the pooled connection the
 * EXPLAIN runs on (a query tab can change it with SET SESSION), so a
 * statement must read as one statement, and as a read, under all of them.
 */
const MODES: Pick<MysqlServerInfo, "noBackslashEscapes" | "ansiQuotes">[] = [
  { noBackslashEscapes: false, ansiQuotes: false },
  { noBackslashEscapes: true, ansiQuotes: false },
  { noBackslashEscapes: false, ansiQuotes: true },
  { noBackslashEscapes: true, ansiQuotes: true },
];

/** Classifies a statement for EXPLAIN. Never throws. */
export function inspectStatement(sql: string, server?: MysqlServerInfo): StatementInfo {
  const tokens = onlyStatement(sql, splitStatements(sql, mysqlDialect(server)));
  if (!Array.isArray(tokens)) return tokens;
  let writesInAnyMode = false;
  for (const mode of MODES) {
    const statements = splitStatements(sql, mysqlDialect({ flavor: "mysql", ...mode }));
    const unclear = ambiguity(statements);
    if (unclear) return emptyStatement(sql.trim(), unclear.reason);
    if (statements.length !== 1) {
      return emptyStatement(
        sql.trim(),
        "This text reads as more than one statement under some SQL modes (NO_BACKSLASH_ESCAPES, ANSI_QUOTES), so it can't be explained safely. Write a quote inside a string by doubling it ('') rather than with a backslash."
      );
    }
    // Only the statement counts: EXPLAIN ... INTO @variable doesn't write.
    const other = statements[0].tokens;
    const start = readExplainPrefix(other, {});
    writesInAnyMode ||= writes(other.slice(typeof start === "number" ? start : 0));
  }

  const requestedOptions: StatementInfo["requestedOptions"] = {};
  const start = readExplainPrefix(tokens, requestedOptions);
  if (typeof start === "string") return { ...emptyStatement(sql.trim(), start), requestedOptions };

  const body = tokens.slice(start);
  if (body.length === 0) return { ...emptyStatement("", "No SQL statement to explain."), requestedOptions };

  const first = firstKeyword(body);
  return {
    statement: sourceOf(sql, body),
    modifiesData: !first || !READ_STATEMENTS.has(first) || writes(body) || writesInAnyMode,
    requestedOptions,
    hasParameters: body.some((t) => t.type === "param"),
    // EXPLAIN can't plan a placeholder without a value.
    error: parameterError(body),
  };
}
