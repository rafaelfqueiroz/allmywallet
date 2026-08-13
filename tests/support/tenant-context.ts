import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import type { UserId } from '@/core/shared/ids';

/**
 * TODO(#6): re-implements exactly what `withTenant` (ARCHITECTURE §5) will
 * do — `set_config('app.user_id', ..., true)` inside a transaction — because
 * nothing else exists yet to call. Every SPEC-002 integration/isolation test
 * that writes or reads a `config_overrides` row at level 'tenant' or 'user'
 * needs this: without it, the row falls outside any tenant context and the
 * RLS policy's `WITH CHECK` correctly refuses it (see the migration file's
 * header comment on src/db/migrations/0000_config_layer.sql for why).
 *
 * Deliberately opens its **own** single-use connection rather than borrowing
 * a connection from a shared pool also used for plain (non-transactional)
 * queries in the same test file — reusing one pooled connection across a
 * `db.transaction()` and later unrelated queries was observed to corrupt
 * that connection's parameter binding for the *next* query (Postgres
 * reporting a plain int/text query as failing to parse a uuid it was never
 * given). Isolating each tenant-scoped write/read onto its own connection
 * sidesteps that entirely, at the cost of a fresh connection per call —
 * acceptable here since these are tests, not the request path.
 *
 * Delete this file once `withTenant` exists and switch every caller to it.
 */
export async function withTenantContext<T>(
  connectionString: string,
  userId: UserId,
  fn: (
    tx: Parameters<Parameters<ReturnType<typeof drizzle<typeof schema>>['transaction']>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return fn(tx);
    });
  } finally {
    await pool.end();
  }
}
