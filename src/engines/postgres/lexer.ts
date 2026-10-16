/**
 * PostgreSQL's dialect for the shared lexer (`../shared/lexer.ts`).
 *
 * Where it decides what is code and what is not, it follows PostgreSQL's own
 * scanner (src/backend/parser/scan.l).
 */
import {
  splitStatements as split,
  tokenize as lex,
  type LexerDialect,
  type SplitStatement,
  type Token,
} from "../shared/lexer";

export type { SplitStatement, Token };

export interface LexerOptions {
  /**
   * `standard_conforming_strings = off`: backslashes escape quotes in plain
   * '...' strings too, not only in E'...' strings.
   */
  backslashQuotes?: boolean;
}

export function postgresDialect(options: LexerOptions = {}): LexerDialect {
  const backslash = Boolean(options.backslashQuotes);
  return {
    dashComments: "always",
    nestedBlockComments: true,
    dollarQuotes: true,
    quotes: [
      // E'...' (escape string), B'...', X'...', N'...', U&'...' and U&"..."
      { prefixes: ["E"], open: "'", type: "string", backslash: true },
      { prefixes: ["B", "X", "N", "U&"], open: "'", type: "string", backslash },
      { prefixes: ["U&"], open: '"', type: "identifier" },
      { open: "'", type: "string", backslash },
      { open: '"', type: "identifier" },
    ],
    params: { dollarNumber: true, colonName: true },
  };
}

export function tokenize(sql: string, options: LexerOptions = {}): Token[] {
  return lex(sql, postgresDialect(options));
}

/** Splits SQL on top-level semicolons, dropping empty statements. */
export function splitStatements(sql: string, options: LexerOptions = {}): SplitStatement[] {
  return split(sql, postgresDialect(options));
}
