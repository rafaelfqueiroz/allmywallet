import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { UserId, WalletId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { runReportQuery } from '@/core/reporting/base-query';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import { withReportPort } from '@/app/(app)/reports/data';
import { loadDashboard } from '@/app/(app)/dashboard/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers, resetWallets } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * #98 — the dashboard, against real Postgres.
 *
 * Every assertion here is about a rule that closed in another spec and had no
 * screen to hold it: BR-005-26's three reconciliation states, BR-010-12's
 * queue, BR-013-12's "the same figure the report shows", BR-011-15's estimated
 * marking, and BR-005-27/28's dates.
 *
 * **The clock is pinned** (AR-03). Every figure on this screen is resolved as
 * of a date; a suite that could not fix it would be seeding a close for
 * "today" and hoping the day does not roll over mid-run.
 *
 * TS-03/TS-34: the CI database is shared across suite files, and `assets`,
 * `price_quotes` and `latest_quotes` are **global, non-tenant** rows — exactly
 * the kind that leak between files. Truncated in both `beforeAll` and
 * `afterAll`.
 */
describe('#98 — the dashboard read model (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const TODAY = BusinessDate.of('2026-03-20');
  // 2026-03-20T12:00Z is 09:00 in São Paulo — the same calendar day either way,
  // so the pinned instant cannot be read as a different date than TODAY.
  const clock = new FakeClock('2026-03-20T12:00:00Z');

  let petr: AssetId;
  let vale: AssetId;
  let cdb: AssetId;
  let xp: InstitutionId;

  async function cleanUp(): Promise<void> {
    await resetWallets(database.migrationUrl);
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query(
        'TRUNCATE index_series, price_quotes, latest_quotes, daily_valuation_snapshots, fixed_income_contracts, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);

    petr = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    vale = (await seedAsset(database.migrationUrl, 'VALE3', 'Vale ON')).id;
    cdb = (await seedAsset(database.migrationUrl, 'CDB-BANCO-X', 'CDB 110% CDI', 'cdb')).id;
    xp = await seedInstitution(database.migrationUrl, 'XP Investimentos');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await cleanUp();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query(
      'TRUNCATE positions, price_quotes, latest_quotes, import_rows, import_batches, ' +
        'wallet_allocation_events, wallet_allocations, wallet_asset_rules, wallets, ' +
        'fixed_income_contracts, daily_valuation_snapshots CASCADE',
    );
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedPosition(
    assetId: AssetId,
    quantity: string,
    averageCost: string,
    totalCost: string,
  ): Promise<void> {
    await migratorPool.query(
      `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0)`,
      [userId, assetId, xp, quantity, averageCost, totalCost],
    );
  }

  async function seedClose(assetId: AssetId, date: string, close: string): Promise<void> {
    await migratorPool.query(
      `INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, 'test')`,
      [assetId, date, close],
    );
  }

  async function seedLatestQuote(assetId: AssetId, quotedAt: string, price = '1'): Promise<void> {
    await migratorPool.query(
      `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
       VALUES ($1, $3, $2, now(), 'test')`,
      [assetId, quotedAt, price],
    );
  }

  async function seedBatch(input: {
    id: string;
    source?: string;
    status?: string;
    /** `null` is a value here, not an absence — a batch that was never committed. */
    committedAt?: string | null;
    reconciliation?: unknown;
  }): Promise<void> {
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at, reconciliation)
       VALUES ($1, $2, $3, $4, now(), $5, $6)`,
      [
        input.id,
        userId,
        input.source ?? 'b3_posicao',
        input.status ?? 'committed',
        // `??` would be wrong: `null` is the meaningful "never committed" case,
        // and coalescing it back to the default made the test that asserts on it
        // seed the opposite fixture.
        input.committedAt === undefined ? '2026-03-18T14:00:00Z' : input.committedAt,
        input.reconciliation === undefined ? null : JSON.stringify(input.reconciliation),
      ],
    );
  }

  async function seedRow(batchId: string, assetId: AssetId, classification: string): Promise<void> {
    await migratorPool.query(
      `INSERT INTO import_rows
         (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id)
       VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb, $3::jsonb, $4, $5)`,
      [
        userId,
        batchId,
        JSON.stringify({
          kind: 'transaction',
          b3Type: 'Desconhecido',
          direction: null,
          assetCode: 'PETR4',
          assetName: 'Petrobras PN',
          assetClass: 'stock',
          institutionName: null,
          tradeDate: '2026-03-10',
          quantity: '10',
          unitPrice: '1',
          fees: '0',
          ratio: null,
        }),
        classification,
        assetId,
      ],
    );
  }

  const discrepancy = (assetCode: string, resolved: boolean) => ({
    assetId: petr,
    assetCode,
    institutionId: null,
    computedQuantity: '100',
    b3Quantity: '120',
    difference: '20',
    cause: 'missing_history_before_import_range',
    resolved,
  });

  const load = () => loadDashboard(userId, clock);

  // -------------------------------------------------------------------------
  // Portfolio value (BR-013-12, BR-011-15, BR-020-27)
  // -------------------------------------------------------------------------

  describe('portfolio value', () => {
    /**
     * The cross-check the issue asks for: **the dashboard's headline equals the
     * Portfolio Value report's endpoint for the same date.**
     *
     * Asserted against the report built independently through its own loader
     * path rather than against a hardcoded number, because equality with the
     * report is the property — a hardcoded figure would still pass if both
     * screens drifted together.
     *
     * Hand-computed anyway, so the fixture is not self-referential:
     *   100 PETR4 × R$ 38,42 = R$ 3.842,00.
     */
    it('equals the Portfolio Value report endpoint for the same date', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');

      const { summary } = await load();

      const report = await withReportPort(userId, async (port) => {
        const query = await runReportQuery(
          port,
          {
            period: { kind: 'ytd' },
            scope: { kind: 'portfolio' },
            grouping: 'asset_class',
            today: TODAY,
          },
          await port.earliestSnapshotDate(),
        );
        if (!query.ok) throw new Error(query.error.code);
        return buildPortfolioValueReport({
          query: query.value,
          opening: await port.findSnapshotBefore(query.value.range.from),
          grouping: 'asset_class',
          today: TODAY,
          lastImportAt: await port.lastImportAt(),
        });
      });

      expect(summary.portfolio).toMatchObject({ kind: 'valued' });
      const value = summary.portfolio.kind === 'valued' ? summary.portfolio.value : Money.zero();
      expect(value.toDecimal().toFixed(2)).toBe('3842.00');
      expect(value.toDecimal().toFixed(8)).toBe(
        report.headline.currentValue.toDecimal().toFixed(8),
      );
    });

    /**
     * SPEC-009 BR-009-13 — a CDB with no contract row cannot be accrued, so it
     * falls back to acquisition cost and is flagged `needsAttention`.
     *
     * **This is the case that made the caveat lie.** `estimated` is set by two
     * different causes, and the first version of this screen told every such
     * user that the estimate came from *renda fixa acruada* — which is the
     * wrong explanation here, and hid BR-009-13's "this is not a valuation, act
     * on it" entirely. So the assertion is on `unpriced`, not on a boolean.
     */
    it('tells a cost fallback apart from an accrual', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');
      await seedPosition(cdb, '1', '10000', '10000');

      const { summary } = await load();

      expect(summary.portfolio).toMatchObject({
        kind: 'valued',
        markers: { estimated: true, accrued: false, unpriced: 1 },
      });
    });

    it('does not mark a fully observed total as estimated', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');

      const { summary } = await load();

      expect(summary.portfolio).toMatchObject({
        kind: 'valued',
        markers: { estimated: false, accrued: false, unpriced: 0, carriedForward: false },
      });
    });

    /**
     * SPEC-008 BR-008-24 — "never shown as current when it is not."
     *
     * The close is eight days old and `latest_quotes` carries a fresh instant.
     * Before the markers existed, this screen reported *"Cotações de 20/03
     * 16:45 — atraso de até 30 minutos"* over a total priced on 12/03, which is
     * exactly the free-tier case PRD R5 makes ordinary: ~51 assets can be
     * polled at a 30-minute cadence and the rest keep serving whatever
     * `latest_quotes` last held.
     */
    it('reports the oldest price behind the total, not only the freshest quote', async () => {
      // PETR4 was polled this morning; VALE3's last poll was three weeks ago and
      // `latest_quotes` is never expired (BR-008-10 — it is overwritten, not
      // aged out), so `resolvePrice` keeps serving that row and marks it
      // carried forward.
      await seedPosition(petr, '100', '32.15', '3215');
      await seedLatestQuote(petr, '2026-03-20T16:45:00Z');
      await seedPosition(vale, '100', '50.00', '5000');
      await seedLatestQuote(vale, '2026-02-27T20:00:00Z');

      const { summary } = await load();

      expect(summary.portfolio).toMatchObject({
        kind: 'valued',
        // A real observed price, just an old one — so not an estimate, and not
        // droppable either.
        markers: { carriedForward: true, oldestPriceDate: '2026-02-27', estimated: false },
      });
      /*
       * Both facts, on the same screen. `quotedAt` is the high-water mark
       * across the holdings, so on its own it reports half an hour of delay
       * over a *patrimônio* that is three weeks behind the market — the exact
       * shape BR-008-24 forbids, and ordinary on the free tier, where ~51
       * assets can be polled at a 30-minute cadence (PRD R5) and the rest keep
       * serving whatever was last stored.
       */
      expect(summary.freshness.quotedAt?.toISOString()).toBe('2026-03-20T16:45:00.000Z');
    });

    /**
     * BR-020-27 — "a portfolio displayed as R$ 0,00 is a false claim". The
     * assertion is on the *absence of a figure*, not on a zero.
     */
    it('shows the onboarding empty state before the first import', async () => {
      const { summary } = await load();

      expect(summary.portfolio).toEqual({ kind: 'onboarding' });
      expect(summary.freshness.lastImportAt).toBeNull();
    });

    it('distinguishes an emptied portfolio from a first run', async () => {
      await seedBatch({ id: '01920000-0000-7000-8000-0000000000f1', source: 'b3_negociacao' });

      const { summary } = await load();

      expect(summary.portfolio).toEqual({ kind: 'no_holdings' });
      expect(summary.freshness.lastImportAt).toBe('2026-03-18');
    });

    /**
     * SPEC-020 BR-020-26 — assets outside B3 custody are entered by hand, and
     * `/transactions/new` exists for that. A user who typed their whole ledger
     * and has since closed every position has no import and no holding; keying
     * the onboarding state on imports alone told them their *patrimônio* would
     * appear "depois da primeira importação" and offered to start one.
     *
     * The position closed to zero is the only trace that user leaves, and
     * `hasAnyPosition` is the read that finds it — SPEC-007's cache, not the
     * ledger (BR-016-05).
     */
    it('does not call a manual-entry user with no imports a first run', async () => {
      // BR-007-07: a closed position resets — quantity zero implies no
      // residual cost and no residual average (`positions_closed_reset_check`).
      // The row itself survives, and that is the trace this test is about.
      await seedPosition(petr, '0', '0', '0');

      const { summary } = await load();

      expect(summary.freshness.lastImportAt).toBeNull();
      expect(summary.portfolio).toEqual({ kind: 'no_holdings' });
    });
  });

  // -------------------------------------------------------------------------
  // Freshness (BR-005-27/28, BR-008-04)
  // -------------------------------------------------------------------------

  describe('freshness and staleness', () => {
    /**
     * BR-008-04 — "the product never implies real-time". A held asset with no
     * live quote row must report `null` rather than borrowing the valuation
     * date, which would present a figure as fresher than anything behind it.
     */
    it('reports no quote instant when nothing held is priced by a live quote', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');

      const { summary } = await load();

      expect(summary.freshness.quotedAt).toBeNull();
      expect(summary.freshness.valuationAsOf).toBe('2026-03-20');
      // The resolved `quotes.cadence_minutes` default (SPEC-002).
      expect(summary.freshness.delayMinutes).toBeGreaterThan(0);
    });

    it('reports the freshest quote instant behind the holdings', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');
      await seedLatestQuote(petr, '2026-03-20T16:45:00Z');

      const { summary } = await load();

      expect(summary.freshness.quotedAt?.toISOString()).toBe('2026-03-20T16:45:00.000Z');
    });

    it('is stale before the first import, with no number of days', async () => {
      const { summary } = await load();

      // `staleness.ts`: "never" is the strongest case for the prompt, not the
      // weakest — a user with no custody data at all.
      expect(summary.freshness.stale).toBe(true);
      expect(summary.freshness.daysSinceImport).toBeNull();
    });

    it('is not stale two days after a commit', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000f2',
        source: 'b3_negociacao',
        committedAt: '2026-03-18T14:00:00Z',
      });

      const { summary } = await load();

      expect(summary.freshness.daysSinceImport).toBe(2);
      expect(summary.freshness.stale).toBe(false);
    });

    /**
     * BR-005-27 — only a **committed** batch counts. A staged-but-abandoned
     * upload changed nothing, and counting it would say the figures are fresher
     * than they are.
     */
    it('ignores a batch that was never committed', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000f3',
        status: 'pending',
        committedAt: null,
      });

      const { summary } = await load();

      expect(summary.freshness.lastImportAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation (BR-005-26)
  // -------------------------------------------------------------------------

  describe('reconciliation status (BR-005-26)', () => {
    it('reports never_reconciled when no Posição batch carries a report', async () => {
      // A committed Movimentação batch is not a reconciliation: there is no B3
      // position statement in it to compare the ledger against.
      await seedBatch({ id: '01920000-0000-7000-8000-0000000000e1', source: 'b3_movimentacao' });

      const { summary } = await load();

      expect(summary.reconciliation).toEqual({
        state: 'never_reconciled',
        asOf: null,
        unresolvedCount: 0,
        resolvedCount: 0,
        batchId: null,
      });
    });

    it('reports reconciled when the comparison found nothing', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e2',
        reconciliation: { asOf: '2026-03-18', discrepancies: [], status: 'reconciled' },
      });

      const { summary } = await load();

      expect(summary.reconciliation).toMatchObject({
        state: 'reconciled',
        asOf: '2026-03-18',
        unresolvedCount: 0,
        // Nothing was found and nothing was settled — the screen may say the
        // quantities agreed.
        resolvedCount: 0,
        batchId: '01920000-0000-7000-8000-0000000000e2',
      });
    });

    it('reports discrepancies_found and counts only the unresolved ones', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e3',
        reconciliation: {
          asOf: '2026-03-18',
          status: 'discrepancies_found',
          discrepancies: [discrepancy('PETR4', false), discrepancy('VALE3', true)],
        },
      });

      const { summary } = await load();

      expect(summary.reconciliation).toMatchObject({
        state: 'discrepancies_found',
        unresolvedCount: 1,
      });
    });

    /**
     * BR-005-25 — `accept-adjustment.ts` flips `resolved` and deliberately
     * leaves the batch's stored `status` at `discrepancies_found`, because the
     * import really did find a disagreement. The dashboard answers about *now*,
     * and a permanent badge with nothing behind it trains a user to ignore the
     * one indicator that is supposed to mean something.
     */
    it('returns to reconciled once every discrepancy has been accepted', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e4',
        reconciliation: {
          asOf: '2026-03-18',
          // Stored status left as the import wrote it, on purpose.
          status: 'discrepancies_found',
          discrepancies: [discrepancy('PETR4', true), discrepancy('VALE3', true)],
        },
      });

      const { summary } = await load();

      expect(summary.reconciliation).toMatchObject({
        state: 'reconciled',
        unresolvedCount: 0,
        // Two were found and settled, which is not the same assurance as
        // "everything agreed" — the copy on screen turns on this number.
        resolvedCount: 2,
      });
    });

    it('reads the most recently committed reconciliation, not the most recent batch', async () => {
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e5',
        committedAt: '2026-03-10T14:00:00Z',
        reconciliation: {
          asOf: '2026-03-10',
          status: 'discrepancies_found',
          discrepancies: [discrepancy('PETR4', false)],
        },
      });
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e6',
        committedAt: '2026-03-18T14:00:00Z',
        reconciliation: { asOf: '2026-03-18', status: 'reconciled', discrepancies: [] },
      });
      // Newer still, but a Negociação commit — it reconciles nothing, so it
      // must not displace the answer above.
      await seedBatch({
        id: '01920000-0000-7000-8000-0000000000e7',
        source: 'b3_negociacao',
        committedAt: '2026-03-19T14:00:00Z',
      });

      const { summary } = await load();

      expect(summary.reconciliation).toMatchObject({ state: 'reconciled', asOf: '2026-03-18' });
    });
  });

  // -------------------------------------------------------------------------
  // Needs attention (BR-010-12)
  // -------------------------------------------------------------------------

  describe('needs attention (BR-010-12)', () => {
    const BATCH = '01920000-0000-7000-8000-0000000000d1';
    const BATCH_TWO = '01920000-0000-7000-8000-0000000000d2';
    const BATCH_THREE = '01920000-0000-7000-8000-0000000000d3';

    it('is empty when there is nothing to do', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');
      const walletId = WalletId.generate();
      await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
        walletId,
        userId,
        'Aposentadoria',
      ]);
      await migratorPool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
         VALUES (gen_random_uuid(), $1, $2, $3, '100')`,
        [userId, walletId, petr],
      );

      const { summary } = await load();

      expect(summary.attention).toEqual([]);
    });

    it('surfaces a holding awaiting allocation, and drops it once allocated', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');

      const before = await load();
      expect(before.summary.attention).toEqual([
        expect.objectContaining({
          kind: 'pending_allocation',
          assetCode: 'PETR4',
          reason: 'no_wallet',
        }),
      ]);

      const walletId = WalletId.generate();
      await migratorPool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
        walletId,
        userId,
        'Aposentadoria',
      ]);
      await migratorPool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
         VALUES (gen_random_uuid(), $1, $2, $3, '100')`,
        [userId, walletId, petr],
      );

      const after = await load();
      expect(after.summary.attention).toEqual([]);
    });

    it('surfaces unclassified rows from a committed batch, before the allocation items', async () => {
      await seedPosition(petr, '100', '32.15', '3215');
      await seedClose(petr, '2026-03-20', '38.42');
      await seedBatch({ id: BATCH, source: 'b3_movimentacao' });
      await seedRow(BATCH, petr, 'unclassified');
      await seedRow(BATCH, petr, 'unclassified');
      // The same pair `/import/[batchId]` already treats as needing attention.
      await seedRow(BATCH, petr, 'invalid');
      // Neither of these needs anything.
      await seedRow(BATCH, petr, 'new');
      await seedRow(BATCH, petr, 'duplicate');

      const { summary } = await load();

      expect(summary.attention[0]).toEqual({
        kind: 'import_rows',
        batchId: BATCH,
        count: 3,
      });
      expect(summary.attention[1]).toMatchObject({ kind: 'pending_allocation' });
    });

    /**
     * A row inside a batch the user is still previewing is not standing work —
     * they are inside that flow, and cancelling deletes the rows outright
     * (BR-005-12). Counting it would put an item on the landing screen for
     * something the user is in the middle of doing.
     */
    it('ignores rows in a batch that has not been committed', async () => {
      await seedBatch({
        id: BATCH,
        source: 'b3_movimentacao',
        status: 'previewed',
        committedAt: null,
      });
      await seedRow(BATCH, petr, 'unclassified');

      const { summary } = await load();

      expect(summary.attention).toEqual([]);
    });

    /**
     * The first-week state, end to end: an extract imported, no wallet created,
     * so every held asset awaits allocation. Six positions against a cap of
     * five, which is the smallest fixture that can tell a cap from an accident.
     */
    it('caps the rendered queue and reports the true total', async () => {
      for (const assetId of [petr, vale, cdb]) {
        await seedPosition(assetId, '10', '1', '10');
      }
      await seedClose(petr, '2026-03-20', '1');
      await seedClose(vale, '2026-03-20', '1');
      await seedBatch({ id: BATCH, source: 'b3_movimentacao' });
      for (let i = 0; i < 4; i += 1) await seedRow(BATCH, petr, 'unclassified');
      await seedBatch({ id: BATCH_TWO, source: 'b3_movimentacao' });
      await seedRow(BATCH_TWO, petr, 'unclassified');
      await seedBatch({ id: BATCH_THREE, source: 'b3_movimentacao' });
      await seedRow(BATCH_THREE, petr, 'invalid');

      const { summary } = await load();

      // 3 batches + 3 unallocated positions = 6, shown 5.
      expect(summary.attentionTotal).toBe(6);
      expect(summary.attention).toHaveLength(5);
      // The three that understate the headline are never the ones dropped.
      expect(summary.attention.slice(0, 3).every((item) => item.kind === 'import_rows')).toBe(true);
    });

    it('drops the entry once every row has been reclassified', async () => {
      await seedBatch({ id: BATCH, source: 'b3_movimentacao' });
      await seedRow(BATCH, petr, 'unclassified');

      expect((await load()).summary.attention).toHaveLength(1);

      await migratorPool.query(
        `UPDATE import_rows SET classification = 'new' WHERE batch_id = $1`,
        [BATCH],
      );

      expect((await load()).summary.attention).toEqual([]);
    });
  });
});
