import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * DV-25: migrations run as a separate, gated step before containers restart. A
 * failed migration aborts the deploy and leaves the running version untouched —
 * which is only safe because AR-23 makes them forward-only and DV-27 makes them
 * expand/contract.
 *
 * Connects as `allmywallet_migrator`: the runtime role has no DDL rights, and
 * that is the point.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_MIGRATION_URL (or DATABASE_URL) must be set to run migrations.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './src/db/migrations' });
    console.warn('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed', error);
  process.exit(1);
});
