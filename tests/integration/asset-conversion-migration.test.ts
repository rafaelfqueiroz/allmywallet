import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migrations `0023_asset_conversions.sql` (#121),
 * `0026_conversion_cash_component.sql` (#143, SPEC-007 BR-007-05b /
 * SPEC-005 BR-005-20c), and `0027_conversion_cash_component_contract.sql`
 * (#143 D12/D13), which contracts 0026's cash-component relaxation back to
 * the exact-cost invariant.
 *
 * TESTING §1: PostgreSQL CHECK semantics, NUMERIC(20,8) precision, index
 * presence, and the widened type constraints are verified against real
 * Postgres rather than a schema mock.
 */
describe('migration 0023 — asset conversions (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let outgoingAssetId: string;
  let incomingAssetId: string;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 5 });
    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    outgoingAssetId = randomUUID();
    incomingAssetId = randomUUID();
    await migratorPool.query(
      `INSERT INTO assets (id, code, name, class)
       VALUES ($1, 'OLD3', 'Old asset', 'stock'), ($2, 'NEW3', 'New asset', 'stock')`,
      [outgoingAssetId, incomingAssetId],
    );
  });

  it('accepts an exact-cost conversion pair and preserves all eight decimal places', async () => {
    const conversionGroupId = randomUUID();

    await withTenant(
      userId,
      async (tx) => {
        for (const [assetId, type] of [
          [outgoingAssetId, 'conversion_out'],
          [incomingAssetId, 'conversion_in'],
        ] as const) {
          await tx.execute(sql`
            INSERT INTO transactions
              (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
               total_value, conversion_group_id, cost_basis, natural_key, occurrence)
            VALUES
              (${randomUUID()}, ${userId}, ${assetId}, ${type}, '2026-09-18', '1',
               '0', '0', '0', ${conversionGroupId}, '123456789012.12345678',
               ${`conversion-${randomUUID()}`}, 1)
          `);
        }
      },
      appDb,
    );

    const result = await migratorPool.query<{
      type: string;
      conversion_group_id: string;
      cost_basis: string | null;
    }>(
      `SELECT type, conversion_group_id, cost_basis
         FROM transactions
        WHERE user_id = $1
        ORDER BY type`,
      [userId],
    );

    expect(result.rows).toEqual([
      {
        type: 'conversion_in',
        conversion_group_id: conversionGroupId,
        cost_basis: '123456789012.12345678',
      },
      {
        type: 'conversion_out',
        conversion_group_id: conversionGroupId,
        cost_basis: '123456789012.12345678',
      },
    ]);
  });

  it('widens import_rows.ledger_type to both conversion types', async () => {
    const batchId = randomUUID();
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status)
       VALUES ($1, $2, 'b3_movimentacao', 'pending')`,
      [batchId, userId],
    );

    for (const ledgerType of ['conversion_out', 'conversion_in'] as const) {
      await withTenant(
        userId,
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO import_rows
              (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id, ledger_type)
            VALUES
              (${randomUUID()}, ${userId}, ${batchId}, '{}'::jsonb, '{}'::jsonb,
               'unclassified', ${outgoingAssetId}, ${ledgerType})
          `);
        },
        appDb,
      );
    }

    const result = await migratorPool.query<{ ledger_type: string }>(
      `SELECT ledger_type FROM import_rows WHERE user_id = $1 ORDER BY ledger_type`,
      [userId],
    );
    expect(result.rows.map((row) => row.ledger_type)).toEqual(['conversion_in', 'conversion_out']);
  });

  it('keeps both type constraints closed to unknown values', async () => {
    await expectConstraintFailure(
      insertTransaction({
        assetId: outgoingAssetId,
        type: 'not_a_real_type',
        conversionGroupId: null,
        costBasis: null,
        totalValue: '0',
      }),
      'transactions_type_check',
    );

    const batchId = randomUUID();
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status)
       VALUES ($1, $2, 'b3_movimentacao', 'pending')`,
      [batchId, userId],
    );
    await expectConstraintFailure(
      withTenant(
        userId,
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO import_rows
              (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id, ledger_type)
            VALUES
              (${randomUUID()}, ${userId}, ${batchId}, '{}'::jsonb, '{}'::jsonb,
               'unclassified', ${outgoingAssetId}, 'not_a_real_type')
          `);
        },
        appDb,
      ),
      'import_rows_ledger_type_check',
    );
  });

  it('keeps previous-version writes valid with both additive columns null', async () => {
    await withTenant(
      userId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO transactions
            (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
             total_value, natural_key, occurrence)
          VALUES
            (${randomUUID()}, ${userId}, ${outgoingAssetId}, 'buy', '2026-09-18', '10',
             '12.34', '0', '123.4', ${`previous-image-${randomUUID()}`}, 1)
        `);
      },
      appDb,
    );

    const result = await migratorPool.query<{
      conversion_group_id: string | null;
      cost_basis: string | null;
    }>('SELECT conversion_group_id, cost_basis FROM transactions WHERE user_id = $1', [userId]);
    expect(result.rows).toEqual([{ conversion_group_id: null, cost_basis: null }]);
  });

  it.each([
    {
      label: 'conversion_in without a group',
      type: 'conversion_in',
      groupId: null,
      costBasis: '10',
      totalValue: '0',
    },
    {
      label: 'conversion_in without allocated cost',
      type: 'conversion_in',
      groupId: randomUUID(),
      costBasis: null,
      totalValue: '0',
    },
    {
      label: 'conversion_in with negative allocated cost',
      type: 'conversion_in',
      groupId: randomUUID(),
      costBasis: '-0.00000001',
      totalValue: '0',
    },
    {
      label: 'conversion_out without exact removed cost',
      type: 'conversion_out',
      groupId: randomUUID(),
      costBasis: null,
      totalValue: '0',
    },
    {
      label: 'conversion_out without a group',
      type: 'conversion_out',
      groupId: null,
      costBasis: '10',
      totalValue: '0',
    },
    {
      label: 'conversion_in carrying cash value',
      type: 'conversion_in',
      groupId: randomUUID(),
      costBasis: '10',
      totalValue: '0.01',
    },
    {
      label: 'conversion_out with a negative cash total_value',
      type: 'conversion_out',
      groupId: randomUUID(),
      costBasis: '10',
      totalValue: '-0.00000001',
    },
    {
      // #143 D12/D13: 0026 let conversion_out carry non-negative cash as a
      // return-of-capital reading of B3's priced Resgate; 0027 removed that
      // capability, so any non-zero total_value on either leg is rejected.
      label: 'conversion_out carrying a positive cash value',
      type: 'conversion_out',
      groupId: randomUUID(),
      costBasis: '10',
      totalValue: '0.00000001',
    },
    {
      label: 'non-conversion row carrying conversion metadata',
      type: 'buy',
      groupId: randomUUID(),
      costBasis: null,
      totalValue: '10',
    },
  ])('rejects $label', async ({ type, groupId, costBasis, totalValue }) => {
    await expectConstraintFailure(
      insertTransaction({
        assetId: outgoingAssetId,
        type,
        conversionGroupId: groupId,
        costBasis,
        totalValue,
      }),
      'transactions_conversion_pairing_check',
    );
  });

  it('rejects an otherwise valid singleton conversion leg at commit', async () => {
    await expectConstraintFailure(
      insertTransaction({
        assetId: outgoingAssetId,
        type: 'conversion_out',
        conversionGroupId: randomUUID(),
        costBasis: '10',
        totalValue: '0',
      }),
      'transactions_conversion_group_atomic_check',
    );
  });

  it('rejects a complete-shaped group whose exact costs do not balance', async () => {
    const groupId = randomUUID();
    await expectConstraintFailure(
      withTenant(
        userId,
        async (tx) => {
          for (const [assetId, type, costBasis] of [
            [outgoingAssetId, 'conversion_out', '10'],
            [incomingAssetId, 'conversion_in', '9.99999999'],
          ] as const) {
            await tx.execute(sql`
              INSERT INTO transactions
                (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
                 total_value, conversion_group_id, cost_basis, natural_key, occurrence)
              VALUES
                (${randomUUID()}, ${userId}, ${assetId}, ${type}, '2026-09-18', '1',
                 '0', '0', '0', ${groupId}, ${costBasis}, ${`conversion-${randomUUID()}`}, 1)
            `);
          }
        },
        appDb,
      ),
      'transactions_conversion_group_atomic_check',
    );
  });

  /**
   * Migration `0027_conversion_cash_component_contract.sql` (#143 D12/D13):
   * 0026 (#149) briefly let a `conversion_out` leg carry B3's priced
   * `Resgate` cash component as a return-of-capital reading of the BPFF11 ->
   * RVBI11 incorporation. The owner decided that case was actually a taxable
   * liquidation (D10) and no code writes a cash-bearing conversion leg any
   * more, so 0027 removed the capability: a non-zero `total_value` on
   * either leg is rejected by the row CHECK regardless of cost balance.
   */
  it('rejects a conversion_out leg carrying a non-zero total_value even when the group balances', async () => {
    const conversionGroupId = randomUUID();

    await expectConstraintFailure(
      withTenant(
        userId,
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO transactions
              (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
               total_value, conversion_group_id, cost_basis, natural_key, occurrence)
            VALUES
              (${randomUUID()}, ${userId}, ${outgoingAssetId}, 'conversion_out', '2026-09-18', '1',
               '10', '0', '10', ${conversionGroupId}, '100', ${`conversion-${randomUUID()}`}, 1),
              (${randomUUID()}, ${userId}, ${incomingAssetId}, 'conversion_in', '2026-09-18', '1',
               '0', '0', '0', ${conversionGroupId}, '100', ${`conversion-${randomUUID()}`}, 1)
          `);
        },
        appDb,
      ),
      'transactions_conversion_pairing_check',
    );
  });

  it('rejects a group with out cost 100 and in cost 90 by the trigger, with no cash term to explain the gap', async () => {
    const groupId = randomUUID();
    await expectConstraintFailure(
      withTenant(
        userId,
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO transactions
              (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
               total_value, conversion_group_id, cost_basis, natural_key, occurrence)
            VALUES
              (${randomUUID()}, ${userId}, ${outgoingAssetId}, 'conversion_out', '2026-09-18', '1',
               '0', '0', '0', ${groupId}, '100', ${`conversion-${randomUUID()}`}, 1),
              (${randomUUID()}, ${userId}, ${incomingAssetId}, 'conversion_in', '2026-09-18', '1',
               '0', '0', '0', ${groupId}, '90', ${`conversion-${randomUUID()}`}, 1)
          `);
        },
        appDb,
      ),
      'transactions_conversion_group_atomic_check',
    );
  });

  it('creates the tenant-and-group lookup index', async () => {
    const result = await migratorPool.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'transactions'
          AND indexname = 'transactions_user_id_conversion_group_id_idx'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toMatch(/\(user_id, conversion_group_id\)/);
  });

  async function insertTransaction(input: {
    assetId: string;
    type: string;
    conversionGroupId: string | null;
    costBasis: string | null;
    totalValue: string;
  }): Promise<void> {
    await withTenant(
      userId,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO transactions
            (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees,
             total_value, conversion_group_id, cost_basis, natural_key, occurrence)
          VALUES
            (${randomUUID()}, ${userId}, ${input.assetId}, ${input.type}, '2026-09-18', '1',
             '0', '0', ${input.totalValue}, ${input.conversionGroupId}, ${input.costBasis},
             ${`conversion-${randomUUID()}`}, 1)
        `);
      },
      appDb,
    );
  }

  async function expectConstraintFailure(
    operation: Promise<void>,
    constraintName: string,
  ): Promise<void> {
    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error).cause as (Error & { constraint?: string }) | undefined;
    expect(cause?.constraint ?? cause?.message ?? (error as Error).message).toContain(
      constraintName,
    );
  }
});
