import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * TESTING §1: three things cannot be tested against a mock, and are therefore
 * tested against real Postgres — RLS policies, `NUMERIC` ⇄ `Decimal`
 * round-tripping, and migration correctness. Mocking the database would mock
 * away the thing under test.
 *
 * The container is started once per suite file and reused; starting one per
 * test would put the isolation gate somewhere nobody wants to run it.
 *
 * Reuses an already-running Postgres when `DATABASE_MIGRATION_URL` is set, which
 * is how CI's service container is used without paying for Docker-in-Docker.
 */
export interface TestDatabase {
  /** Connects as `allmywallet_migrator` — owns the tables, may run DDL. */
  readonly migrationUrl: string;
  /** Connects as `allmywallet_app` — not the owner, no BYPASSRLS (AR-11). */
  readonly appUrl: string;
  readonly stop: () => Promise<void>;
}

const APP_ROLE = 'allmywallet_app';
const APP_PASSWORD = 'allmywallet';

export async function startTestDatabase(): Promise<TestDatabase> {
  const existing = process.env.DATABASE_MIGRATION_URL;
  if (existing) {
    const appUrl = process.env.DATABASE_URL ?? existing;
    await ensureAppRole(existing, appUrl);
    return { migrationUrl: existing, appUrl, stop: async () => {} };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('allmywallet')
    .withUsername('allmywallet_migrator')
    .withPassword('allmywallet')
    .start();

  const migrationUrl = container.getConnectionUri();
  const appUrl = migrationUrl.replace(
    'allmywallet_migrator:allmywallet',
    `${APP_ROLE}:${APP_PASSWORD}`,
  );
  await ensureAppRole(migrationUrl, appUrl);

  return {
    migrationUrl,
    appUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * The restricted runtime role. Created here rather than assumed, so a test run
 * against a bare container exercises the same two-role split production uses —
 * a table owner bypasses its own policies unless FORCE is set, and the whole
 * isolation gate is meaningless if tests connect as the owner.
 *
 * The password is set unconditionally, not only on creation, because the role
 * legitimately arrives by two routes and only one of them supplies one.
 * `0000_roles.sql` creates it with `LOGIN` and no password — correct, since a
 * migration must never hardcode a credential — so whichever ran first used to
 * win: Testcontainers locally (helper first, password set) versus a CI service
 * container (migrations first, no password, then `28P01` on every connection).
 * A test-only password applied every time makes the two orders agree.
 */
async function ensureAppRole(migrationUrl: string, _appUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS;
        ELSE
          ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    );
  } finally {
    await pool.end();
  }
}

/** Applies every committed migration. TS-03: each suite gets a known schema. */
export async function applyMigrations(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './src/db/migrations' });
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
  } finally {
    await pool.end();
  }
}
