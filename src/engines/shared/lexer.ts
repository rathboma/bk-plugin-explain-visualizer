/**
 * A small SQL lexer that each engine configures for its dialect. It is not a
 * parser: it only knows enough to skip comments and quoted text, so
 * statements can be split on `;` and keywords can be found without being
 * fooled by strings or identifiers.
 *
 * Where it decides what is code and what is not, a dialect must follow the
 * database's own scanner. That matters for safety: if the two disagreed, text
 * this lexer took for a string or comment could hide a second statement that
 * the server would run.
 */

export type TokenType = "word" | "identifier" | "string" | "number" | "param" | "symbol";

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export interface QuoteRule {
  open: string;
  /** Defaults to `open`. Doubling the closing quote always escapes it. */
  close?: string;
  type: "string" | "identifier";
  /** A backslash escapes the next character. */
  backslash?: boolean;
  /** Letters that start the token right before the quote, e.g. `E` for E'...'. Case-insensitive. */
  prefixes?: string[];
}

export interface LexerDialect {
  /**
   * `--` starts a comment that ends at a line break. MySQL only treats it as
   * a comment when a space or control character follows the dashes.
   */
  dashComments: "always" | "followed-by-space";
  /** `#` starts a comment (MySQL). */
  hashComments?: boolean;
  /** Block comments nest (PostgreSQL). */
  nestedBlockComments?: boolean;
  /**
   * MySQL and MariaDB run the text inside `/*! ... *\/` and `/*M! ... *\/`,
   * so it is read as SQL rather than skipped.
   */
  executableComments?: boolean;
  /** Quoted strings and identifiers. Rules with prefixes are tried first. */
  quotes: QuoteRule[];
  /** `$tag$ ... $tag$` strings (PostgreSQL). */
  dollarQuotes?: boolean;
  /** Placeholder syntaxes reported as `param` tokens. */
  params: {
    /** `$1` */
    dollarNumber?: boolean;
    /** `?` and `?1` */
    question?: boolean;
    /** `:name`, but not a `::` cast or a `[lo:hi]` slice */
    colonName?: boolean;
    /** `@name` */
    atName?: boolean;
    /** `$name` */
    dollarName?: boolean;
  };
}

// The usual SQL whitespace. Other characters, including non-breaking spaces,
// are not whitespace to PostgreSQL, MySQL or SQLite.
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";
// Every non-ASCII character can be part of a name.
export const isWordStart = (ch: string | undefined) =>
  ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch >= "\u0080");
const isWordPart = (ch: string | undefined) => isWordStart(ch) || isDigit(ch) || ch === "$";
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
/** `/*!50700 ` (MySQL) and `/*M!100500 ` (MariaDB): the version is optional. */
const EXECUTABLE_COMMENT = /\/\*M?!\d*/y;

