/**
 * AR-15 / SPEC-003 BR-003-06: shared reference tables hold no personal data and
 * are exempt from tenant scoping **by explicit declaration**.
 *
 * The declaration is the point. The enumeration gate (`tests/isolation/`) treats
 * every table *not* on this list (nor on `AUTH_SUBSTRATE_TABLES` below) as
 * tenant-scoped and fails if it lacks `user_id`, lacks `FORCE ROW LEVEL
 * SECURITY`, or has no isolation test. So adding a table here is a
 * deliberate, reviewable act of saying "this holds nothing personal" —
 * rather than a table quietly escaping the boundary by being forgotten.
 */
export const SHARED_TABLES: readonly string[] = [
  'assets',
  'institutions',
  'price_quotes',
  'latest_quotes',
  'index_series',
  // Added by SPEC-002, beyond the five BR-003-06 names. BR-003-06 requires a
  // review when the list grows, so the reasoning is here rather than in a
  // commit message:
  //
  // `runtime_state` holds values the *system* wrote about itself — a degraded
  // quote cadence and the reason for it (BR-002-05). One row per key, no user
  // column, nothing derived from anyone's holdings. It meets BR-003-06's stated
  // test ("holds no personal data") without being one of the five tables that
  // rule happened to enumerate.
  'runtime_state',
  // Added by SPEC-008 (#11), same reviewed-addition path as `runtime_state`
  // above. `quote_budget_usage` is a process-wide monthly counter of provider
  // requests, partitioned 'scheduled'/'ondemand' (BR-008-19/20) — one row per
  // (year_month, kind), no user column, nothing derived from anyone's
  // holdings. It is *not* one of AR-15's five named tables either, so it
  // needs its own explicit exemption on the same "holds no personal data"
  // test — flagged in the #11 dispatch report as a deviation from the
  // issue's Modules table, which named only price_quotes/latest_quotes/
  // index_series.
  'quote_budget_usage',
  // Added by SPEC-016 (AR-50): the worker's own liveness heartbeat — a
  // process identity string and a timestamp, nothing derived from any
  // tenant's data. Same "holds no personal data" test as `runtime_state`.
  'worker_heartbeats',
];

/**
 * `audit_log` is exempt for a different reason, and a weaker one — recorded
 * separately so it does not hide inside the list above.
 *
 * Cross-tenant readability is the point of an audit log: BR-004-17 requires
 * operator access to personal data to be recorded in it, and an operator
 * reviewing that record is by definition reading across tenants. An RLS policy
 * keyed on `app.user_id` would make the table useless for the thing it exists
 * to do.
 *
 * What that leaves open, stated plainly rather than argued away: for a
 * user-level config key, `previous_value` and `new_value` are that user's own
 * preferences (BR-002-07), so the table does hold tenant data even though it
 * has no `user_id` column to scope by. Today nothing tenant-facing queries it,
 * which is the actual mitigation.
 *
 * SPEC-004 (#7) RESOLVED the two consequences this comment used to defer:
 *
 * - **Retention**: `retention.audit_months` (SPEC-002 registry, default 12,
 *   range 1–120) bounds how long a row lives; a daily worker sweep
 *   (`src/worker/handlers/account-deletion.ts`'s `handleAuditRetentionSweep`)
 *   purges rows older than that.
 * - **Purged, anonymised, or kept when the account is deleted?** — **kept**.
 *   `src/db/schema/config.ts`'s `auditLog` now carries a nullable, plain
 *   (non-foreign-key) `user_id` column, so it *can* be scoped by user for a
 *   query, but that column carries no `ON DELETE CASCADE` — a deleted
 *   account's audit history outlives the account on purpose, which is the
 *   entire point of BR-004-17's operator-access record. See the long comment
 *   on `auditLog` itself for the full reasoning, including why this table
 *   stays off `tests/isolation/deletion-cascade.test.ts`'s cascade check by
 *   the same declared-exempt mechanism as the rest of this file.
 */
export const AUDIT_TABLES: readonly string[] = ['audit_log'];

/**
 * Machinery, not application data: Drizzle's migration bookkeeping and pg-boss's
 * job tables. Both live outside `public` by configuration, but they are listed
 * so a future schema change that moves them cannot silently be read as a tenant
 * table that lost its policy.
 */
export const INFRASTRUCTURE_TABLES: readonly string[] = [
  '__drizzle_migrations',
  'drizzle_migrations',
];

/**
 * Distinct from BR-003-06 above — these tables carry a `user_id` column (so
 * they would otherwise look tenant-scoped to the enumeration query) but are
 * part of the authentication substrate itself (SPEC-001, issue #4), not the
 * ledger the tenant boundary protects.
 *
 * `users` is the tenant root every RLS policy references — it cannot police
 * membership in itself.
 *
 * `sessions` and `accounts` exist for a structural reason, not convenience:
 * resolving *who* a request belongs to is exactly what these tables are
 * queried to determine, which means the lookup necessarily runs before
 * `app.user_id` can be set. A `FORCE RLS` policy keyed on
 * `current_setting('app.user_id')` would make every session lookup fail with
 * "unrecognized configuration parameter" — i.e. it would break authentication
 * outright, not merely restrict it. `verification_tokens` has no `user_id`
 * column at all (identifier/token keyed) but is listed here for the same
 * reason: it is Auth.js plumbing, not tenant data.
 *
 * The residual risk this accepts: these tables are reachable by any query the
 * `allmywallet_app` role runs, unfiltered by RLS. The mitigation is surface
 * area, not RLS — only `src/auth.ts`'s hand-rolled Adapter touches them,
 * session tokens are cryptographically random and looked up by exact match
 * only, and no report, export or aggregate path has any reason to select
 * from them. Flagged in the #4/#6 report for a second (ac-reviewer) look
 * since it is a judgement call rather than a mechanical one.
 */
export const AUTH_SUBSTRATE_TABLES: readonly string[] = [
  'users',
  'sessions',
  'accounts',
  'verification_tokens',
];

/**
 * The exemption predicate the enumeration gate consults.
 *
 * Note what is deliberately *not* here: the isolation harness's scratch-table
 * prefix. Test fixtures are filtered by the test that creates them, not by this
 * function — a production declaration that exempts a name pattern is a hole
 * anyone can walk a real table through by naming it correctly, and this file is
 * precisely the one that must not have holes in it.
 */
export function isSharedTable(tableName: string): boolean {
  return (
    SHARED_TABLES.includes(tableName) ||
    INFRASTRUCTURE_TABLES.includes(tableName) ||
    AUTH_SUBSTRATE_TABLES.includes(tableName) ||
    AUDIT_TABLES.includes(tableName)
  );
}
