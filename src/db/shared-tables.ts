/**
 * AR-15 / SPEC-003 BR-003-06: shared reference tables hold no personal data and
 * are exempt from tenant scoping **by explicit declaration**.
 *
 * The declaration is the point. The enumeration gate (`tests/isolation/`) treats
 * every table *not* on this list as tenant-scoped and fails if it lacks
 * `user_id`, lacks `FORCE ROW LEVEL SECURITY`, or has no isolation test. So
 * adding a table here is a deliberate, reviewable act of saying "this holds
 * nothing personal" — rather than a table quietly escaping the boundary by
 * being forgotten.
 */
export const SHARED_TABLES: readonly string[] = [
  'assets',
  'institutions',
  'price_quotes',
  'latest_quotes',
  'index_series',
];

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

export function isSharedTable(tableName: string): boolean {
  return SHARED_TABLES.includes(tableName) || INFRASTRUCTURE_TABLES.includes(tableName);
}
