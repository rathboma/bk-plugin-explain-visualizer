import { describe, expect, it } from "vitest";
import { baseKey, parseJsonKeepingDuplicates } from "../../src/engines/shared/json";

describe("parseJsonKeepingDuplicates", () => {
  it("keeps every repeated key, in order", () => {
    const value = parseJsonKeepingDuplicates('{"table": {"n": 1}, "other": true, "table": {"n": 2}, "table": {"n": 3}}');
    expect(Object.keys(value as object)).toEqual(["table", "other", "table#2", "table#3"]);
    expect(Object.keys(value as object).map(baseKey)).toEqual(["table", "other", "table", "table"]);
    expect((value as Record<string, { n: number }>)["table#3"].n).toBe(3);
  });

  it("reads everything JSON.parse reads", () => {
    const text = '[1, -2.5e3, "a\\"b\\u00e9", true, false, null, {"a": [], "b": {}}]';
    expect(parseJsonKeepingDuplicates(text)).toEqual(JSON.parse(text));
    expect(parseJsonKeepingDuplicates("  42  ")).toBe(42);
  });

  it("rejects what isn't JSON", () => {
    for (const bad of ['{"a": }', "[1, 2", '{"a" 1}', "{} x", ""]) {
      expect(() => parseJsonKeepingDuplicates(bad), bad).toThrow(SyntaxError);
    }
  });
});
