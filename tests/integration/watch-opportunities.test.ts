import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import { UserId, type AssetId } from '@/core/shared/ids';
import { loadWatchOpportunities } from '@/app/(app)/watch/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset } from '../support/ledger-fixtures';
import { resetLedger, resetOpportunity, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-022 BR-022-07 (#212) — the Painel's watch-state card, against real
 * Postgres: held assets in a buy or sell state, read from SPEC-018's existing
 * evaluation, and **no provider request** behind a render (BR-018-11).
 *
 * "Zero requests" is held two ways. `fetch` is spied, because every quote
 * provider is an HTTP adapter (`src/adapters/quotes/`) and a render that
 * reached one would call it. And `quote_budget_usage` — the counter SPEC-008
 * increments once per provider call (BR-008-19/20) and the budget alarm reads —
 * is unchanged, as SPEC-018 AC-7 measures it for an evaluation pass.
 *
 * The clock is pinned to a Monday at 10:00 in São Paulo, so the session is open
 * and an intraday quote ten minutes old is fresh (BR-018-16).
 *
 * TS-03/TS-34: `assets` and `latest_quotes` are global rows, truncated in both
 * `beforeAll` and `afterAll`.
 */
describe('#212 — the Painel watch-state card (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-16T13:00:00Z');
  const fresh = new Date('2026-03-16T12:50:00Z');

  async function cleanUp(): Promise<void> {
    await resetOpportunity(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const migrator = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migrator.query(
        'TRUNCATE quote_budget_usage, price_quotes, latest_quotes, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await migrator.end();
    }
  }

  async function hold(assetId: AssetId, quantity: string, owner: UserId = userId): Promise<void> {
    await pool.query(
      `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
       VALUES ($1, $2, $3, $4::numeric, CASE WHEN $4::numeric = 0 THEN 0 ELSE 10 END, $4::numeric * 10, 0)`,
      [randomUUID(), owner, assetId, quantity],
    );
  }

  async function quote(assetId: AssetId, price: string, quotedAt: Date): Promise<void> {
    await pool.query(
      `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
       VALUES ($1, $2, $3, $3, 'brapi_free')`,
      [assetId, price, quotedAt],
    );
  }

  async function rule(
    assetId: AssetId,
    lower: { price: string; state: string } | null,
    upper: { price: string; state: string } | null,
    { owner = userId, defaultState = 'hold' }: { owner?: UserId; defaultState?: string } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO opportunity_rules
         (id, user_id, asset_id, lower_bound, lower_state, upper_bound, upper_state, default_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        owner,
        assetId,
        lower?.price ?? null,
        lower?.state ?? null,
        upper?.price ?? null,
        upper?.state ?? null,
        defaultState,
      ],
    );
  }

  async function budgetRows(): Promise<unknown[]> {
    const { rows } = await pool.query('SELECT * FROM quote_budget_usage ORDER BY 1');
    return rows;
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);
    pool = new Pool({ connectionString: database.migrationUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await cleanUp();
    await database.stop();
  });

  it('lists held assets in a buy or sell state, each with the bound it matched', async () => {
    const buy = (await seedAsset(database.migrationUrl, 'ITSA4', 'Itaúsa PN')).id;
    const sell = (await seedAsset(database.migrationUrl, 'WEGE3', 'WEG ON')).id;
    const hold_ = (await seedAsset(database.migrationUrl, 'BBAS3', 'Banco do Brasil ON')).id;
    const stale = (await seedAsset(database.migrationUrl, 'VALE3', 'Vale ON')).id;
    const closed = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    const between = (await seedAsset(database.migrationUrl, 'TAEE11', 'Taesa UNT')).id;

    for (const id of [buy, sell, hold_, stale, between]) await hold(id, '100');
    await hold(closed, '0');

    await quote(buy, '10.86', fresh);
    await quote(sell, '52.17', fresh);
    await quote(hold_, '25.00', fresh);
    // BR-018-16 — a day old in an open session: unknown, never carried forward.
    await quote(stale, '50.00', new Date('2026-03-13T18:00:00Z'));
    await quote(closed, '20.00', fresh);
    await quote(between, '35.00', fresh);

    await rule(buy, { price: '11.00', state: 'buy' }, null);
    await rule(sell, null, { price: '50.00', state: 'sell' });
    await rule(hold_, { price: '20.00', state: 'buy' }, { price: '30.00', state: 'sell' });
    await rule(stale, { price: '60.00', state: 'buy' }, null);
    // BR-018-03 — a closed position's rule is retained, and on no card.
    await rule(closed, { price: '30.00', state: 'buy' }, null);
    // BR-018-07 — a buy reached through the default band names no threshold.
    await rule(
      between,
      { price: '30.00', state: 'sell' },
      { price: '40.00', state: 'sell' },
      { defaultState: 'buy' },
    );

    const before = await budgetRows();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const card = await loadWatchOpportunities(userId, clock);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await budgetRows()).toEqual(before);

      expect(card.hasRules).toBe(true);
      expect(
        card.items.map((item) => ({
          code: item.code,
          state: item.state,
          matched: item.matched,
          price: item.price.toString(),
          threshold: item.threshold?.toString() ?? null,
        })),
      ).toEqual([
        { code: 'ITSA4', state: 'buy', matched: 'lower', price: '10.86', threshold: '11' },
        { code: 'TAEE11', state: 'buy', matched: 'default', price: '35', threshold: null },
        { code: 'WEGE3', state: 'sell', matched: 'upper', price: '52.17', threshold: '50' },
      ]);
      // VALE3 is not listed, but counted: an empty card must not claim
      // "nothing in buy or sell" from a missing price.
      expect(card.unknownCount).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('says when the user has no rule at all', async () => {
    const other = UserId.generate();
    await seedUser(database.migrationUrl, other);
    expect(await loadWatchOpportunities(other, clock)).toEqual({
      hasRules: false,
      items: [],
      unknownCount: 0,
    });
  });

  it('counts a retained rule as a rule, and a hold state as nothing to list', async () => {
    const other = UserId.generate();
    await seedUser(database.migrationUrl, other);
    const sold = (await seedAsset(database.migrationUrl, 'RENT3', 'Localiza ON')).id;
    const steady = (await seedAsset(database.migrationUrl, 'EGIE3', 'Engie ON')).id;
    await hold(sold, '0', other);
    await hold(steady, '10', other);
    await quote(steady, '40.00', fresh);
    await rule(sold, { price: '50.00', state: 'buy' }, null, { owner: other });
    await rule(steady, { price: '30.00', state: 'buy' }, null, { owner: other });

    expect(await loadWatchOpportunities(other, clock)).toEqual({
      hasRules: true,
      items: [],
      unknownCount: 0,
    });
  });
});
