/**
 * Everything the plugin needs from Beekeeper Studio, in one place. Components
 * never import the SDK directly, which keeps them easy to test and lets the
 * dev harness (dev/harness.html) stand in for the app.
 */
import {
  addNotificationListener,
  appStorage,
  clipboard,
  confirm,
  getAppInfo,
  getConnectionInfo,
  getViewContext,
  getViewState,
  noty,
  openTab,
  requestFileSave,
  runQuery,
  setTabTitle,
  setViewState,
  type AppTheme,
  type ConnectionInfo,
  type PluginViewContext,
} from "@beekeeperstudio/plugin";
import type { QueryResultLike, RunQuery } from "../engines/types";

export type { AppTheme, ConnectionInfo, PluginViewContext };

/** Host errors arrive as Error-like objects through postMessage. */
export function errorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/** Failures of optional calls (older app versions) should not break the UI. */
async function optional<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

export const host = {
  connectionInfo: () => optional(getConnectionInfo),
  viewContext: () => optional(getViewContext),
  appInfo: () => optional(getAppInfo),

  viewState: <T>() => optional(() => getViewState<T>()),
  saveViewState: <T>(state: T) => optional(() => setViewState<T>(state)),

  /** Plugin-wide preferences shared by every tab. */
  preference: <T>(key: string) => optional(() => appStorage.getItem<T>(key)),
  savePreference: <T>(key: string, value: T) => optional(() => appStorage.setItem<T>(key, value)),

  runQuery: (async (sql: string) => {
    const response = await runQuery(sql);
    if (response.error) throw response.error;
    return response.results as unknown as QueryResultLike[];
  }) satisfies RunQuery,

  setTitle: (title: string) => optional(() => setTabTitle(title)),

  /**
   * Asks the user in a Beekeeper Studio dialog. Resolves to undefined when the
   * app can't show one: the plugin iframe isn't allowed to open
   * window.confirm(), so there is no fallback.
   */
  confirm: async (title: string, message: string, confirmLabel: string): Promise<boolean | undefined> => {
    try {
      return await confirm(title, message, { confirmLabel, cancelLabel: "Cancel" });
    } catch {
      return undefined;
    }
  },

  copy: async (text: string) => {
    try {
      await clipboard.writeText(text);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        await optional(() => noty.error(`Copy failed: ${errorMessage(e)}`));
        return;
      }
    }
    await optional(() => noty.success("Copied to clipboard"));
  },

  saveFile: (data: string, fileName: string, extension: string, label: string) =>
    requestFileSave({
      data,
      fileName,
      filters: [
        { name: label, extensions: [extension] },
        { name: "All Files", extensions: ["*"] },
      ],
    }),

  openQueryTab: (query: string) => optional(() => openTab("query", { query })),

  notifyError: (message: string) => optional(() => noty.error(message)),

  onThemeChange: (handler: (theme: AppTheme) => void) => addNotificationListener("themeChanged", handler),
};

export type Host = typeof host;
