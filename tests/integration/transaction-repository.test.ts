import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { TransactionId, UserId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { createTransaction } from '@/core/ledger/create-transaction';
import { deleteTransaction } from '@/core/ledger/delete-transaction';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { exportTransactionsCsv } from '@/core/ledger/export-transactions';
import { listTransactions } from '@/core/ledger/list-transactions';
import { rebuildPositions } from '@/core/positions/rebuild';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedAsset, seedImportBatch, seedInstitution } from '../support/ledger-fixtures';
import { seedUser } from '../support/users';

/**
 * SPEC-006/SPEC-007 against **real Postgres**. Three things cannot be tested
 * against a mock (TESTING §1) and all three are here: the RLS-scoped query
 * path, `NUMERIC(20,8)` ⇄ `Money` round-tripping through the ledger, and the
 * migration itself.
 *
 * TS-03: the database is shared across suite files in CI, so this file
 * truncates what it depends on in `beforeAll` and re-seeds per test.
 */
describe('SPEC-006 — transaction ledger (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-06-30T12:00:00Z');

  let petr4: AssetId;
  let vale3: AssetId;
  let hglg11: AssetId;
  let clear: InstitutionId;
  let rico: InstitutionId;
  const batchId = '0198b3c0-0000-7000-8000-000000000001';

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);

    petr4 = (await seedAsset(testDb.migrationUrl, 'PETR4', 'Petróleo Brasileiro PN')).id;
    vale3 = (await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON')).id;
    hglg11 = (await seedAsset(testDb.migrationUrl, 'HGLG11', 'CSHG Logística FII', 'fii')).id;
    clear = await seedInstitution(testDb.migrationUrl, 'Clear');
    rico = await seedInstitution(testDb.migrationUrl, 'Rico');
    await seedImportBatch(testDb.migrationUrl, userId, batchId);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    // Owner connection, for asserting what the driver hands back for NUMERIC
    // without RLS in the way.
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    // Only the ledger rows — the seeded assets, institutions, batch and user
    // stay, so each test starts from a known empty ledger without re-seeding
    // reference data that other tests share.
    const pool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    try {
      // CASCADE: SPEC-005's `import_rows.transaction_id` references
      // `transactions.id`, so a plain TRUNCATE of `transactions` alone fails
      // once that table exists — cascading here only ever reaches
      // `import_rows` (empty in every test in this file, which never
      // exercises SPEC-005) plus `positions`, already named explicitly.
      // `wallet_allocations` joins the list because BR-006-08's wallet filter
      // resolves through it: a stale allocation left by one test would silently
      // widen the next one's filter.
      await pool.query(
        'TRUNCATE positions, transactions, wallet_allocations, wallets RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  });

  /** Everything runs inside `withTenant` — AR-11, no exceptions. */
  async function asTenant<T>(
    fn: (deps: {
      transactions: DrizzleTransactionRepository;
      positions: DrizzlePositionRepository;
      clock: FakeClock;
    }) => Promise<T>,
  ): Promise<T> {
    return withTenant(
      userId,
      async (tx) =>
        fn({
          transactions: new DrizzleTransactionRepository(tx, userId),
          positions: new DrizzlePositionRepository(tx, userId),
          clock,
        }),
      appDb,
    );
  }

  describe('NUMERIC(20,8) ⇄ Money through the ledger', () => {
    it('round-trips the eighth decimal place exactly', async () => {
      // The last digit the column holds. Truncation here is silent data loss,
      // and it is exactly what a `Number()` in the driver path would cause.
      const stored = await asTenant(async (deps) => {
        const created = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('0.00000001'),
          unitPrice: Money.fromString('99999.99999999'),
          fees: Money.fromString('0.00000001'),
        });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('create failed');
        return deps.transactions.findById(created.value.transaction.id);
      });

      expect(stored?.quantity.toString()).toBe('0.00000001');
      expect(stored?.unitPrice.toString()).toBe('99999.99999999');
      expect(stored?.fees.toString()).toBe('0.00000001');
      // Hand-computed, fees included — the earlier version of this assertion
      // rounded the gross and then forgot to add the fee, which is precisely
      // the mistake the column exists to make visible:
      //   gross = 0,00000001 × 99999,99999999 = 0,0009999999999999
      //   + fees 0,00000001                   = 0,0010000099999999
      //   NUMERIC(20,8) keeps eight places    = 0,00100001
      // The loss is real and asserted here rather than surfacing in a
      // reconciliation six months on. Note Money.toString() emits the canonical
      // decimal, not the column's zero-padded form.
      expect(stored?.totalValue.toString()).toBe('0.00100001');
    });

    it('never hands a JS number back from the driver', async () => {
      // AR-07's seam. The write gets its own transaction: an earlier version of
      // this test ran a best-effort raw-SQL probe inside the *same* withTenant
      // call, and when the probe threw, the transaction rolled back and took
      // the write with it — the assertion then failed on an empty table rather
      // than on the thing under test.
      await asTenant(async (deps) =>
        createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('3'),
          unitPrice: Money.fromString('0.1'),
          fees: Money.zero(),
        }),
      );

      // What `pg` actually hands back for a NUMERIC column: a string. This is
      // the fact the custom type depends on, and the reason a `Number()`
      // anywhere in the driver path would be silent corruption.
      const probe = await migratorPool.query<{ total_value: string }>(
        'SELECT total_value FROM transactions ORDER BY created_at DESC LIMIT 1',
      );
      expect(typeof probe.rows[0]?.total_value).toBe('string');
      expect(probe.rows[0]?.total_value).toBe('0.30000000');

      const readBack = await asTenant((deps) => deps.transactions.listAll());
      // 3 × 0,1 is 0,30000000000000004 in IEEE-754; exactly 0,3 here.
      // Money.toString() emits the canonical decimal, not the padded column form.
      expect(readBack[0]?.totalValue.toString()).toBe('0.3');
      expect(typeof readBack[0]?.totalValue).not.toBe('number');
    });

    it('AR-29 — trade_date survives as a date, with no timezone shift', async () => {
      // The off-by-one this guards against moves a trade across a period
      // boundary and corrupts every report at the edges.
      const stored = await asTenant(async (deps) => {
        const created = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-01'),
          quantity: Quantity.fromString('1'),
          unitPrice: Money.fromString('10'),
          fees: Money.zero(),
        });
        if (!created.ok) throw new Error('create failed');
        return deps.transactions.findById(created.value.transaction.id);
      });
      expect(stored?.tradeDate).toBe('2026-01-01');
    });
  });

  describe('BR-006-04 — the natural key constraint is enforced by the database', () => {
    it('allows two genuinely identical same-day trades via the occurrence counter', async () => {
      const rows = await asTenant(async (deps) => {
        for (let i = 0; i < 2; i += 1) {
          const result = await createTransaction(deps, userId, {
            assetId: petr4,
            institutionId: clear,
            type: 'buy',
            tradeDate: BusinessDate.of('2026-01-05'),
            quantity: Quantity.fromString('100'),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
          expect(result.ok).toBe(true);
        }
        return deps.transactions.listAll();
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.occurrence).sort()).toEqual([1, 2]);
    });

    it('rejects a duplicate (natural_key, occurrence) at the constraint', async () => {
      // The application's `nextOccurrence` is a read-then-write and therefore
      // racy; the UNIQUE constraint is what actually holds the invariant.
      await expect(
        asTenant(async (deps) => {
          const created = await createTransaction(deps, userId, {
            assetId: petr4,
            institutionId: clear,
            type: 'buy',
            tradeDate: BusinessDate.of('2026-01-05'),
            quantity: Quantity.fromString('100'),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
          if (!created.ok) throw new Error('create failed');
          // Re-insert the same row verbatim, bypassing nextOccurrence.
          await deps.transactions.insert({
            ...created.value.transaction,
            id: TransactionId.generate(),
          });
        }),
      ).rejects.toThrow();
    });
  });

  describe('BR-006-07/08/09 — list, filter and search', () => {
    async function seedHistory() {
      return asTenant(async (deps) => {
        const rows = [
          {
            asset: petr4,
            institution: clear,
            date: '2026-01-05',
            type: 'buy' as const,
            qty: '100',
          },
          { asset: petr4, institution: rico, date: '2026-02-05', type: 'buy' as const, qty: '50' },
          { asset: vale3, institution: clear, date: '2026-03-05', type: 'buy' as const, qty: '30' },
          {
            asset: hglg11,
            institution: clear,
            date: '2026-04-05',
            type: 'buy' as const,
            qty: '10',
          },
        ];
        for (const row of rows) {
          const result = await createTransaction(deps, userId, {
            assetId: row.asset,
            institutionId: row.institution,
            type: row.type,
            tradeDate: BusinessDate.of(row.date),
            quantity: Quantity.fromString(row.qty),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
          expect(result.ok).toBe(true);
        }
      });
    }

    /**
     * BR-006-08's wallet dimension. Inserted as the migrator because wallets
     * and allocations are this file's *fixture*, not its subject — the filter
     * itself is exercised through `withTenant` like everything else, so the
     * RLS-scoped subquery is what is actually under test.
     */
    async function seedWalletHolding(
      name: string,
      assetIds: readonly AssetId[],
    ): Promise<WalletId> {
      const pool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
      const walletId = WalletId.generate();
      try {
        await pool.query('INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)', [
          walletId,
          userId,
          name,
        ]);
        for (const assetId of assetIds) {
          await pool.query(
            `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
             VALUES (gen_random_uuid(), $1, $2, $3, '1')`,
            [userId, walletId, assetId],
          );
        }
      } finally {
        await pool.end();
      }
      return walletId;
    }

    it('BR-006-08 — filters by wallet, through the assets that wallet holds', async () => {
      await seedHistory();
      // PETR4 has two rows (Clear and Rico) and HGLG11 one; VALE3 is left out
      // of the wallet, so its row must not appear.
      const walletId = await seedWalletHolding('Aposentadoria', [petr4, hglg11]);

      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, { walletId }, { limit: 50, offset: 0 }),
      );

      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.total).toBe(3);
      expect(page.value.items.map((item) => item.assetCode).sort()).toEqual([
        'HGLG11',
        'PETR4',
        'PETR4',
      ]);
    });

    it('BR-006-08 — the wallet filter narrows in combination with the others', async () => {
      await seedHistory();
      const walletId = await seedWalletHolding('Aposentadoria', [petr4, hglg11]);

      const page = await asTenant((deps) =>
        listTransactions(
          deps.transactions,
          { walletId, institutionIds: [clear] },
          { limit: 50, offset: 0 },
        ),
      );

      /**
       * A real intersection, chosen so neither side can carry the assertion on
       * its own: the wallet alone matches 3 (both PETR4 rows and HGLG11), Clear
       * alone matches 3 (PETR4, VALE3, HGLG11), and only together do they
       * exclude VALE3 — which the wallet does not hold — and the Rico row,
       * which is not at Clear.
       */
      expect(page.ok && page.value.total).toBe(2);
    });

    it('an empty wallet matches nothing rather than everything', async () => {
      await seedHistory();
      const walletId = await seedWalletHolding('Nova', []);

      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, { walletId }, { limit: 50, offset: 0 }),
      );

      // The failure mode worth naming: a filter that resolves to an empty set
      // and is therefore dropped would show the whole ledger under a wallet
      // that holds nothing.
      expect(page.ok && page.value.total).toBe(0);
    });

    it("another tenant's wallet id matches nothing, rather than leaking its assets", async () => {
      await seedHistory();
      const strangersWallet = WalletId.generate();

      const page = await asTenant((deps) =>
        listTransactions(
          deps.transactions,
          { walletId: strangersWallet },
          { limit: 50, offset: 0 },
        ),
      );

      // The subquery is RLS-scoped on its own, so an id this tenant cannot see
      // resolves to no assets — fail-closed, the same way every other
      // tenant-scoped read behaves (TS-16).
      expect(page.ok && page.value.total).toBe(0);
    });

    it('paginates deterministically, newest first, with no row shown twice', async () => {
      await seedHistory();
      const [first, second] = await asTenant(async (deps) => [
        await listTransactions(deps.transactions, {}, { limit: 2, offset: 0 }),
        await listTransactions(deps.transactions, {}, { limit: 2, offset: 2 }),
      ]);

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.total).toBe(4);
      expect(first.value.items.map((i) => i.transaction.tradeDate)).toEqual([
        '2026-04-05',
        '2026-03-05',
      ]);
      expect(second.value.items.map((i) => i.transaction.tradeDate)).toEqual([
        '2026-02-05',
        '2026-01-05',
      ]);
      // No overlap between pages — the failure an unstable sort produces.
      const ids = new Set([
        ...first.value.items.map((i) => i.transaction.id),
        ...second.value.items.map((i) => i.transaction.id),
      ]);
      expect(ids.size).toBe(4);
    });

    it('joins the asset and institution names the list renders', async () => {
      await seedHistory();
      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, { assetIds: [hglg11] }, { limit: 10, offset: 0 }),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.items[0]?.assetCode).toBe('HGLG11');
      expect(page.value.items[0]?.assetName).toBe('CSHG Logística FII');
      expect(page.value.items[0]?.assetClass).toBe('fii');
      expect(page.value.items[0]?.institutionName).toBe('Clear');
    });

    it.each([
      [
        'a date range',
        { from: BusinessDate.of('2026-02-01'), to: BusinessDate.of('2026-03-31') },
        2,
      ],
      ['an asset', { assetIds: [] as never[] }, 4],
      ['an asset class', { assetClasses: ['fii'] }, 1],
      ['an institution', { institutionIds: [] as never[] }, 4],
      ['a type', { types: ['sell' as const] }, 0],
      ['a search term by code', { search: 'hglg' }, 1],
      ['a search term by name', { search: 'Logística' }, 1],
      ['a search term matching nothing', { search: 'zzzz' }, 0],
    ])('filters by %s', async (_label, filter, expected) => {
      await seedHistory();
      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, filter, { limit: 50, offset: 0 }),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.total).toBe(expected);
    });

    it('BR-006-08 — filters combine, narrowing rather than replacing', async () => {
      await seedHistory();
      const page = await asTenant((deps) =>
        listTransactions(
          deps.transactions,
          {
            assetIds: [petr4],
            institutionIds: [rico],
            from: BusinessDate.of('2026-01-01'),
            types: ['buy'],
          },
          { limit: 50, offset: 0 },
        ),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      // Only the PETR4 buy at Rico — asset alone would match 2.
      expect(page.value.total).toBe(1);
      expect(page.value.items[0]?.institutionName).toBe('Rico');
    });

    it('treats an empty filter array as "no constraint", not "match nothing"', async () => {
      await seedHistory();
      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, { types: [] }, { limit: 50, offset: 0 }),
      );
      expect(page.ok && page.value.total).toBe(4);
    });

    it('escapes LIKE wildcards rather than matching everything', async () => {
      await seedHistory();
      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, { search: '%' }, { limit: 50, offset: 0 }),
      );
      expect(page.ok && page.value.total).toBe(0);
    });

    it('includes rows with no institution, which an inner join would drop', async () => {
      await asTenant(async (deps) => {
        const result = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: null,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-05-05'),
          quantity: Quantity.fromString('7'),
          unitPrice: Money.fromString('10.00'),
          fees: Money.zero(),
        });
        expect(result.ok).toBe(true);
      });

      const page = await asTenant((deps) =>
        listTransactions(deps.transactions, {}, { limit: 50, offset: 0 }),
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.total).toBe(1);
      expect(page.value.items[0]?.institutionName).toBeNull();
    });
  });

  describe('BR-006-10 — CSV export', () => {
    it('honours the active filter and neutralises formula-injection cells', async () => {
      // An asset whose *name* is a formula — the shape a corporate-action feed
      // or a hand-edited extract can deliver.
      const hostile = await seedAsset(testDb.migrationUrl, 'EVIL11', '=cmd|calc!A1', 'stock');
      await asTenant(async (deps) => {
        for (const asset of [petr4, hostile.id]) {
          await createTransaction(deps, userId, {
            assetId: asset,
            institutionId: clear,
            type: 'buy',
            tradeDate: BusinessDate.of('2026-01-05'),
            quantity: Quantity.fromString('10'),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
        }
      });

      const all = await asTenant((deps) => exportTransactionsCsv(deps.transactions, {}));
      expect(all.split('\r\n')).toHaveLength(3);
      expect(all).toContain("'=cmd|calc!A1");
      expect(all).not.toMatch(/,=cmd/);

      const filtered = await asTenant((deps) =>
        exportTransactionsCsv(deps.transactions, { assetIds: [petr4] }),
      );
      expect(filtered.split('\r\n')).toHaveLength(2);
      expect(filtered).not.toContain('EVIL11');
    });
  });

  describe('BR-006-16 — an edited imported row is protected from re-import', () => {
    it('flags the row and keeps its batch provenance', async () => {
      const edited = await asTenant(async (deps) => {
        const created = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('100'),
          unitPrice: Money.fromString('10.00'),
          fees: Money.zero(),
          importBatchId: batchId as never,
        });
        if (!created.ok) throw new Error('create failed');
        expect(created.value.transaction.isUserModified).toBe(false);

        const result = await editTransaction(deps, created.value.transaction.id, {
          quantity: Quantity.fromString('120'),
        });
        if (!result.ok) throw new Error('edit failed');
        return deps.transactions.findById(result.value.transaction.id);
      });

      expect(edited?.isUserModified).toBe(true);
      expect(edited?.quantity.toString()).toBe('120');
      expect(edited?.importBatchId).toBe(batchId);
      expect(edited?.isManual).toBe(false);
    });

    it('AC — a re-import that skips user-modified rows leaves the correction intact', async () => {
      // SPEC-005 owns the re-import itself; what SPEC-006 owes it is a flag it
      // can filter on, and the ability to prove the correction survives.
      await asTenant(async (deps) => {
        const created = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('100'),
          unitPrice: Money.fromString('10.00'),
          fees: Money.zero(),
          importBatchId: batchId as never,
        });
        if (!created.ok) throw new Error('create failed');
        await editTransaction(deps, created.value.transaction.id, {
          quantity: Quantity.fromString('120'),
        });
      });

      // The re-import pass: anything already corrected is left alone.
      await asTenant(async (deps) => {
        for (const row of await deps.transactions.listAll()) {
          if (row.isUserModified) continue;
          await deps.transactions.update({ ...row, quantity: Quantity.fromString('100') });
        }
      });

      const after = await asTenant((deps) => deps.transactions.listAll());
      expect(after[0]?.quantity.toString()).toBe('120');
    });
  });

  describe('DM-4 — rebuild equals the incrementally-maintained cache, against real Postgres', () => {
    it('agrees after a backdated insertion, through the NUMERIC round trip', async () => {
      // The same hand-computed sequence as the unit property test, but every
      // intermediate figure now survives a write to NUMERIC(20,8) and a read
      // back — which is where a float would enter if one ever did.
      //   buy 100 @ 20,00 +10,00 fees → 2.010,00 over 100
      //   split ×2 (backdated, entered last) → 2.010,00 over 200
      //   buy 100 @ 12,85 +5,00 fees  → 3.300,00 over 300, average 11,00
      //   sell 50 @ 25,00, fees 12,00 → realized (25,00 − 11,00) × 50 − 12,00 = 688,00
      //                                 250 shares, total 3.300,00 − 550,00 = 2.750,00
      await asTenant(async (deps) => {
        const writes = [
          { type: 'buy' as const, date: '2026-01-05', qty: '100', price: '20.00', fees: '10.00' },
          { type: 'buy' as const, date: '2026-03-15', qty: '100', price: '12.85', fees: '5.00' },
          { type: 'sell' as const, date: '2026-05-25', qty: '50', price: '25.00', fees: '12.00' },
        ];
        for (const write of writes) {
          const result = await createTransaction(deps, userId, {
            assetId: petr4,
            institutionId: clear,
            type: write.type,
            tradeDate: BusinessDate.of(write.date),
            quantity: Quantity.fromString(write.qty),
            unitPrice: Money.fromString(write.price),
            fees: Money.fromString(write.fees),
          });
          expect(result.ok).toBe(true);
        }
        // The backdated corporate event, entered after every trade.
        const split = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'split',
          tradeDate: BusinessDate.of('2026-02-10'),
          quantity: Quantity.zero(),
          unitPrice: Money.zero(),
          fees: Money.zero(),
          ratio: Quantity.fromString('2'),
        });
        expect(split.ok).toBe(true);
      });

      const incremental = await asTenant((deps) => deps.positions.list());
      expect(incremental).toHaveLength(1);
      expect(incremental[0]?.state.quantity.toString()).toBe('250');
      expect(incremental[0]?.state.averageCost.toString()).toBe('11');
      expect(incremental[0]?.state.totalCost.toString()).toBe('2750');
      expect(incremental[0]?.state.realizedGain.toString()).toBe('688');

      const rebuilt = await asTenant(async (deps) => {
        const result = await rebuildPositions(deps);
        expect(result.ok).toBe(true);
        return deps.positions.list();
      });

      expect(rebuilt.map(serialize)).toEqual(incremental.map(serialize));
    });

    it('AC — a position closed to zero survives the round trip reset', async () => {
      // The `positions_closed_reset_check` constraint refuses a flat row that
      // still carries cost, so this also proves the domain never tries to
      // write one.
      await asTenant(async (deps) => {
        await createTransaction(deps, userId, {
          assetId: vale3,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('7'),
          unitPrice: Money.fromString('90').dividedBy(Quantity.fromString('7')),
          fees: Money.zero(),
        });
        const sale = await createTransaction(deps, userId, {
          assetId: vale3,
          institutionId: clear,
          type: 'sell',
          tradeDate: BusinessDate.of('2026-02-05'),
          quantity: Quantity.fromString('7'),
          unitPrice: Money.fromString('20.00'),
          fees: Money.zero(),
        });
        expect(sale.ok).toBe(true);
      });

      const stored = await asTenant((deps) => deps.positions.list());
      expect(stored[0]?.state.quantity.toString()).toBe('0');
      expect(stored[0]?.state.totalCost.toString()).toBe('0');
      expect(stored[0]?.state.averageCost.toString()).toBe('0');
    });

    it('removes the cached position when the last transaction is deleted', async () => {
      const id = await asTenant(async (deps) => {
        const created = await createTransaction(deps, userId, {
          assetId: petr4,
          institutionId: clear,
          type: 'buy',
          tradeDate: BusinessDate.of('2026-01-05'),
          quantity: Quantity.fromString('10'),
          unitPrice: Money.fromString('10.00'),
          fees: Money.zero(),
        });
        if (!created.ok) throw new Error('create failed');
        return created.value.transaction.id;
      });

      expect(await asTenant((deps) => deps.positions.list())).toHaveLength(1);

      await asTenant(async (deps) => {
        const result = await deleteTransaction(deps, id);
        expect(result.ok).toBe(true);
      });

      expect(await asTenant((deps) => deps.positions.list())).toEqual([]);
    });

    it('BR-007-08 — keeps one position row per (asset, institution), including the null one', async () => {
      await asTenant(async (deps) => {
        for (const institution of [clear, rico, null]) {
          const result = await createTransaction(deps, userId, {
            assetId: petr4,
            institutionId: institution,
            type: 'buy',
            tradeDate: BusinessDate.of('2026-01-05'),
            quantity: Quantity.fromString('10'),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
          expect(result.ok).toBe(true);
        }
      });

      const stored = await asTenant((deps) => deps.positions.list());
      expect(stored).toHaveLength(3);
    });

    it('upserts the null-institution position rather than duplicating it', async () => {
      // The NULLS NOT DISTINCT unique constraint is what makes this work.
      // Without it every recalculation would insert another row and the
      // portfolio total would multiply, silently.
      await asTenant(async (deps) => {
        for (let i = 0; i < 3; i += 1) {
          const result = await createTransaction(deps, userId, {
            assetId: petr4,
            institutionId: null,
            type: 'buy',
            tradeDate: BusinessDate.of(`2026-01-0${i + 1}`),
            quantity: Quantity.fromString('10'),
            unitPrice: Money.fromString('10.00'),
            fees: Money.zero(),
          });
          expect(result.ok).toBe(true);
        }
      });

      const stored = await asTenant((deps) => deps.positions.list());
      expect(stored).toHaveLength(1);
      expect(stored[0]?.state.quantity.toString()).toBe('30');
    });
  });

  it('BR-006-15 — refuses an oversell against real stored history', async () => {
    await asTenant(async (deps) => {
      await createTransaction(deps, userId, {
        assetId: petr4,
        institutionId: clear,
        type: 'buy',
        tradeDate: BusinessDate.of('2026-01-05'),
        quantity: Quantity.fromString('100'),
        unitPrice: Money.fromString('10.00'),
        fees: Money.zero(),
      });

      const result = await createTransaction(deps, userId, {
        assetId: petr4,
        institutionId: clear,
        type: 'sell',
        tradeDate: BusinessDate.of('2026-02-05'),
        quantity: Quantity.fromString('101'),
        unitPrice: Money.fromString('12.00'),
        fees: Money.zero(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context['held']).toBe('100');
    });
  });
});

function serialize(snapshot: {
  assetId: string;
  institutionId: string | null;
  state: { quantity: Money | Quantity; totalCost: Money; averageCost: Money; realizedGain: Money };
}) {
  return {
    assetId: snapshot.assetId,
    institutionId: snapshot.institutionId,
    quantity: snapshot.state.quantity.toString(),
    totalCost: snapshot.state.totalCost.toString(),
    averageCost: snapshot.state.averageCost.toString(),
    realizedGain: snapshot.state.realizedGain.toString(),
  };
}
