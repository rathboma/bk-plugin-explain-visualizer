/**
 * The ways engines let Explain Analyze run statements. An engine picks one in
 * its `analyzePolicy`, or writes its own.
 */
import type { AnalyzeContext, AnalyzePolicy, StatementInfo } from "../types";

/**
 * The engine runs the statement and its changes in a transaction that is
 * rolled back (PostgreSQL). Writes are asked about first, and refused on
 * read-only connections, where Beekeeper Studio doesn't allow the rollback.
 */
export function rollbackPolicy(statement: StatementInfo, context: AnalyzeContext): AnalyzePolicy {
  if (!statement.modifiesData) return {};
  if (context.readOnlyConnection) {
    return {
      blocked: "This statement changes data, so it can't be analyzed on a read-only connection. Explain (without Analyze) still works.",
    };
  }
  return {
    note: "This statement changes data. Explain Analyze rolls the changes back.",
    confirm: {
      title: "Run this statement?",
      message:
        "Explain Analyze runs the statement to measure it. This statement can change data: its changes are rolled back afterwards, but effects outside the database transaction (such as sequence values) are not undone.",
      confirmLabel: "Run and Roll Back",
    },
  };
}

/**
 * The engine can't undo what the statement does, so only statements that
 * read are analyzed. `reason` says why writes can't be undone.
 */
export function readsOnlyPolicy(statement: StatementInfo, reason: string): AnalyzePolicy {
  if (!statement.modifiesData) return {};
  return { blocked: `This statement changes data, so it can't be analyzed: ${reason} Explain (without Analyze) still works.` };
}
