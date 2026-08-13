/**
 * AR-14: the RLS policy for a tenant-scoped table ships in the same migration
 * that creates the table, and every table gets an *identical* policy — this
 * function is the single place that template is written down, so a migration
 * author copies it rather than retyping (and possibly drifting from) the
 * `USING` / `WITH CHECK` pair.
 *
 * `drizzle-kit generate` does not know about RLS (it only sees the Drizzle
 * schema), so this is always hand-added after reading the generated SQL —
 * never produced automatically.
 */

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Emits the standard tenant-isolation policy SQL for `tableName`. `tableName`
 * is interpolated directly into DDL (Postgres has no bind-parameter form for
 * identifiers), so it is validated against a strict snake_case identifier
 * pattern (AR-24) rather than trusted — this function must never be handed a
 * value that reached the process from outside the migration author's own
 * source.
 */
export function tenantIsolationPolicySql(tableName: string): string {
  if (!IDENTIFIER_PATTERN.test(tableName)) {
    throw new TypeError(`tenantIsolationPolicySql: "${tableName}" is not a snake_case identifier`);
  }
  return [
    `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY tenant_isolation ON ${tableName}`,
    `  USING      (user_id = current_setting('app.user_id')::uuid)`,
    `  WITH CHECK (user_id = current_setting('app.user_id')::uuid);`,
  ].join('\n');
}
