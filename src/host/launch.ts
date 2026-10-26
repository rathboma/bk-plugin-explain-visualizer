import type {
  CellMenuParams,
  ColumnMenuParams,
  EditorMenuParams,
  StatusbarMenuParams,
} from "@beekeeperstudio/plugin";
import type { PluginViewContext } from "./host";

/** What the tab was opened with, worked out from the menu that opened it. */
export type LaunchInput =
  | { kind: "query"; sql: string }
  | { kind: "plan"; value: unknown }
  | { kind: "empty" };

const nonEmpty = (...values: unknown[]): string | undefined =>
  values.find((v): v is string => typeof v === "string" && v.trim().length > 0);

function looksLikeJson(value: unknown): boolean {
  return typeof value === "string" && /^\s*[[{]/.test(value);
}

export function launchInput(context: PluginViewContext | undefined): LaunchInput {
  const params = context?.params;
  switch (context?.command) {
    // Query editor context menu: selection first, then the statement under
    // the cursor, then the whole editor.
    case "explain-query": {
      const editor = params as EditorMenuParams | undefined;
      const sql = nonEmpty(editor?.selectedText, editor?.selectedQuery, editor?.text);
      return sql ? { kind: "query", sql } : { kind: "empty" };
    }

    // Results grid: a JSON plan lives in one cell, a text plan spans a
    // column (one row per line).
    case "visualize-cell": {
      const cell = params as CellMenuParams | undefined;
      const range = cell?.activeRange;
      const value = cell?.target?.value;
      if (value === undefined || value === null) return { kind: "empty" };
      if (typeof value === "string" && !looksLikeJson(value) && (range?.value?.length ?? 0) > 1) {
        return { kind: "plan", value: range!.value };
      }
      return { kind: "plan", value };
    }
    case "visualize-column": {
      const target = (params as ColumnMenuParams | undefined)?.target;
      return target?.value?.length ? { kind: "plan", value: target.value } : { kind: "empty" };
    }

    // Visualize menu in the results status bar: the whole result, or the
    // selected cells. A JSON plan is one cell, a text plan one row per line.
    case "visualize-result": {
      const rows = (params as StatusbarMenuParams | undefined)?.target?.value ?? [];
      if (rows.length === 0) return { kind: "empty" };
      if (rows.length === 1 && rows[0]?.length === 1) return { kind: "plan", value: rows[0][0] };
      return { kind: "plan", value: rows };
    }

    default:
      return { kind: "empty" };
  }
}
