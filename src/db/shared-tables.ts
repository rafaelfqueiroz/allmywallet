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
 * which is the actual mitigation. Two consequences belong to SPEC-004 (#7) and
 * are raised on that issue rather than settled here: retention
 * (`retention.audit_months`, BR-004-15) and whether a deleted account's audit
 * rows are purged, anonymised or kept — which cannot be answered by a table
 * with no foreign key to `users`.
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
