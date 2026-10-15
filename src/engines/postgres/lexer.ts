/**
 * A small PostgreSQL lexer. It is not a parser: it only knows enough to skip
 * comments and quoted text, so statements can be split on `;` and keywords can
 * be found without being fooled by strings or identifiers.
 */

export type TokenType = "word" | "identifier" | "string" | "number" | "param" | "symbol";

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  const push = (type: TokenType, start: number, end: number) => {
    tokens.push({ type, text: sql.slice(start, end), start, end });
  };

  // Reads a '...' string starting at the quote; `backslash` enables E'' escapes.
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

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // -- line comment
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }

    // /* block comment */, nestable in PostgreSQL
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

    // E'...' (escape string), B'...', X'...', U&'...', N'...'
    if (/[EeBbXxNn]/.test(ch) && next === "'") {
      const end = readQuoted(i + 1, "'", ch === "E" || ch === "e");
      push("string", i, end);
      i = end;
      continue;
    }
    if ((ch === "U" || ch === "u") && next === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      const quote = sql[i + 2];
      const end = readQuoted(i + 2, quote, false);
      push(quote === "'" ? "string" : "identifier", i, end);
      i = end;
      continue;
    }

    if (ch === "'") {
      const end = readQuoted(i, "'", false);
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
      if (next && DIGIT.test(next)) {
        let j = i + 1;
        while (j < n && DIGIT.test(sql[j])) j++;
        push("param", i, j);
        i = j;
        continue;
      }
      // $tag$ ... $tag$ dollar quoting
      const match = DOLLAR_TAG.exec(sql.slice(i, i + 64));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        push("string", i, end);
        i = end;
        continue;
      }
    }

    // :name style placeholders used by some clients. `::` is a cast.
    if (ch === ":" && next !== ":" && sql[i - 1] !== ":" && next && WORD_START.test(next)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) j++;
      push("param", i, j);
      i = j;
      continue;
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j])) j++;
      push("word", i, j);
      i = j;
      continue;
    }

    if (DIGIT.test(ch) || (ch === "." && next && DIGIT.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9._eE]/.test(sql[j])) j++;
      push("number", i, j);
      i = j;
      continue;
    }

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
export function splitStatements(sql: string): SplitStatement[] {
  const tokens = tokenize(sql);
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
