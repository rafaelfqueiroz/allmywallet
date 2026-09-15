import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { InstitutionId, TransactionId, UserId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  computeTotalValue,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';
import type { EarningRecord } from '@/core/reporting/ports';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { withTenant } from '@/db/tenant';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-014 BR-014-12 (#113 review) — **which rows the leilão's held basis is
 * replayed from**, read through the real port and real RLS.
 *
 * `DrizzleReportDataPort.listEarnings` gives a `leilao_fracoes` record the
 * position held on its pay date. That figure is only right if the replay sees
 * exactly the right rows: `active` only (SPEC-007 BR-007-16), every
 * institution (BR-007-08), everything on the pay date itself including a
 * same-day sale (rank 4 before the leilão's rank 5, BR-007-15), and nothing of
 * another tenant's (AR-11). Each asset below isolates one of those, so a
 * regression names itself.
 *
 * The pay-date *cutoff* (a row after the pay date) is asserted end to end in
 * `earnings-cross-report.test.ts`; asset SAME below repeats it at the port.
 */
describe('SPEC-014 BR-014-12 — the leilão de frações held basis', () => {
  let database: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const alice = UserId.generate();
  const bob = UserId.generate();
  const brokerA = InstitutionId.generate();
  const brokerB = InstitutionId.generate();

  /** Status filter. */
  let status: AssetId;
  /** Two institutions. */
  let split: AssetId;
  /** Same-day sale, a later sale, and a second tenant. */
  let same: AssetId;

  const BUY = '2026-01-12';
  const PAY = '2026-03-17';
  const FROM = BusinessDate.of('2026-01-01');
  const TO = BusinessDate.of('2026-03-20');

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);

    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    db = drizzle(appPool, { schema });

    // TS-03: CI shares one Postgres across suites.
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, alice);
    await seedUser(database.migrationUrl, bob);

    // `institutions.name` is unique and shared; suffixed so a reused database
    // holding an earlier run's rows cannot collide.
    await migratorPool.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      brokerA,
      `Held basis A ${brokerA}`,
      brokerB,
      `Held basis B ${brokerB}`,
    ]);

    const catalog = new DrizzleAssetCatalogRepository(db);
    const asset = async (code: string) =>
      (await catalog.upsertByCode({ code, name: code, assetClass: 'stock' })).id;
    status = await asset('HBSTAT3');
    split = await asset('HBINST3');
    same = await asset('HBSAME3');

    // Status filter. Active: buy 100. Unclassified buy 40 and superseded sell
    // 30 are stored but inert (DL-006-06).
    //   held on PAY = 100            (counting every status: 100 + 40 − 30 = 110)
    await seed({ user: alice, asset: status, type: 'buy', date: BUY, qty: '100', price: '10' });
    await seed({
      user: alice,
      asset: status,
      type: 'buy',
      date: '2026-02-02',
      qty: '40',
      price: '10',
      status: 'unclassified',
    });
    await seed({
      user: alice,
      asset: status,
      type: 'sell',
      date: '2026-03-02',
      qty: '30',
      price: '12',
      status: 'superseded',
    });
    await seed({
      user: alice,
      asset: status,
      type: 'leilao_fracoes',
      date: PAY,
      qty: '0.2',
      price: '14.00',
    });

    // Two institutions. Buy 60 at A and 45 at B; the leilão row names A.
    //   held on PAY = 60 + 45 = 105  (A alone: 60; B alone: 45)
    await seed({
      user: alice,
      asset: split,
      type: 'buy',
      date: BUY,
      qty: '60',
      price: '10',
      at: brokerA,
    });
    await seed({
      user: alice,
      asset: split,
      type: 'buy',
      date: BUY,
      qty: '45',
      price: '10',
      at: brokerB,
    });
    await seed({
      user: alice,
      asset: split,
      type: 'leilao_fracoes',
      date: PAY,
      qty: '0.2',
      price: '14.00',
      at: brokerA,
    });

    // Same-day sale, then a later one, and a second tenant on the same asset.
    //   alice: buy 100; sell 30 on PAY (rank 4, before the leilão's 5); sell 20
    //          on 03-19, after PAY but inside the period
    //   held on PAY = 100 − 30 = 70  (without the same-day sale: 100; replayed
    //                                 to the period end: 70 − 20 = 50)
    //   bob:   buy 500 and his own leilão on PAY — held 500, and none of it
    //          reaches alice's 70 (AR-11: RLS scopes `listForAssetsUpTo`)
    await seed({ user: alice, asset: same, type: 'buy', date: BUY, qty: '100', price: '10' });
    await seed({ user: alice, asset: same, type: 'sell', date: PAY, qty: '30', price: '12' });
    await seed({
      user: alice,
      asset: same,
      type: 'leilao_fracoes',
      date: PAY,
      qty: '0.2',
      price: '14.00',
    });
    await seed({
      user: alice,
      asset: same,
      type: 'sell',
      date: '2026-03-19',
      qty: '20',
      price: '12',
    });
    await seed({ user: bob, asset: same, type: 'buy', date: BUY, qty: '500', price: '10' });
    await seed({
      user: bob,
      asset: same,
      type: 'leilao_fracoes',
      date: PAY,
      qty: '0.2',
      price: '14.00',
    });
  }, 300_000);

  afterAll(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await migratorPool.query('DELETE FROM institutions WHERE id IN ($1, $2)', [brokerA, brokerB]);
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  let sequence = 0;
  async function seed(row: {
    user: UserId;
    asset: AssetId;
    type: TransactionType;
    date: string;
    qty: string;
    price: string;
    status?: TransactionStatus;
    at?: InstitutionId;
  }): Promise<void> {
    sequence += 1;
    const q = Quantity.fromString(row.qty);
    const price = Money.fromString(row.price);
    await migratorPool.query(
      `INSERT INTO transactions (id, user_id, asset_id, institution_id, type, status,
         trade_date, quantity, unit_price, fees, total_value, ratio, natural_key,
         occurrence, import_batch_id, is_manual, is_user_modified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,NULL,$11,1,NULL,true,false)`,
      [
        TransactionId.generate(),
        row.user,
        row.asset,
        row.at ?? null,
        row.type,
        row.status ?? 'active',
        row.date,
        q.toString(),
        price.toString(),
        computeTotalValue(row.type, q, price, Money.zero()).toString(),
        `hb|${row.date}|${row.type}|${sequence}`,
      ],
    );
  }

  /** `asset → heldQuantity` for every leilão the tenant's port returns. */
  async function heldBasis(user: UserId): Promise<ReadonlyMap<AssetId, string>> {
    const earnings: readonly EarningRecord[] = await withTenant(
      user,
      (tx) =>
        new DrizzleReportDataPort(tx, user, new FakeClock('2026-03-20T22:00:00Z')).listEarnings(
          FROM,
          TO,
        ),
      db,
    );
    const held = new Map<AssetId, string>();
    for (const earning of earnings) {
      if (earning.type === 'leilao_fracoes') {
        held.set(earning.assetId, earning.heldQuantity.toString());
      }
    }
    return held;
  }

  it('replays active rows only — an unclassified buy and a superseded sell change nothing', async () => {
    // 100, not 100 + 40 − 30 = 110.
    expect((await heldBasis(alice)).get(status)).toBe('100');
  });

  it('sums the position across every institution, not the one the leilão names', async () => {
    // 60 at A + 45 at B = 105.
    expect((await heldBasis(alice)).get(split)).toBe('105');
  });

  it('counts a sale on the pay date and nothing after it', async () => {
    // 100 − 30 = 70: the same-day sale is in (rank 4 < 5); the 03-19 sale of
    // 20 is out (70 − 20 = 50 would be the period-end figure).
    expect((await heldBasis(alice)).get(same)).toBe('70');
  });

  it('reads only the tenant’s own rows on a shared asset', async () => {
    // alice 70 as above, untouched by bob's 500; bob sees his 500 alone.
    expect((await heldBasis(alice)).get(same)).toBe('70');
    const bobs = await heldBasis(bob);
    expect(bobs.get(same)).toBe('500');
    expect(bobs.size).toBe(1);
  });
});
