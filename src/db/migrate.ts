import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
    console.warn('migrations applied');
  } finally {
    await pool.end();
  }
}

/**
 * SPEC-021 BR-021-13 (AR-73): the image runs this as `node dist/migrate.js`,
 * and `pnpm db:migrate` runs it from source through tsx. The folder is
 * resolved from this file rather than from the working directory, so both
 * find it wherever they are started: `src/db/migrate.ts` sits beside
 * `migrations/`, and the bundle in `dist/` reaches the copy the Dockerfile
 * places at `src/db/migrations/`.
 */
function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === 'dist'
    ? resolve(here, '..', 'src', 'db', 'migrations')
    : resolve(here, 'migrations');
}

main().catch((error: unknown) => {
  console.error('migration failed', error);
  process.exit(1);
});