export function tokenize(sql: string, dialect: LexerDialect): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  const prefixed = dialect.quotes.filter((q) => q.prefixes?.length);
  const plain = dialect.quotes.filter((q) => !q.prefixes?.length);
  let i = 0;
  let brackets = 0;
  let executableDepth = 0;

  const push = (type: TokenType, start: number, end: number) => {
    tokens.push({ type, text: sql.slice(start, end), start, end });
  };

  // Reads a quoted string or identifier starting at the opening quote.
  const readQuoted = (from: number, rule: QuoteRule): number => {
    const close = rule.close ?? rule.open;
    let j = from + rule.open.length;
    while (j < n) {
      const ch = sql[j];
      if (rule.backslash && ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  const startsWith = (at: number, text: string) => sql.slice(at, at + text.length).toLowerCase() === text.toLowerCase();

  outer: while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (isSpace(ch)) {
      i++;
      continue;
    }

    // -- comment, which ends at either newline character
    if (ch === "-" && next === "-") {
      const after = sql[i + 2];
      if (dialect.dashComments === "always" || after === undefined || after <= " ") {
        let j = i + 2;
        while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
        i = j;
        continue;
      }
    }

    if (ch === "#" && dialect.hashComments) {
      let j = i + 1;
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      if (dialect.executableComments) {
        EXECUTABLE_COMMENT.lastIndex = i;
        const match = EXECUTABLE_COMMENT.exec(sql);
        if (match) {
          executableDepth++;
          i += match[0].length;
          continue;
        }
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect.nestedBlockComments && sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      i = j;
      continue;
    }

    // The end of an executable comment: the code inside it was read as SQL.
    if (executableDepth > 0 && ch === "*" && next === "/") {
      executableDepth--;
      i += 2;
      continue;
    }

    for (const rule of prefixed) {
      for (const prefix of rule.prefixes!) {
        if (startsWith(i, prefix) && sql.startsWith(rule.open, i + prefix.length)) {
          const end = readQuoted(i + prefix.length, rule);
          push(rule.type, i, end);
          i = end;
          continue outer;
        }
      }
    }

    for (const rule of plain) {
      if (sql.startsWith(rule.open, i)) {
        const end = readQuoted(i, rule);
        push(rule.type, i, end);
        i = end;
        continue outer;
      }
    }

    if (ch === "$") {
      if (dialect.params.dollarNumber && isDigit(next)) {
        let j = i + 1;
        while (j < n && isDigit(sql[j])) j++;
        push("param", i, j);
        i = j;
        continue;
      }
      if (dialect.dollarQuotes) {
        DOLLAR_TAG.lastIndex = i;
        const match = DOLLAR_TAG.exec(sql);
        if (match) {
          const tag = match[0];
          const close = sql.indexOf(tag, i + tag.length);
          const end = close === -1 ? n : close + tag.length;
          push("string", i, end);
          i = end;
          continue;
        }
      }
      if (dialect.params.dollarName && isWordStart(next)) {
        let j = i + 1;
        while (j < n && isWordPart(sql[j])) j++;
        push("param", i, j);
        i = j;
        continue;
      }
    }

    if (ch === "?" && dialect.params.question) {
      let j = i + 1;
      while (j < n && isDigit(sql[j])) j++;
      push("param", i, j);
      i = j;
      continue;
    }

    // :name placeholders used by some clients. `::` is a cast, and inside
    // [...] a colon is an array slice (a[lo:hi]).
    if (
      ch === ":" &&
      dialect.params.colonName &&
      next !== ":" &&
      sql[i - 1] !== ":" &&
      brackets === 0 &&
      isWordStart(next)
    ) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      push("param", i, j);
      i = j;
      continue;
    }

    if (ch === "@" && dialect.params.atName && isWordStart(next)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      push("param", i, j);
      i = j;
      continue;
    }

    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      push("word", i, j);
      i = j;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(next))) {
      let j = i + 1;
      while (j < n && (isDigit(sql[j]) || sql[j] === "." || sql[j] === "e" || sql[j] === "E" || sql[j] === "_")) j++;
      push("number", i, j);
      i = j;
      continue;
    }

    if (ch === "[") brackets++;
    if (ch === "]" && brackets > 0) brackets--;
    push("symbol", i, i + 1);
    i++;
  }

  return tokens;
}

export interface SplitStatement {
  text: string;
  tokens: Token[];
}

/** Splits SQL on top-level semicolons, dropping empty statements. */
export function splitStatements(sql: string, dialect: LexerDialect): SplitStatement[] {
  const tokens = tokenize(sql, dialect);
  const statements: SplitStatement[] = [];
  let current: Token[] = [];

  const flush = () => {
    if (current.length) {
      const start = current[0].start;
      const end = current[current.length - 1].end;
      statements.push({ text: sql.slice(start, end), tokens: current });
    }
    current = [];
  };

  for (const token of tokens) {
    if (token.type === "symbol" && token.text === ";") {
      flush();
    } else {
      current.push(token);
    }
  }
  flush();
  return statements;
}
