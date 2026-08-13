import { sql } from 'drizzle-orm';
import { db, type Database } from '@/db/client';
import type { UserId } from '@/core/shared/ids';

/**
 * ARCHITECTURE §5 / SPEC-003 BR-003-04: tenant context is set from the
 * authenticated session at the start of a transaction, never from a
 * client-supplied parameter. `withTenant` is the *only* sanctioned entry
 * point for a tenant-scoped query — a raw `db.` call in a request path is a
 * defect, not a style preference (AR-11).
 *
 * Derived from `Database['transaction']` itself rather than naming Drizzle's
 * internal transaction generic directly, so this stays correct across
 * drizzle-orm versions without tracking their type names.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * AR-11/AR-13: runs `fn` inside a transaction with `app.user_id` set via
 * `set_config(..., true)` — the third argument is what makes the setting
 * transaction-scoped rather than session-scoped. That matters specifically
 * because the pool is shared: without `true`, a connection released back to
 * the pool after this transaction would carry tenant A's context into
 * whichever request the pool hands that connection to next. Session-level
 * `SET` is prohibited for exactly this reason.
 *
 * A query that runs outside `withTenant` is not merely unfiltered — it fails.
 * Every tenant table's policy reads `current_setting('app.user_id')` with no
 * default, so a connection that never called `set_config` raises
 * "unrecognized configuration parameter" rather than returning every tenant's
 * rows (TS-16). RLS fails closed.
 */
export async function withTenant<T>(
  userId: UserId,
  fn: (tx: Tx) => Promise<T>,
  database: Database = db,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
