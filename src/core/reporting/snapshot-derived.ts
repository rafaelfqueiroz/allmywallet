/**
 * SPEC-011 — **a figure that exists only where the snapshot series does.**
 *
 * This vocabulary was written for SPEC-013 and lived in
 * `portfolio-value/ports.ts`. It moved here when SPEC-015 needed the same
 * refusal for composition drift, for the reason DL-011-02 gives about
 * everything else in this directory: a second copy under
 * `composition/` would be a second set of reasons, and two reports would
 * start explaining the same absence in two different ways to the same user.
 * `portfolio-value/ports.ts` re-exports it, so no SPEC-013 caller changed.
 *
 * **The typed absence is the point.** SPEC-012 set the precedent in
 * `performance/report.ts`: at wallet scope TWR and XIRR return
 * `SCOPE_SERIES_UNAVAILABLE` rather than the portfolio's numbers under a
 * wallet's heading. The substitution is dangerous *because* every figure in it
 * is real — it is the whole *patrimônio* answering a question about one
 * carteira, and nothing on screen says so.
 *
 * Deliberately **not** `Result<T, DomainError>`: a `Result` means the operation
 * failed, and nothing here failed. The report is complete and correct; one of
 * its figures does not exist at this scope.
 */

/**
 * **Why a figure derived from `daily_valuation_snapshots` is not being shown.**
 *
 * Every member traces to the same table and to one decision record, ADR-002
 * (`docs/adr/002-historical-breakdown-storage.md`). They are separate constants
 * because they are separate absences and the user is owed the difference: a
 * dimension the snapshot does not decompose along, a scope the snapshot does
 * not exist at, and a period with nothing recorded before it are three
 * different sentences to write on a screen.
 */
export const HistoryUnavailable = {
  /**
   * The snapshot carries a per-asset-class breakdown and nothing else. A
   * wallet, institution, sector or per-asset band would need a historical
   * breakdown along that dimension, which is a schema change with rebuild
   * implications rather than a query.
   */
  NO_HISTORICAL_BREAKDOWN: 'NO_HISTORICAL_BREAKDOWN',
  /**
   * SPEC-011 BR-011-02 at **wallet** scope. `daily_valuation_snapshots` holds
   * one row per user per day with no wallet dimension, so there is no wallet
   * history to read — and none can be synthesised, because `wallet_allocations`
   * stores only its *current* state (ADR-002, "the distinction that decides the
   * shape"). Applying today's split backwards would rewrite every past chart
   * the moment someone reassigns an asset, and a rebuild would then disagree
   * with the snapshot it replaced, breaking DM-4. Retiring this reason needs
   * effective-dated allocation history — backlog issue #50.
   */
  WALLET_SCOPE_NOT_SNAPSHOTTED: 'WALLET_SCOPE_NOT_SNAPSHOTTED',
  /**
   * SPEC-015 BR-015-04 — one end of the period has no allocation to compare
   * against. Three causes, one sentence to the user:
   *
   *  - no snapshot precedes the period at all (the tenant's history begins
   *    inside it, which is always true of the `all` period);
   *  - the snapshot that precedes it totals zero, so it has no allocation to
   *    take shares of; or
   *  - the scope holds nothing today, so neither has the closing end.
   *
   * They are one reason rather than three because the honest sentence is the
   * same in all of them — "there is nothing at one end of this period to
   * compare" — and because dividing by that zero is what the guard exists to
   * prevent. Drift from an assumed-empty baseline would report every holding
   * as having gone from 0 % to its current share, which reads as a dramatic
   * reallocation and is actually just the account opening.
   */
  NO_ALLOCATION_TO_COMPARE: 'NO_ALLOCATION_TO_COMPARE',
} as const;
export type HistoryUnavailable = (typeof HistoryUnavailable)[keyof typeof HistoryUnavailable];

export type SnapshotDerived<T> =
  | { readonly kind: 'available'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly reason: HistoryUnavailable };

export function available<T>(value: T): SnapshotDerived<T> {
  return { kind: 'available', value };
}

export function unavailable<T>(reason: HistoryUnavailable): SnapshotDerived<T> {
  return { kind: 'unavailable', reason };
}
