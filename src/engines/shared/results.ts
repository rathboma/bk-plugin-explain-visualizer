import type { QueryResultLike } from "../types";

/** A cell's value, whether the host keyed the row by column name or by id. */
export function cell(row: Record<string, unknown>, field: QueryResultLike["fields"][number]): unknown {
  return row[field.name] ?? (field.id ? row[field.id] : undefined);
}

/**
 * The values of the first column named one of `names` (case-insensitive), in
 * the first result set that has it.
 */
export function columnValues(results: QueryResultLike[], names: string[]): unknown[] | undefined {
  const wanted = names.map((n) => n.toLowerCase());
  for (const result of results) {
    const field = result.fields.find((f) => wanted.includes(f.name.toLowerCase()));
    if (!field || !result.rows.length) continue;
    return result.rows.map((row) => cell(row, field));
  }
  return undefined;
}

/** Each row as an object keyed by lower-cased column name. */
export function rowsByName(result: QueryResultLike): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.fields.map((field) => [field.name.toLowerCase(), cell(row, field)]))
  );
}

/** Flattens values from a results grid (strings, rows of strings, 2D ranges). */
export function flattenGridValue(input: unknown[]): unknown {
  const flat = input.flat(2);
  if (flat.length === 1) return flat[0];
  if (flat.every((v) => typeof v === "string")) return flat.join("\n");
  return input;
}

/** True for values a results grid hands over: lists of strings or rows. */
export function isGridValue(input: unknown): input is unknown[] {
  return Array.isArray(input) && input.some((v) => typeof v === "string" || Array.isArray(v));
}

/** Parses JSON text, or returns undefined when it isn't JSON. */
export function tryJson(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
