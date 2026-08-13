import type { Database } from '@/db/client';

/**
 * A transaction handle or the plain database connection — anything Drizzle
 * hands query-building methods on. Split into its own module so `resolve.ts`
 * and `runtime-state.ts` can both depend on it without depending on each
 * other.
 *
 * Deliberately a `Pick`, not `Database` itself: a real `db.transaction(tx =>
 * ...)` callback parameter is a distinct Drizzle type (`PgTransaction`, no
 * `$client`), and this module needs to accept either one — the plain
 * connection for deployment-level reads/writes, and whatever transaction
 * `withTenant` eventually hands a per-user call site.
 *
 * TODO(#6): once `withTenant` lands, every call site resolving a per-user key
 * must pass the transaction it provides here, not the module-level `db` —
 * that is the only thing that makes `current_setting('app.user_id')` resolve
 * correctly (ARCHITECTURE §5, AR-11).
 */
export type Tx = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
