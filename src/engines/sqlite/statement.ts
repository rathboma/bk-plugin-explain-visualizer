import type { StatementInfo } from "../types";
import { splitStatements, type LexerDialect, type Token } from "../shared/lexer";
import { emptyStatement, firstKeyword, onlyStatement, parameterError, sourceOf, word } from "../shared/statement";

/** SQLite's scanner rules (tokenize.c): no backslash escapes, four kinds of quoted names. */
export const sqliteDialect: LexerDialect = {
  dashComments: "always",
  quotes: [
    { open: "'", type: "string" },
    { open: '"', type: "identifier" },
    { open: "`", type: "identifier" },
    { open: "[", close: "]", type: "identifier" },
  ],
  params: { question: true, colonName: true, atName: true, dollarName: true },
};

const READ_STATEMENTS = new Set(["SELECT", "WITH", "VALUES"]);
const WRITE_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

function writes(tokens: Token[]): boolean {
  return tokens.some((token, i) => {
    const w = word(token);
    // replace(x, y, z) is a string function.
    return !!w && WRITE_WORDS.has(w) && !(w === "REPLACE" && tokens[i + 1]?.text === "(");
  });
}

/** Classifies a statement for EXPLAIN QUERY PLAN. Never throws. */
export function inspectStatement(sql: string): StatementInfo {
  const tokens = onlyStatement(sql, splitStatements(sql, sqliteDialect));
  if (!Array.isArray(tokens)) return tokens;

  // EXPLAIN QUERY PLAN ... or EXPLAIN ... the user wrote themselves.
  let start = 0;
  if (word(tokens[0]) === "EXPLAIN") {
    start = word(tokens[1]) === "QUERY" && word(tokens[2]) === "PLAN" ? 3 : 1;
  }
  const body = tokens.slice(start);
  if (body.length === 0) return emptyStatement("", "No SQL statement to explain.");

  const first = firstKeyword(body);
  return {
    statement: sourceOf(sql, body),
    modifiesData: !first || !READ_STATEMENTS.has(first) || writes(body),
    requestedOptions: {},
    hasParameters: body.some((t) => t.type === "param"),
    error: parameterError(body),
  };
}
