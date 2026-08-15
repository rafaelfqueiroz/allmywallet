/**
 * Give `allmywallet_app` the password the app is configured to connect with.
 *
 * `0000_roles.sql` creates the role with `LOGIN` and deliberately **no**
 * password — a migration must never hardcode a credential. Production supplies
 * one out of band (docker-compose's `POSTGRES_*`, the VPS `.env`), and the
 * Vitest suites supply one through `tests/support/postgres.ts`'s
 * `ensureAppRole`.
 *
 * Neither covers a CI job that boots the **real server** against a service
 * container: the E2E and visual suites do exactly that, and every connection
 * failed with `28P01 password authentication failed` at startup.
 *
 * The password is read from `DATABASE_URL` rather than hardcoded, so this
 * aligns the role with whatever the app was told to use instead of inventing a
 * second source of truth. Test and CI contexts only — it is not part of any
 * deploy path.
 */
import { Pool } from 'pg';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const appUrl = process.env.DATABASE_URL;

if (!migrationUrl || !appUrl) {
  throw new Error('provision-app-role: DATABASE_MIGRATION_URL and DATABASE_URL are both required');
}

const parsed = new URL(appUrl);
const role = decodeURIComponent(parsed.username);
const password = decodeURIComponent(parsed.password);

if (!role || !password) {
  throw new Error('provision-app-role: DATABASE_URL carries no user or password');
}

// The role name reaches SQL as an identifier and cannot be parameterised, so it
// is constrained instead. The password *is* parameterised, below.
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  throw new Error(`provision-app-role: refusing an unexpected role name "${role}"`);
}

const pool = new Pool({ connectionString: migrationUrl, max: 1 });

try {
  /*
   * Three steps rather than one `DO` block: a DO block takes no bind
   * parameters, so the password would have to be concatenated into its body —
   * an injection waiting for a password containing a quote. Instead the
   * *statement* is built by `format(%I, %L)` server-side, where the quoting is
   * Postgres' own, and only then executed.
   *
   * CREATE/ALTER ROLE are utility statements and cannot be parameterised
   * directly, which is why this dance is necessary at all.
   */
  const existing = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const action = existing.rowCount === 0 ? 'CREATE ROLE %I' : 'ALTER ROLE %I WITH';

  // The casts are not decoration: `format`'s arguments are `variadic "any"`, so
  // without them Postgres cannot infer a type for the parameters and rejects
  // the statement with 42P18.
  const built = await pool.query<{ stmt: string }>(
    `SELECT format('${action} LOGIN NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS stmt`,
    [role, password],
  );

  const statement = built.rows[0]?.stmt;
  if (!statement) throw new Error('provision-app-role: could not build the role statement');

  await pool.query(statement);

  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
  );
  await pool.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  );

  console.warn(`provision-app-role: ${role} ready`);
} finally {
  await pool.end();
}
