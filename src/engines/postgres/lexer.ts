/**
 * A small PostgreSQL lexer. It is not a parser: it only knows enough to skip
 * comments and quoted text, so statements can be split on `;` and keywords can
 * be found without being fooled by strings or identifiers.
 *
 * Where it decides what is code and what is not, it follows PostgreSQL's own
 * scanner (src/backend/parser/scan.l). That matters for safety: if the two
 * disagreed, text this lexer took for a string or comment could hide a second
 * statement that the server would run.
 */

export type TokenType = "word" | "identifier" | "string" | "number" | "param" | "symbol";

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

export interface LexerOptions {
  /**
   * `standard_conforming_strings = off`: backslashes escape quotes in plain
   * '...' strings too, not only in E'...' strings.
   */
  backslashQuotes?: boolean;
}

// scan.l: space = [ \t\n\r\f\v]. Other characters, including non-breaking
// spaces, are not whitespace to PostgreSQL.
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";
// ident_start = [A-Za-z\200-\377_]: every non-ASCII character can start a name.
const isWordStart = (ch: string | undefined) =>
  ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch >= "\u0080");
const isWordPart = (ch: string | undefined) => isWordStart(ch) || isDigit(ch) || ch === "$";
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

export function tokenize(sql: string, options: LexerOptions = {}): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let brackets = 0;
  const n = sql.length;

  const push = (type: TokenType, start: number, end: number) => {
    tokens.push({ type, text: sql.slice(start, end), start, end });
  };

  // Reads a quoted string or identifier starting at the opening quote.
  const readQuoted = (from: number, quote: string, backslash: boolean): number => {
    let j = from + 1;
    while (j < n) {
      const ch = sql[j];
      if (backslash && ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (isSpace(ch)) {
      i++;
      continue;
    }

    // -- comment, which ends at either newline character
    if (ch === "-" && next === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
      i = j;
      continue;
    }

    // /* block comment */, nestable
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
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

    // E'...' (escape string), B'...', X'...', N'...'
    if ((ch === "E" || ch === "e") && next === "'") {
      const end = readQuoted(i + 1, "'", true);
      push("string", i, end);
      i = end;
      continue;
    }
    if ("BbXxNn".includes(ch) && next === "'") {
      const end = readQuoted(i + 1, "'", Boolean(options.backslashQuotes));
      push("string", i, end);
      i = end;
      continue;
    }
    // U&'...' and U&"..."
    if ((ch === "U" || ch === "u") && next === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      const quote = sql[i + 2];
      const end = readQuoted(i + 2, quote, quote === "'" && Boolean(options.backslashQuotes));
      push(quote === "'" ? "string" : "identifier", i, end);
      i = end;
      continue;
    }

    if (ch === "'") {
      const end = readQuoted(i, "'", Boolean(options.backslashQuotes));
      push("string", i, end);
      i = end;
      continue;
    }

    if (ch === '"') {
      const end = readQuoted(i, '"', false);
      push("identifier", i, end);
      i = end;
      continue;
    }

    if (ch === "$") {
      // $1 positional parameter
      if (isDigit(next)) {
        let j = i + 1;
        while (j < n && isDigit(sql[j])) j++;
        push("param", i, j);
        i = j;
        continue;
      }
      // $tag$ ... $tag$ dollar quoting
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

    // :name placeholders used by some clients. `::` is a cast, and inside
    // [...] a colon is an array slice (a[lo:hi]).
    if (ch === ":" && next !== ":" && sql[i - 1] !== ":" && brackets === 0 && isWordStart(next)) {
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
export function splitStatements(sql: string, options: LexerOptions = {}): SplitStatement[] {
  const tokens = tokenize(sql, options);
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
