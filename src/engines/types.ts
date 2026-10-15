import type { Plan } from "../core/plan";

/** A single result set, as returned by Beekeeper Studio's `runQuery`. */
export interface QueryResultLike {
  fields: { id?: string; name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
}

/** Runs SQL through the host application and returns every result set. */
export type RunQuery = (sql: string) => Promise<QueryResultLike[]>;

/** A toggle shown in the options menu, e.g. VERBOSE or BUFFERS. */
export interface ExplainOption {
  id: string;
  label: string;
  description: string;
  defaultValue: boolean;
  /** Only applies when the statement is executed (ANALYZE). */
  requiresAnalyze?: boolean;
  /** Minimum server version, in the engine's own numeric format. */
  minServerVersion?: number;
}

export type ExplainOptionValues = Record<string, boolean>;

export interface ServerInfo {
  /** Engine-specific numeric version, e.g. 170002 for PostgreSQL 17.2. */
  version?: number;
  versionLabel?: string;
  /** PostgreSQL: false when backslashes escape quotes in plain strings. */
  standardConformingStrings?: boolean;
}

/** What an engine learned about a statement before explaining it. */
export interface StatementInfo {
  /** The statement to explain, without any EXPLAIN prefix or trailing `;`. */
  statement: string;
  /** True when executing the statement could change data. */
  modifiesData: boolean;
  /** Options asked for by an EXPLAIN prefix the user wrote themselves. */
  requestedOptions: { analyze?: boolean } & Partial<ExplainOptionValues>;
  /** Positional parameters ($1, @p1...) found in the statement. */
  hasParameters: boolean;
  /** A reason the statement can't be explained. */
  error?: string;
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
  /** The SQL that was sent to the database. */
  sql: string;
}

/**
 * One implementation per database family. Adapters translate between the
 * engine's EXPLAIN dialect and the shared {@link Plan} model.
 *
 * To add a database: implement this interface in `src/engines/<name>/` and
 * register it in `src/engines/registry.ts`.
 */
export interface ExplainEngine {
  /** Stable id, usually the main Beekeeper Studio connection type. */
  id: string;
  displayName: string;
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

  /** Fetches the server version so options can be filtered. */
  loadServerInfo?(run: RunQuery): Promise<ServerInfo>;
  /**
   * Validates and classifies a statement. Never throws. Pass the server info
   * when known: it can change how the statement is read.
   */
  inspect(sql: string, server?: ServerInfo): StatementInfo;
  /** Builds the SQL that will be sent for a request. */
  buildExplainSql(request: ExplainRequest): string;
  /** Runs EXPLAIN through the host and parses the output. */
  explain(request: ExplainRequest, run: RunQuery): Promise<ExplainResult>;
  /** Whether a pasted value looks like a plan from this engine. */
  canParse(input: unknown): boolean;
  /** Parses a pasted plan or a value taken from a results grid. */
  parse(input: unknown): ParsedPlan;
}
