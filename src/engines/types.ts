import type { Plan } from "../core/plan";

/** A single result set, as returned by Beekeeper Studio's `runQuery`. */
export interface QueryResultLike {
  fields: { id?: string; name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
}

/** Runs SQL through the host application and returns every result set. */
export type RunQuery = (sql: string) => Promise<QueryResultLike[]>;

/**
 * What an engine knows about the server it talks to. Engines extend this
 * with their own fields (PostgreSQL's string escaping, MySQL's SQL mode...)
 * and get the same object back in every call.
 */
export interface ServerInfo {
  /** The product, when it is more specific than the engine: "MariaDB". */
  productName?: string;
  /** Engine-specific numeric version, comparable within one product. */
  version?: number;
  versionLabel?: string;
}

/** A toggle shown in the options menu, e.g. VERBOSE or BUFFERS. */
export interface ExplainOption {
  id: string;
  label: string;
  description: string;
  defaultValue: boolean;
  /** Only applies when the statement is executed (ANALYZE). */
  requiresAnalyze?: boolean;
  /** Why the server can't use this option, e.g. "Needs PostgreSQL 13+". */
  unavailable?(server: ServerInfo | undefined): string | undefined;
}

export type ExplainOptionValues = Record<string, boolean>;

/** What an engine learned about a statement before explaining it. */
export interface StatementInfo {
  /** The statement to explain, without any EXPLAIN prefix or trailing `;`. */
  statement: string;
  /** True when executing the statement could change data. */
  modifiesData: boolean;
  /** Options asked for by an EXPLAIN prefix the user wrote themselves. */
  requestedOptions: { analyze?: boolean } & Partial<ExplainOptionValues>;
  /** Positional parameters ($1, ?...) found in the statement. */
  hasParameters: boolean;
  /** A reason the statement can't be explained. */
  error?: string;
}

export interface AnalyzeContext {
  server?: ServerInfo;
  /** Beekeeper Studio's read-only mode, which only allows read statements. */
  readOnlyConnection: boolean;
}

/**
 * How Explain Analyze, which runs the statement, treats one statement. Each
 * engine decides: PostgreSQL rolls writes back, MySQL refuses them.
 */
export interface AnalyzePolicy {
  /** Why the statement can't be analyzed. Shown under the editor and as the error. */
  blocked?: string;
  /** Shown under the editor while the statement is there, e.g. that writes are rolled back. */
  note?: string;
  /** Asked before the statement runs. */
  confirm?: { title: string; message: string; confirmLabel: string };
}

export interface ExplainRequest {
  statement: StatementInfo;
  analyze: boolean;
  options: ExplainOptionValues;
  server?: ServerInfo;
  /** Beekeeper Studio's read-only mode, which only allows read statements. */
  readOnlyConnection?: boolean;
}

export type RawFormat = "json" | "text" | "xml";

export interface ParsedPlan {
  plan: Plan;
  /** The native plan output, used by the Raw view and for export. */
  raw: string;
  rawFormat: RawFormat;
}

export interface ExplainResult extends ParsedPlan {
  /** The SQL that was sent to the database (the last statement, when several were). */
  sql: string;
}

/**
 * One implementation per database family. Adapters translate between the
 * engine's EXPLAIN dialect and the shared {@link Plan} model.
 *
 * To add a database: implement this interface in `src/engines/<name>/` and
 * register it in `src/engines/registry.ts`. Nothing outside the engine's
 * folder needs to know about it.
 */
export interface ExplainEngine {
  /** Stable id, usually the main Beekeeper Studio connection type. */
  id: string;
  displayName: string;
  /** Products listed as supported, when the engine covers several. Defaults to `displayName`. */
  products?: string[];
  /** Beekeeper Studio connection types this engine can explain. */
  connectionTypes: string[];
  /** Whether the engine can run the statement to collect actual timings. */
  supportsAnalyze: boolean;
  /** Toggles offered in the options menu. */
  options: ExplainOption[];
  /** Placeholder text for the "paste a plan" box. */
  pasteHint: string;
  /** Optional link to the engine's EXPLAIN documentation. */
  docsUrl?: string;

  /** Fetches the server version (and anything else it needs) once per tab. */
  loadServerInfo?(run: RunQuery): Promise<ServerInfo>;
  /**
   * Validates and classifies a statement. Never throws. Pass the server info
   * when known: it can change how the statement is read.
   */
  inspect(sql: string, server?: ServerInfo): StatementInfo;
  /**
   * Whether Explain Analyze may run a statement, and what to tell the user.
   * Only called for engines that support analyze; never throws.
   */
  analyzePolicy(statement: StatementInfo, context: AnalyzeContext): AnalyzePolicy;
  /** Runs EXPLAIN through the host and parses the output. It may run several queries. */
  explain(request: ExplainRequest, run: RunQuery): Promise<ExplainResult>;
  /** Whether a pasted value looks like a plan from this engine. */
  canParse(input: unknown): boolean;
  /** Parses a pasted plan or a value taken from a results grid. */
  parse(input: unknown): ParsedPlan;
}
