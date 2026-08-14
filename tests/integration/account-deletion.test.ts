import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import {
  resetConfigState,
  resetConsents,
  resetLedger,
  resetUsers,
  resetWallets,
} from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import { isSharedTable } from '@/db/shared-tables';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { transactions } from '@/db/schema/transactions';
import { wallets, walletAllocations } from '@/db/schema/wallets';
import { consents } from '@/db/schema/privacy';
import { configOverrides } from '@/db/schema/config';
import {
  purgeDueAccounts,
  requestAccountDeletion,
  type AccountDeletionDependencies,
} from '@/core/privacy/delete-account';
import { DrizzleAccountDeletionRepository } from '@/adapters/db/account-deletion-repository';
import { DrizzleAuditLogPort } from '@/adapters/db/audit-log';
import { LogNotificationAdapter } from '@/adapters/notifications/log-notification-adapter';

/**
 * SPEC-004 BR-004-09/10 — the AC this issue's Test plan calls the highest
 * value item's companion: not just "the cascade path exists" (the schema-level
 * `tests/isolation/deletion-cascade.test.ts`) but "after the deletion window,
 * no row referencing that user remains in any tenant-scoped table" against
 * real, seeded data across several specs' tables at once.
 *
 * The check that matters here is deliberately enumeration-driven, the same
 * way the schema-level gate is (DL-004-06) — a hardcoded list of "the tables
 * this test happens to know about" would defeat the entire point.
 */
