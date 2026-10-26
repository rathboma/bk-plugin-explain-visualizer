/**
 * A small SQL lexer that each engine configures for its dialect. It is not a
 * parser: it only knows enough to skip comments and quoted text, so
 * statements can be split on `;` and keywords can be found without being
 * fooled by strings or identifiers.
 *
 * Where it decides what is code and what is not, a dialect must follow the
 * database's own scanner. That matters for safety: if the two disagreed, text
 * this lexer took for a string or comment could hide a second statement that
 * the server would run. Where the server's reading isn't certain (it depends
 * on its version, or other tools read the text differently), the lexer emits
 * an `ambiguous` token, and engines refuse the statement.
 */

export type TokenType = "word" | "identifier" | "string" | "number" | "param" | "symbol" | "ambiguous";

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
  /** For `ambiguous` tokens: why the server may read the text differently. */
  reason?: string;
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
   * a comment when a space or control character (DEL included) follows the
   * dashes.
   */
  dashComments: "always" | "followed-by-space";
  /**
   * What ends a `--` or `#` comment. PostgreSQL ends them at either line-break
   * character; MySQL and SQLite only at a line feed. With "lf", a carriage
   * return inside a comment (other than before a line feed) is ambiguous:
   * other tools end the comment there.
   */
  lineCommentEnd?: "cr-or-lf" | "lf";
  /** `#` starts a comment (MySQL). */
  hashComments?: boolean;
  /** Block comments nest (PostgreSQL). */
  nestedBlockComments?: boolean;
  /**
   * MySQL and MariaDB run the text inside `/*! ... *\/`, so it is read as SQL
   * rather than skipped, and its delimiters are kept as `symbol` tokens so a
   * statement's text includes them. Whether they run the text inside a
   * version-gated `/*!50700 ... *\/` depends on the server's version, and only
   * MariaDB runs `/*M! ... *\/`: those are ambiguous, as is a comment inside an
   * executable one.
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
/** `/*!`, `/*!50700` (MySQL) and `/*M!100500` (MariaDB): the version is optional. */
const EXECUTABLE_COMMENT = /\/\*(M?)!(\d*)/y;

const DOUBT = {
  nul: "The statement contains a NUL character, which servers and drivers read differently, so it can't be explained safely.",
  carriageReturn:
    "A -- or # comment contains a carriage return without a line feed. The server ends comments only at a line feed, other tools at either, so the statement can't be explained safely. Use ordinary line breaks.",
  dashes:
    "-- is followed by a character that some servers count as a space and others don't, so it isn't certain whether a comment starts there. Add a space after --.",
  versioned:
    "Whether the server runs the text inside /*!NNNNN ... */ depends on its version, so the statement can't be explained safely. Remove the version number or the comment.",
  mariadbOnly:
    "MariaDB runs the text inside /*M! ... */ and MySQL doesn't, so the statement can't be explained safely. Remove the comment or write its contents out.",
  nested:
    "A comment inside a /*! ... */ comment is read differently by different servers, so the statement can't be explained safely.",
  unclosed: "A /*! ... */ comment is never closed, so the statement can't be explained safely.",
};

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
  const doubt = (start: number, end: number, reason: string) => {
    tokens.push({ type: "ambiguous", text: sql.slice(start, end), start, end, reason });
  };
  const lfOnly = dialect.lineCommentEnd === "lf";

  // Skips a -- or # comment whose text starts at `from`.
  const lineComment = (from: number) => {
    let j = from;
    while (j < n && sql[j] !== "\n" && (lfOnly || sql[j] !== "\r")) {
      if (sql[j] === "\r" && sql[j + 1] !== "\n") doubt(j, j + 1, DOUBT.carriageReturn);
      j++;
    }
    i = j;
  };

  const nul = sql.indexOf("\0");
  if (nul !== -1) doubt(nul, nul + 1, DOUBT.nul);

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

    // -- comment, to the end of the line
    if (ch === "-" && next === "-") {
      const after = sql[i + 2];
      if (dialect.dashComments === "always" || after === undefined || after <= " " || after === "\x7f") {
        lineComment(i + 2);
        continue;
      }
      // MySQL's test for a space depends on the connection's character set.
      if (after >= "\u0080") doubt(i, i + 3, DOUBT.dashes);
    }

    if (ch === "#" && dialect.hashComments) {
      lineComment(i + 1);
      continue;
    }

    if (ch === "/" && next === "*") {
      if (dialect.executableComments) {
        if (executableDepth > 0) doubt(i, i + 2, DOUBT.nested);
        EXECUTABLE_COMMENT.lastIndex = i;
        const match = EXECUTABLE_COMMENT.exec(sql);
        if (match) {
          if (match[1]) doubt(i, i + match[0].length, DOUBT.mariadbOnly);
          else if (match[2]) doubt(i, i + match[0].length, DOUBT.versioned);
          push("symbol", i, i + match[0].length);
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
      push("symbol", i, i + 2);
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

  if (executableDepth > 0) doubt(n, n, DOUBT.unclosed);
  return tokens.sort((a, b) => a.start - b.start);
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
