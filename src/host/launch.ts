import type { PluginViewContext } from "./host";

/** What the tab was opened with, worked out from the menu that opened it. */
export type LaunchInput =
  | { kind: "query"; sql: string }
  | { kind: "plan"; value: unknown }
  | { kind: "empty" };

type Params = Record<string, unknown> | undefined;

const nonEmpty = (...values: unknown[]): string | undefined =>
  values.find((v): v is string => typeof v === "string" && v.trim().length > 0);

function looksLikeJson(value: unknown): boolean {
  return typeof value === "string" && /^\s*[[{]/.test(value);
}

export function launchInput(context: PluginViewContext | undefined): LaunchInput {
  const params = context?.params as Params;
  switch (context?.command) {
    // Query editor context menu: selection first, then the statement under
    // the cursor, then the whole editor.
    case "explain-query": {
      const sql = nonEmpty(params?.selectedText, params?.selectedQuery, params?.text);
      return sql ? { kind: "query", sql } : { kind: "empty" };
    }

    // Results grid: a JSON plan lives in one cell, a text plan spans a
    // column (one row per line).
    case "visualize-cell": {
      const target = params?.target as { value?: unknown } | undefined;
      const range = params?.activeRange as { value?: unknown[][] } | undefined;
      const value = target?.value;
      if (value === undefined || value === null) return { kind: "empty" };
      if (typeof value === "string" && !looksLikeJson(value) && (range?.value?.length ?? 0) > 1) {
        return { kind: "plan", value: range!.value };
      }
      return { kind: "plan", value };
    }
    case "visualize-column": {
      const target = params?.target as { value?: unknown[][] } | undefined;
      return target?.value?.length ? { kind: "plan", value: target.value } : { kind: "empty" };
    }

    default:
      return { kind: "empty" };
  }
}
