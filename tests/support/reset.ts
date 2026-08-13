import { Pool } from 'pg';

/**
 * TS-03: every test is independent and order-agnostic.
 *
 * That property came for free while each suite file started its own
 * Testcontainer, and vanished the moment the suites ran against one reused
 * database — a CI service container. The failure it produced was worth reading
 * carefully: a `runtime_state` row written by one file made a *different*
 * file's deployment-level write appear not to take effect, because runtime
 * state legitimately outranks operator config (BR-002-05). Nothing was wrong
 * with either test or with the code; they were simply sharing a database and
 * assuming they were not.
 *
 * Truncating rather than dropping keeps the schema — and therefore the RLS
 * policies — exactly as the migrations left them, which is the thing the
 * isolation suite is there to exercise.
 */
const CONFIG_TABLES = ['config_overrides', 'runtime_state', 'audit_log'] as const;

export async function resetConfigState(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(`TRUNCATE ${CONFIG_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}

/**
 * Tenant roots seeded by other suites. Cascades into every tenant-scoped table,
 * which is exactly what AR-27 promises and a convenient way to prove it still
 * holds.
 */
export async function resetUsers(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query('TRUNCATE users RESTART IDENTITY CASCADE');
  } finally {
    await pool.end();
  }
}
