import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset, seedImportBatch } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import { fixedIncomeContracts, importRows } from '@/db/schema/import-rows';
import { withTenant } from '@/db/tenant';
import { FixedIncomeContractId, ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import type { AssetId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';

/**
 * SPEC-005 (#8) / TS-13-15 — `import_rows` and `fixed_income_contracts` are
 * tenant-scoped, and the enumeration gate (`tests/isolation/enumeration.test.ts`)
 * blocks a merge until each is named by an isolation test. This is that test.
 *
 * `import_rows` deserves the same scrutiny as `positions` and
 * `daily_valuation_snapshots` for the same reason it is tempting to
 * underweight: it is provenance, not a "real" figure — but `raw_payload`
 * carries a stripped-but-otherwise-verbatim row from someone's B3 extract,
 * which is exactly the kind of record a leak would be most damaging to
 * expose (SPEC-004 BR-004-02's whole reason for existing).
 */
describe('SPEC-005 — import_rows and fixed_income_contracts tenant isolation', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const batchA = ImportBatchId.generate();
  const batchB = ImportBatchId.generate();
  let assetA: AssetId;
  let assetB: AssetId;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: CI runs every suite against one shared Postgres, so another file
    // may have left rows behind.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);
    await seedImportBatch(testDb.migrationUrl, userA, batchA);
    await seedImportBatch(testDb.migrationUrl, userB, batchB);

    const petr = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    const vale = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');
    assetA = petr.id;
    assetB = vale.id;

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) =>
        tx.insert(importRows).values({
          id: ImportRowId.generate(),
          userId: userA,
          batchId: batchA,
          rawPayload: { Produto: 'PETR4 A ROW' },
          parsedPayload: { kind: 'transaction', assetCode: 'PETR4' },
          classification: 'new',
          assetId: assetA,
          naturalKey: 'a-row-key',
          occurrence: 1,
          ledgerType: 'buy',
        }),
      appDb,
    );
    await withTenant(
      userB,
      async (tx) =>
        tx.insert(importRows).values({
          id: ImportRowId.generate(),
          userId: userB,
          batchId: batchB,
          rawPayload: { Produto: 'VALE3 B ROW' },
          parsedPayload: { kind: 'transaction', assetCode: 'VALE3' },
          classification: 'new',
          assetId: assetB,
          naturalKey: 'b-row-key',
          occurrence: 1,
          ledgerType: 'buy',
        }),
      appDb,
    );

    await withTenant(
      userA,
      async (tx) =>
        tx.insert(fixedIncomeContracts).values({
          id: FixedIncomeContractId.generate(),
          userId: userA,
          assetId: assetA,
          indexer: 'cdi_percent',
          rate: Quantity.fromString('110'),
          issueDate: '2024-01-01',
        }),
      appDb,
    );
    await withTenant(
      userB,
      async (tx) =>
        tx.insert(fixedIncomeContracts).values({
          id: FixedIncomeContractId.generate(),
          userId: userB,
          assetId: assetB,
          indexer: 'prefixado',
          rate: Quantity.fromString('12.5'),
          issueDate: '2024-06-01',
        }),
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered import_rows read returns only A’s row', async () => {
    // No WHERE user_id anywhere — the policy is what constrains this.
    const rows = await withTenant(userA, async (tx) => tx.select().from(importRows), appDb);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA);
    expect(rows[0]?.naturalKey).toBe('a-row-key');
    expect(rows.some((row) => row.naturalKey === 'b-row-key')).toBe(false);
  });

  it('as tenant A, an unfiltered fixed_income_contracts read returns only A’s contract', async () => {
    const rows = await withTenant(
      userA,
      async (tx) => tx.select().from(fixedIncomeContracts),
      appDb,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA);
    expect(rows[0]?.rate?.toString()).toBe('110');
    expect(rows.some((row) => row.rate?.toString() === '12.5')).toBe(false);
  });

  it('an aggregate over import_rows cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM import_rows`),
      appDb,
    );
    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  it('tenant A cannot insert an import_rows row attributed to tenant B', async () => {
    // 42501 = insufficient_privilege — the WITH CHECK half.
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(importRows).values({
            id: ImportRowId.generate(),
            userId: userB,
            batchId: batchA,
            rawPayload: {},
            parsedPayload: { kind: 'transaction' },
            classification: 'new',
            assetId: assetA,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot insert a fixed_income_contracts row attributed to tenant B', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(fixedIncomeContracts).values({
            id: FixedIncomeContractId.generate(),
            userId: userB,
            assetId: assetA,
            issueDate: '2024-01-01',
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(importRows)).rejects.toThrow();
    await expect(appDb.select().from(fixedIncomeContracts)).rejects.toThrow();
  });

  it('both tables have ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname IN ('import_rows', 'fixed_income_contracts')
             AND relnamespace = 'public'::regnamespace
           ORDER BY relname`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('both tables have a policy covering reads and writes', async () => {
    const result = await migratorDb.execute(
      sql`SELECT tablename, qual, with_check FROM pg_policies
           WHERE schemaname = 'public' AND tablename IN ('import_rows', 'fixed_income_contracts')`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      tablename: string;
      qual: string | null;
      with_check: string | null;
    }>;
    for (const table of ['import_rows', 'fixed_income_contracts']) {
      expect(
        rows.some((r) => r.tablename === table && r.qual !== null && r.with_check !== null),
        table,
      ).toBe(true);
    }
  });

  it('deleting the tenant root removes both, so account deletion is complete', async () => {
    // AR-27: the ON DELETE CASCADE is load-bearing for SPEC-004.
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);
    const doomedBatch = ImportBatchId.generate();
    await seedImportBatch(testDb.migrationUrl, doomed, doomedBatch);

    await withTenant(
      doomed,
      async (tx) => {
        await tx.insert(importRows).values({
          id: ImportRowId.generate(),
          userId: doomed,
          batchId: doomedBatch,
          rawPayload: {},
          parsedPayload: { kind: 'transaction' },
          classification: 'new',
          assetId: assetA,
        });
        await tx.insert(fixedIncomeContracts).values({
          id: FixedIncomeContractId.generate(),
          userId: doomed,
          assetId: assetA,
          issueDate: '2024-01-01',
        });
      },
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows: rowsAfter } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM import_rows WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rowsAfter[0]?.n)).toBe(0);

    const { rows: contractsAfter } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM fixed_income_contracts WHERE user_id = $1',
      [doomed],
    );
    expect(Number(contractsAfter[0]?.n)).toBe(0);
  });
});
