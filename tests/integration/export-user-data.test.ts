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
import { withTenant } from '@/db/tenant';
import { UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { transactions } from '@/db/schema/transactions';
import { wallets, walletAllocations } from '@/db/schema/wallets';
import { fixedIncomeContracts } from '@/db/schema/import-rows';
import { configOverrides } from '@/db/schema/config';
import { grantConsent } from '@/core/privacy/consent';
import { exportUserData, exportUserDataAsCsv, exportUserDataAsJson } from '@/core/privacy/export-user-data';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleAuditLogPort } from '@/adapters/db/audit-log';
import { DrizzlePersonalDataExportRepository } from '@/adapters/db/personal-data-export-repository';
import { FakeAccountDeletionPort, FakeNotificationPort } from '@/core/privacy/test-support/fake-repositories';
import { SystemClock } from '@/core/shared/clock';

/**
 * SPEC-004 BR-004-11 — the AC that matters here is "a user exports all their
 * data self-service and receives valid JSON and CSV covering profile,
 * transactions, wallets, allocations and consents", exercised through the
 * real Drizzle adapters and RLS, not fakes — this is where a join that
 * silently drops a row, or a `withTenant` that was forgotten, would actually
 * show up.
 */
describe('SPEC-004 BR-004-11 — exportUserData (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();

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
    await resetConsents(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId, 'exportado@example.com', 'Exportado Teste');
  });

  afterEach(async () => {
    await resetConsents(testDb.migrationUrl);
    await resetWallets(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  });

  async function withPrivacyDeps<T>(fn: (deps: PrivacyDependencies) => Promise<T>): Promise<T> {
    return withTenant(
      userId,
      async (tx) => {
        const deps: PrivacyDependencies = {
          consents: new DrizzleConsentRepository(tx, userId),
          auditLog: new DrizzleAuditLogPort(tx),
          exportData: new DrizzlePersonalDataExportRepository(tx),
          accountDeletion: new FakeAccountDeletionPort(),
          notifications: new FakeNotificationPort(),
          clock: new SystemClock(),
        };
        return fn(deps);
      },
      appDb,
    );
  }

  it('AC — a full export covers profile, transactions, wallets, allocations, fixed-income contracts and consents', async () => {
    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    const cdb = await seedAsset(testDb.migrationUrl, 'CDB Banco X', 'CDB Banco X', 'cdb');
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
          naturalKey: `natkey-export-${userId}`,
          occurrence: 1,
          importBatchId: null,
          isManual: true,
          isUserModified: false,
        });
        await tx.insert(wallets).values({
          id: walletId,
          userId,
          name: 'Aposentadoria',
          description: 'Fundo de longo prazo',
          goal: 'Longo prazo',
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
        await tx.insert(fixedIncomeContracts).values({
          id: randomUUID(),
          userId,
          assetId: cdb.id,
          indexer: 'cdi_percent',
          rate: Quantity.fromString('110'),
          issueDate: '2024-01-01',
          maturityDate: null,
          principal: Money.fromString('5000'),
          source: null,
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

    await withPrivacyDeps((deps) => grantConsent(deps, userId, { purpose: 'email_reminders', policyVersion: 'v1' }));

    const data = await withPrivacyDeps((deps) => exportUserData(deps, userId));

    expect(data).not.toBeNull();
    if (data === null) return;
    expect(data.profile.email).toBe('exportado@example.com');
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]?.assetCode).toBe('PETR4');
    expect(data.transactions[0]?.unitPrice.toString()).toBe('30');
    expect(data.wallets).toHaveLength(1);
    expect(data.wallets[0]?.name).toBe('Aposentadoria');
    expect(data.allocations).toHaveLength(1);
    expect(data.allocations[0]?.assetCode).toBe('PETR4');
    expect(data.fixedIncomeContracts).toHaveLength(1);
    expect(data.fixedIncomeContracts[0]?.ratePercent?.toString()).toBe('110');
    expect(data.consents).toHaveLength(1);
    expect(data.consents[0]?.purpose).toBe('email_reminders');
    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0]?.key).toBe('reports.default_grouping');

    // AC: round-trips as valid JSON and CSV.
    const json = exportUserDataAsJson(data);
    expect(() => JSON.parse(json)).not.toThrow();
    const csv = exportUserDataAsCsv(data);
    expect(csv).toContain('PETR4');
    expect(csv).toContain('Aposentadoria');
    expect(csv).toContain('email_reminders');
  });

  it('never crosses the tenant boundary — a second tenant’s data never appears in this tenant’s export', async () => {
    const otherUser = UserId.generate();
    await seedUser(testDb.migrationUrl, otherUser, 'outro@example.com', 'Outro Usuario');
    const asset = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');

    await withTenant(
      otherUser,
      async (tx) => {
        await tx.insert(transactions).values({
          id: randomUUID(),
          userId: otherUser,
          assetId: asset.id,
          institutionId: null,
          type: 'buy',
          status: 'active',
          tradeDate: '2026-01-10',
          quantity: Quantity.fromString('10'),
          unitPrice: Money.fromString('60'),
          fees: Money.fromString('0'),
          totalValue: Money.fromString('600'),
          ratio: null,
          naturalKey: `natkey-other-${otherUser}`,
          occurrence: 1,
          importBatchId: null,
          isManual: true,
          isUserModified: false,
        });
      },
      appDb,
    );

    const data = await withPrivacyDeps((deps) => exportUserData(deps, userId));
    expect(data?.transactions).toHaveLength(0);

    await migratorPool.query('DELETE FROM users WHERE id = $1', [otherUser]);
  });
});