describe('SPEC-004 BR-004-09/10 — account deletion (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-01T00:00:00Z');

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    // TS-03: CI runs every suite against one shared Postgres.
    await resetConsents(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
  });

  afterEach(async () => {
    await resetConsents(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  });

  function privacyDeps(): AccountDeletionDependencies {
    return {
      accountDeletion: new DrizzleAccountDeletionRepository(appDb),
      auditLog: new DrizzleAuditLogPort(appDb),
      notifications: new LogNotificationAdapter(),
      clock,
    };
  }

  /** Every table not declared shared/exempt — the same enumeration `deletion-cascade.test.ts` uses. */
  async function tenantScopedTables(): Promise<string[]> {
    const { rows } = await migratorPool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname = 'public'
       ORDER BY c.relname
    `);
    return rows.map((row) => row.table_name).filter((name) => !isSharedTable(name));
  }

  async function seedAcrossTables(): Promise<void> {
    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    const walletId = WalletId.generate();

    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(transactions).values({
          id: randomUUID(),
          userId,
          assetId: asset.id,
          institutionId: null,
          type: 'buy',
          status: 'active',
          tradeDate: '2026-01-10',
          quantity: Quantity.fromString('100'),
          unitPrice: Money.fromString('30'),
          fees: Money.fromString('0'),
          totalValue: Money.fromString('3000'),
          ratio: null,
          naturalKey: `natkey-${userId}`,
          occurrence: 1,
          importBatchId: null,
          isManual: true,
          isUserModified: false,
        });
        await tx.insert(wallets).values({
          id: walletId,
          userId,
          name: 'Aposentadoria',
          description: null,
          goal: null,
          color: null,
        });
        await tx.insert(walletAllocations).values({
          id: randomUUID(),
          userId,
          walletId,
          assetId: asset.id,
          quantity: Quantity.fromString('50'),
          costBasisAtAllocation: Money.fromString('1500'),
          allocatedAt: new Date(),
        });
        await tx.insert(consents).values({
          id: randomUUID(),
          userId,
          purpose: 'email_reminders',
          grantedAt: new Date(),
          revokedAt: null,
          policyVersion: 'v1',
        });
        await tx.insert(configOverrides).values({
          id: randomUUID(),
          key: 'reports.default_grouping',
          level: 'user',
          userId,
          value: 'asset',
        });
      },
      appDb,
    );
  }

  it('AC — access is revoked immediately: session rows are deleted at request time', async () => {
    await migratorPool.query(
      `INSERT INTO sessions (session_token, user_id, expires) VALUES ($1, $2, now() + interval '1 day')`,
      [randomUUID(), userId],
    );

    const result = await requestAccountDeletion(privacyDeps(), userId, { deletionWindowDays: 30 });
    expect(result.ok).toBe(true);

    const { rows } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1',
      [userId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('AC — after the deletion window, no row referencing that user remains in any tenant-scoped table', async () => {
    await seedAcrossTables();

    const requested = await requestAccountDeletion(privacyDeps(), userId, {
      deletionWindowDays: 7,
    });
    expect(requested.ok).toBe(true);

    // Not yet due — nothing purged, every seeded row still present.
    const tooEarly = await purgeDueAccounts(privacyDeps(), clock.now(), 30);
    expect(tooEarly.purged).toHaveLength(0);

    clock.advanceMinutes(7 * 24 * 60 + 1);
    const outcome = await purgeDueAccounts(privacyDeps(), clock.now(), 7);
    expect(outcome.purged).toEqual([userId]);
    expect(outcome.failed).toHaveLength(0);

    const tables = await tenantScopedTables();
    const leftBehind: string[] = [];
    for (const table of tables) {
      const { rows } = await migratorPool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
        [userId],
      );
      if (Number(rows[0]?.n) > 0) leftBehind.push(table);
    }
    expect(leftBehind, 'tables still referencing the deleted user').toEqual([]);

    const { rows: userRows } = await migratorPool.query(
      'SELECT id FROM users WHERE id = $1',
      [userId],
    );
    expect(userRows).toHaveLength(0);
  });

  it('BR-004-15/17-adjacent: the audit_log rows for this account survive the purge — the trail outlives the account', async () => {
    await seedAcrossTables();
    await requestAccountDeletion(privacyDeps(), userId, { deletionWindowDays: 1 });
    clock.advanceMinutes(2 * 24 * 60);
    await purgeDueAccounts(privacyDeps(), clock.now(), 1);

    const { rows } = await migratorPool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'account.deletion.requested',
      'account.deletion.purged',
    ]);
  });

  it('refuses a second deletion request while one is pending, end to end', async () => {
    await requestAccountDeletion(privacyDeps(), userId, { deletionWindowDays: 30 });
    const second = await requestAccountDeletion(privacyDeps(), userId, { deletionWindowDays: 30 });
    expect(second.ok).toBe(false);
  });

  it('two tenants are independent: purging one due account never touches an unrelated, not-yet-due one', async () => {
    const otherUser = UserId.generate();
    await seedUser(testDb.migrationUrl, otherUser);

    // `deletionWindowDays` on the *request* only shapes the confirmation
    // message/audit entry (`RequestAccountDeletionOutcome.purgeAt`) —
    // `retention.deletion_window_days` is a single deployment-level config
    // key (SPEC-002), so every account is actually swept against the same
    // window at purge time. "Not yet due" here means "requested more
    // recently relative to that one shared window," not "requested with a
    // longer window" — the two accounts below both pass 30 for that reason.
    await requestAccountDeletion(privacyDeps(), userId, { deletionWindowDays: 30 });
    clock.advanceMinutes(20 * 24 * 60);
    await requestAccountDeletion(privacyDeps(), otherUser, { deletionWindowDays: 30 });
    clock.advanceMinutes(15 * 24 * 60);

    // cutoff = now - 30d = (userId's request + 35d) - 30d = userId's request + 5d → userId is due.
    // otherUser's request is 20d + 15d = 35d ago minus... requested 20d after
    // userId, so only 15d before `asOf` — inside the 30-day window, not due.
    const outcome = await purgeDueAccounts(privacyDeps(), clock.now(), 30);
    expect(outcome.purged).toEqual([userId]);

    const { rows } = await migratorPool.query('SELECT id FROM users WHERE id = $1', [otherUser]);
    expect(rows).toHaveLength(1);

    await migratorPool.query('DELETE FROM users WHERE id = $1', [otherUser]);
  });
});
