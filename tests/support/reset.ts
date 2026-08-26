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

/**
 * SPEC-006/SPEC-007 reference data.
 *
 * `assets` and `institutions` are **shared** tables (AR-15), so they carry no
 * `user_id` and `resetUsers`'s cascade does not reach them — a suite that
 * seeded `PETR4` would leave it behind for the next file, whose own insert
 * then trips the `assets_code_unique` constraint. `transactions` and
 * `positions` *are* cascaded by `resetUsers`, but they are truncated here too
 * so a file can reset the ledger without disturbing another suite's tenants.
 *
 * TRUNCATE runs as the migrator, which owns the tables — and `FORCE ROW LEVEL
 * SECURITY` does not apply to TRUNCATE, so no tenant context is needed.
 */
const LEDGER_TABLES = [
  'positions',
  'transactions',
  'import_rows',
  'fixed_income_contracts',
  'import_batches',
  'assets',
  'institutions',
] as const;

export async function resetLedger(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(`TRUNCATE ${LEDGER_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}

/**
 * SPEC-010's three tables, plus SPEC-014's allocation event log.
 * `wallet_allocations` and `wallet_asset_rules` cascade from `wallets` (and
 * from `users` via `resetUsers`), but truncating them explicitly lets a suite
 * reset wallets alone without disturbing another file's ledger fixtures on the
 * shared CI database (TS-03).
 *
 * `wallet_allocation_events` is listed **because it does not cascade from
 * `wallets`** — deleting a wallet must not erase the record that it once held
 * something (SPEC-014 BR-014-12). That is correct for production and makes it
 * the one table here that a `wallets` truncation would leave behind, which on
 * the shared database is a later file's wallet income appearing from nowhere.
 */
const WALLET_TABLES = [
  'wallet_allocation_events',
  'wallet_allocations',
  'wallet_asset_rules',
  // SPEC-017. Ordered before `wallets` like every other child table — the
  // CASCADE would take it anyway, but naming it keeps the list a readable
  // inventory of what a wallet reset actually clears.
  'wallet_targets',
  'wallets',
] as const;

export async function resetWallets(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(`TRUNCATE ${WALLET_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
}

/**
 * SPEC-004's `consents`. Cascades from `resetUsers` already (AR-27), but
 * truncated explicitly for the same reason `resetWallets` is: a suite that
 * only cares about consent state can reset it without disturbing another
 * file's seeded tenants on the shared CI database (TS-03/TS-33/TS-34).
 */
export async function resetConsents(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query('TRUNCATE consents RESTART IDENTITY CASCADE');
  } finally {
    await pool.end();
  }
}
