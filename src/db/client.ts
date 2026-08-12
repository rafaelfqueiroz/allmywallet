import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@/lib/env';
import * as schema from '@/db/schema';

/**
 * The runtime pool connects as `allmywallet_app` — not the table owner, and
 * without `BYPASSRLS` (ARCHITECTURE §5). A table owner bypasses its own RLS
 * policies unless `FORCE ROW LEVEL SECURITY` is set, so both mechanisms are
 * used and neither is relied on alone.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      // The box is a single 2-vCPU VPS (AR-57). A large pool buys nothing and
      // costs Postgres memory that the worker and web process both need.
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export const db = drizzle(getPool(), { schema });

export type Database = typeof db;

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
