/**
 * JSON.parse keeps only the last of repeated keys. MariaDB before 11 lists
 * the tables of a join as repeated "table" keys in one object, so this
 * parser keeps every one: the second "table" becomes "table#2", and so on,
 * in their original order. Use {@link baseKey} to read the name back.
 */
export function parseJsonKeepingDuplicates(text: string): unknown {
  let i = 0;
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at position ${i}`);
  };
  const space = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const string = (): string => {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) fail("Unterminated string");
    const value = JSON.parse(text.slice(i, j + 1)) as string;
    i = j + 1;
    return value;
  };
  const value = (): unknown => {
    space();
    const ch = text[i];
    if (ch === "{") return object();
    if (ch === "[") return array();
    if (ch === '"') return string();
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return result;
      }
    }
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match) return fail(ch === undefined ? "Unexpected end of JSON" : `Unexpected "${ch}"`);
    i += match[0].length;
    return Number(match[0]);
  };
  const object = (): Record<string, unknown> => {
    i++;
    const obj: Record<string, unknown> = {};
    const counts = new Map<string, number>();
    space();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      space();
      if (text[i] !== '"') fail("Expected a key");
      let key = string();
      space();
      if (text[i] !== ":") fail('Expected ":"');
      i++;
      const v = value();
      if (Object.hasOwn(obj, key)) {
        const n = (counts.get(key) ?? 1) + 1;
        counts.set(key, n);
        key = `${key}#${n}`;
      }
      obj[key] = v;
      space();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      fail('Expected "," or "}"');
    }
  };
  const array = (): unknown[] => {
    i++;
    const items: unknown[] = [];
    space();
    if (text[i] === "]") {
      i++;
      return items;
    }
    for (;;) {
      items.push(value());
      space();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return items;
      }
      fail('Expected "," or "]"');
    }
  };

  const result = value();
  space();
  if (i < text.length) fail("Unexpected text after JSON");
  return result;
}

/** The key as the source wrote it: "table#2" → "table". */
export const baseKey = (key: string) => key.replace(/#\d+$/, "");
