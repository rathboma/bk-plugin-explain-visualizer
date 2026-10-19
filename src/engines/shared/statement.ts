import type { StatementInfo } from "../types";
import type { SplitStatement, Token } from "./lexer";

/** The upper-cased text of a keyword token, or undefined for anything else. */
export const word = (t: Token | undefined): string | undefined => (t?.type === "word" ? t.text.toUpperCase() : undefined);

export function emptyStatement(statement: string, error?: string): StatementInfo {
  return { statement, modifiesData: false, requestedOptions: {}, hasParameters: false, error };
}

/** The first text the server may read differently from the lexer, if any. */
export function ambiguity(statements: SplitStatement[]): Token | undefined {
  for (const statement of statements) {
    const token = statement.tokens.find((t) => t.type === "ambiguous");
    if (token) return token;
  }
  return undefined;
}

/**
 * The tokens of the only statement in `sql`, or a StatementInfo explaining
 * why there isn't exactly one, or why it can't be read with certainty.
 */
export function onlyStatement(sql: string, statements: SplitStatement[]): Token[] | StatementInfo {
  const unclear = ambiguity(statements);
  if (unclear) return emptyStatement(sql.trim(), unclear.reason);
  if (statements.length === 0) return emptyStatement("", "No SQL statement to explain.");
  if (statements.length > 1) {
    return emptyStatement(
      sql.trim(),
      `Found ${statements.length} statements. Only one statement can be explained at a time.`
    );
  }
  return statements[0].tokens;
}

/** The first keyword, skipping the parentheses of "(SELECT ...) UNION (SELECT ...)". */
export function firstKeyword(tokens: Token[]): string | undefined {
  return word(tokens.find((t) => t.text !== "("));
}

/** The source text covered by a run of tokens. */
export function sourceOf(sql: string, tokens: Token[]): string {
  return tokens.length ? sql.slice(tokens[0].start, tokens[tokens.length - 1].end) : "";
}

/** An error for the first placeholder, which EXPLAIN can't plan without a value. */
export function parameterError(tokens: Token[], allowed: (token: Token) => boolean = () => false): string | undefined {
  const param = tokens.find((t) => t.type === "param" && !allowed(t));
  return param
    ? `The statement uses a query parameter (${param.text}). Replace parameters with values to explain it.`
    : undefined;
}
