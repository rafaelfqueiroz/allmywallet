import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import type { ImportBatch } from '@/core/ingestion/ports';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { DrizzleCorporateEventFactorRepository } from '@/adapters/db/corporate-event-factor-repository';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import {
  buildIngestionDeps,
  buildWalletDeps as _buildWalletDeps,
  handleImportCommit,
  handleImportStage,
  saveUploadedFile,
} from '@/worker/handlers/import';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';
import {
  buildMovimentacaoXlsx,
  buildPosicaoXlsx,
  type MovimentacaoRowInput,
} from '@/adapters/ingestion/xlsx/test-support/builder';
import {
  factorMultiplier,
  type CorporateEventFactor,
  type CorporateEventFactorFetch,
  type CorporateEventFactorKind,
  type CorporateEventFactorSource,
} from '@/core/quotes/corporate-event-factors';
import { BusinessDate } from '@/core/shared/clock';
import { invalidateDeploymentCache, setConfigValue } from '@/config/resolve';

// `buildWalletDeps` is unused here but re-exported from the same module as
// `buildIngestionDeps` — importing it under `_` avoids an unused-import
// failure while documenting that this file deliberately does not touch it.
void _buildWalletDeps;

/**
 * SPEC-005 BR-005-20b (#113) — corporate-event rows resolved at commit,
 * against real Postgres: real `.xlsx` files (TS-19/DV-24 — generated, never a
 * captured B3 extract), the real worker handlers (`handleImportStage` /
 * `handleImportCommit`), real `withTenant` transactions and real `NUMERIC`
 * round-trips for the ratio/quantity/price arithmetic BR-007-04a and
 * BR-007-04b/05a describe.
 *
 * The unit-level coverage for this resolution logic lives in
 * `src/core/ingestion/commit-batch.test.ts` (`FakeIngestionDeps`) — this file
 * exists for what a fake cannot prove: that the real `import.commit` worker
 * path wires the corporate-event windows and the B3 factor source correctly,
 * that the ratio/price figures survive a `NUMERIC(20,8)` round trip, and that
 * an outage of the (always faked here — never reached for real) B3 factor
 * source never fails a commit.
 */
describe('SPEC-005 BR-005-20b (#113) — corporate-event resolution at commit (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let uploadDir: string;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-20T12:00:00-03:00');

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    // TS-33/TS-34: `corporate_event_factors`/`corporate_event_factor_fetches`
    // are shared, RLS-exempt tables (AR-15) — not tenant rows, so `resetLedger`
    // never touches them. Cleaned here so a later suite on the reused CI
    // Postgres never inherits a `BBAS`/`GRND`/`WEGE`/`KLBN` factor this file
    // seeded. `resetConfigState` covers the (unused here, but shared) config
    // registry tables for the same reason.
    await truncateFactorTables();
    await resetConfigState(testDb.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    // TS-03: CI runs every suite against one shared Postgres.
    clock.set('2026-03-20T12:00:00-03:00');
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await truncateFactorTables();
    await resetConfigState(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
    uploadDir = await mkdtemp(join(tmpdir(), 'amw-corporate-event-'));
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function truncateFactorTables(): Promise<void> {
    await migratorPool.query(
      'TRUNCATE corporate_event_factors, corporate_event_factor_fetches RESTART IDENTITY CASCADE',
    );
  }

  async function newPendingBatch(source: ImportBatch['source']): Promise<ImportBatchId> {
    const batchId = ImportBatchId.generate();
    await withTenant(
      userId,
      async (tx) =>
        new DrizzleImportBatchRepository(tx, userId).insert({
          id: batchId,
          userId,
          source,
          status: 'pending',
          uploadedAt: clock.now(),
          committedAt: null,
          rowCounts: null,
          reconciliation: null,
          failureCode: null,
        }),
      appDb,
    );
    return batchId;
  }

  async function batchRow(batchId: ImportBatchId) {
    const { rows } = await migratorPool.query(
      'SELECT status, row_counts, reconciliation FROM import_batches WHERE id = $1',
      [batchId],
    );
    return rows[0] as
      | { status: string; row_counts: Record<string, unknown> | null; reconciliation: unknown }
      | undefined;
  }

  interface StoredTransaction {
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly trade_date: string;
    readonly quantity: string;
    readonly unit_price: string;
    readonly total_value: string;
    readonly ratio: string | null;
    readonly natural_key: string;
    readonly occurrence: number;
    readonly is_user_modified: boolean;
    readonly updated_at: Date;
  }

  async function transactionsFor(assetCode: string): Promise<readonly StoredTransaction[]> {
    const { rows } = await migratorPool.query(
      `SELECT t.id::text AS id, t.type, t.status, t.trade_date::text AS trade_date,
              t.quantity::text AS quantity, t.unit_price::text AS unit_price,
              t.total_value::text AS total_value, t.ratio::text AS ratio,
              t.natural_key, t.occurrence, t.is_user_modified, t.updated_at
         FROM transactions t
         JOIN assets a ON a.id = t.asset_id
        WHERE a.code = $1 AND t.user_id = $2
        ORDER BY t.trade_date, t.created_at`,
      [assetCode, userId],
    );
    return rows as StoredTransaction[];
  }

  async function positionFor(assetCode: string) {
    const { rows } = await migratorPool.query(
      `SELECT p.quantity::text AS quantity, p.average_cost::text AS average_cost,
              p.total_cost::text AS total_cost, p.realized_gain::text AS realized_gain
         FROM positions p
         JOIN assets a ON a.id = p.asset_id
        WHERE a.code = $1 AND p.user_id = $2`,
      [assetCode, userId],
    );
    return rows[0] as
      | { quantity: string; average_cost: string; total_cost: string; realized_gain: string }
      | undefined;
  }

  async function fetchOutcomeFor(issuerCode: string) {
    const { rows } = await migratorPool.query(
      'SELECT outcome, failure_code FROM corporate_event_factor_fetches WHERE issuer_code = $1',
      [issuerCode],
    );
    return rows[0] as { outcome: string; failure_code: string | null } | undefined;
  }

  async function transactionCount(): Promise<number> {
    const { rows } = await migratorPool.query('SELECT count(*)::int AS n FROM transactions');
    return Number((rows[0] as { n: number }).n);
  }

  /**
   * SPEC-008 BR-008-29 — the seam `handleImportCommit`'s
   * `ImportHandlerDeps.corporateEventFactorSource` exists for: every commit in
   * this file passes one of these, so B3's real listed-companies endpoint
   * (`adapters/market-data/b3-listed-companies.ts`) is never reached.
   */
  class FakeFactorSource implements CorporateEventFactorSource {
    readonly calls: string[] = [];
    private readonly outcomes = new Map<string, CorporateEventFactorFetch>();
    private readonly throwing = new Set<string>();

    set(issuerCode: string, outcome: CorporateEventFactorFetch): void {
      this.outcomes.set(issuerCode, outcome);
    }

    throwFor(issuerCode: string): void {
      this.throwing.add(issuerCode);
    }

    async fetchIssuer(issuerCode: string): Promise<CorporateEventFactorFetch> {
      this.calls.push(issuerCode);
      if (this.throwing.has(issuerCode)) {
        throw new Error(`FakeFactorSource: simulated B3 outage for ${issuerCode}`);
      }
      return this.outcomes.get(issuerCode) ?? { outcome: 'not_listed' };
    }
  }

  const handlerDeps = (corporateEventFactorSource: CorporateEventFactorSource) => ({
    database: appDb,
    clock,
    ingestion: new XlsxIngestionPort(),
    uploadDir,
    enqueueSnapshot: async () => {},
    corporateEventFactorSource,
  });

  function factor(
    issuerCode: string,
    kind: CorporateEventFactorKind,
    published: string,
    lastDatePrior: string,
  ): CorporateEventFactor {
    return {
      issuerCode,
      kind,
      factorPublished: published,
      multiplier: factorMultiplier(kind, published),
      lastDatePrior: BusinessDate.of(lastDatePrior),
      approvedOn: null,
    };
  }

  const compra = (
    produto: string,
    data: string,
    quantidade: string,
    precoUnitario: string,
  ): MovimentacaoRowInput => ({ data, movimentacao: 'Compra', produto, quantidade, precoUnitario });
  const desdobro = (produto: string, data: string, quantidade: string): MovimentacaoRowInput => ({
    data,
    movimentacao: 'Desdobro',
    entradaSaida: 'Credito',
    produto,
    quantidade,
  });
  const grupamento = (produto: string, data: string, quantidade: string): MovimentacaoRowInput => ({
    data,
    movimentacao: 'Grupamento',
    entradaSaida: 'Credito',
    produto,
    quantidade,
  });
  const bonificacao = (
    produto: string,
    data: string,
    quantidade: string,
  ): MovimentacaoRowInput => ({
    data,
    movimentacao: 'Bonificação em Ativos',
    entradaSaida: 'Credito',
    produto,
    quantidade,
  });
  const fracao = (produto: string, data: string, quantidade: string): MovimentacaoRowInput => ({
    data,
    movimentacao: 'Fração em Ativos',
    entradaSaida: 'Debito',
    produto,
    quantidade,
  });
  const leilao = (
    produto: string,
    data: string,
    quantidade: string,
    precoUnitario: string,
  ): MovimentacaoRowInput => ({
    data,
    movimentacao: 'Leilão de Fração',
    entradaSaida: 'Credito',
    produto,
    quantidade,
    precoUnitario,
  });

  it('BR-005-20b/BR-007-04a: a Desdobro confirmed by B3’s factor applies as a split ×10 on first import', async () => {
    // 70 @ 100,00 = 7.000,00. Factor `desdobramento` published 900 → m = 1 +
    // 900 ÷ 100 = 10; 70 × (10 − 1) = 630 = Δ, so the derived and published
    // ratios agree and B3's own multiplier (10) is what gets stored. 700
    // shares at 7.000,00 ÷ 700 = 10,00. `lastDatePrior` 2024-03-01 is 4
    // calendar days before the row (2024-03-05) — inside the 7-day
    // `import.corporate_event_factor_window_days` default.
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        compra('BBAS3 - Banco do Brasil ON', '10/01/2024', '70', '100,00'),
        desdobro('BBAS3 - Banco do Brasil ON', '05/03/2024', '630'),
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps(new FakeFactorSource()));

    const source = new FakeFactorSource();
    source.set('BBAS', {
      outcome: 'ok',
      factors: [factor('BBAS', 'desdobramento', '900', '2024-03-01')],
    });
    await handleImportCommit({ batchId, userId }, handlerDeps(source));

    expect(source.calls).toEqual(['BBAS']);

    const rows = await transactionsFor('BBAS3');
    expect(rows).toHaveLength(2);
    const split = rows.find((r) => r.type === 'split');
    expect(split).toMatchObject({ status: 'active', is_user_modified: false });
    expect(split?.ratio).toBe('10.00000000');

    const position = await positionFor('BBAS3');
    expect(position).toMatchObject({
      quantity: '700.00000000',
      total_cost: '7000.00000000',
      average_cost: '10.00000000',
    });

    const fetched = await fetchOutcomeFor('BBAS');
    expect(fetched?.outcome).toBe('ok');

    const { status } = (await batchRow(batchId)) ?? { status: undefined };
    expect(status).toBe('committed');
  });

  it('BR-005-20b/BR-005-17: the 60-day default activates the generated ALUP11 and DEXP3 fraction chains in place, then re-import writes nothing', async () => {
    // Generated regression data only (DV-24/TS-19). Hand calculation:
    // ALUP11 130 + 5,2 − 0,2 + 5,4 − 0,4 + 5,6 − 0,6 = 145.
    // The first two origins are 37 and 38 calendar days before their fractions.
    // Under 30 days they remain unclassified; that leaves 0,6 on the replay,
    // so the 2025 bonus reaches 146,2 and cannot originate the stated 0,6.
    // DEXP3 100 + 12,5 − 0,5 = 112; its origin is 35 days before its fraction.
    const file = await buildMovimentacaoXlsx([
      compra('ALUP11 - Alupar UNT', '02/01/2023', '130', '10,00'),
      bonificacao('ALUP11 - Alupar UNT', '19/04/2023', '5,2'),
      fracao('ALUP11 - Alupar UNT', '26/05/2023', '0,2'),
      leilao('ALUP11 - Alupar UNT', '15/06/2023', '0,2', '10,00'),
      bonificacao('ALUP11 - Alupar UNT', '23/04/2024', '5,4'),
      fracao('ALUP11 - Alupar UNT', '31/05/2024', '0,4'),
      leilao('ALUP11 - Alupar UNT', '20/06/2024', '0,4', '10,00'),
      bonificacao('ALUP11 - Alupar UNT', '22/04/2025', '5,6'),
      fracao('ALUP11 - Alupar UNT', '21/05/2025', '0,6'),
      leilao('ALUP11 - Alupar UNT', '20/06/2025', '0,6', '10,00'),
      compra('DEXP3 - Dexxos ON', '02/01/2025', '100', '8,00'),
      bonificacao('DEXP3 - Dexxos ON', '23/12/2025', '12,5'),
      fracao('DEXP3 - Dexxos ON', '27/01/2026', '0,5'),
      leilao('DEXP3 - Dexxos ON', '10/02/2026', '0,5', '9,00'),
    ]);

    const configuredThirty = await setConfigValue(appDb, {
      key: 'import.fraction_origin_window_days',
      level: 'deployment',
      value: 30,
      actor: { kind: 'operator' },
    });
    expect(configuredThirty.ok).toBe(true);

    const first = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, first, file);
    await handleImportStage({ batchId: first, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit({ batchId: first, userId }, handlerDeps(new FakeFactorSource()));

    const alupBefore = await transactionsFor('ALUP11');
    const dexpBefore = await transactionsFor('DEXP3');
    const unresolvedAlup = alupBefore.filter(
      (row) =>
        row.status === 'unclassified' &&
        (row.quantity === '0.20000000' ||
          row.quantity === '0.40000000' ||
          row.quantity === '0.60000000'),
    );
    const unresolvedDexp = dexpBefore.filter(
      (row) => row.status === 'unclassified' && row.quantity === '0.50000000',
    );
    expect(unresolvedAlup).toHaveLength(6);
    expect(unresolvedDexp).toHaveLength(2);
    expect(await positionFor('ALUP11')).toMatchObject({ quantity: '146.20000000' });
    expect(await positionFor('DEXP3')).toMatchObject({ quantity: '112.50000000' });

    // Remove the deployment override so the next commit exercises the registry
    // default itself (60 since #128 D1), not a second test-only override.
    // Every gap here — 37, 38, 29 and 35 days — is inside both bounds, so
    // widening the window changes nothing this test asserts.
    await migratorPool.query(
      "DELETE FROM config_overrides WHERE key = 'import.fraction_origin_window_days' AND level = 'deployment'",
    );
    invalidateDeploymentCache();

    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, file);
    await handleImportStage({ batchId: second, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit({ batchId: second, userId }, handlerDeps(new FakeFactorSource()));

    const alupAfter = await transactionsFor('ALUP11');
    const dexpAfter = await transactionsFor('DEXP3');
    const alupRemovals = alupAfter.filter((row) => row.type === 'fracao_bonificacao');
    const alupIncome = alupAfter.filter((row) => row.type === 'leilao_fracoes');
    const dexpRemovals = dexpAfter.filter((row) => row.type === 'fracao_bonificacao');
    const dexpIncome = dexpAfter.filter((row) => row.type === 'leilao_fracoes');
    expect(alupRemovals).toHaveLength(3);
    expect(alupIncome).toHaveLength(3);
    expect(dexpRemovals).toHaveLength(1);
    expect(dexpIncome).toHaveLength(1);
    expect([...alupRemovals, ...alupIncome, ...dexpRemovals, ...dexpIncome]).toEqual(
      expect.arrayContaining(
        [...unresolvedAlup, ...unresolvedDexp].map((before) =>
          expect.objectContaining({
            id: before.id,
            natural_key: before.natural_key,
            occurrence: before.occurrence,
            is_user_modified: false,
            status: 'active',
          }),
        ),
      ),
    );
    expect(await positionFor('ALUP11')).toMatchObject({ quantity: '145.00000000' });
    expect(await positionFor('DEXP3')).toMatchObject({ quantity: '112.00000000' });

    const beforeThird = {
      count: await transactionCount(),
      updatedAt: new Map(
        [...alupRemovals, ...alupIncome, ...dexpRemovals, ...dexpIncome].map((row) => [
          row.id,
          row.updated_at,
        ]),
      ),
    };
    // An accidental update copies `deps.clock.now()` into `updated_at`.
    // Advancing makes the timestamp assertion capable of detecting that write;
    // the fixed clock used by the first three commits would otherwise mask it.
    clock.advanceMinutes(1);
    const third = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, third, file);
    await handleImportStage({ batchId: third, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit({ batchId: third, userId }, handlerDeps(new FakeFactorSource()));

    expect(await transactionCount()).toBe(beforeThird.count);
    const afterThird = [
      ...(await transactionsFor('ALUP11')),
      ...(await transactionsFor('DEXP3')),
    ].filter((row) => beforeThird.updatedAt.has(row.id));
    expect(afterThird).toHaveLength(8);
    for (const row of afterThird) {
      expect(row.updated_at).toEqual(beforeThird.updatedAt.get(row.id));
    }
    expect(await positionFor('ALUP11')).toMatchObject({ quantity: '145.00000000' });
    expect(await positionFor('DEXP3')).toMatchObject({ quantity: '112.00000000' });
  });

  it('BR-005-20b/BR-005-17: re-importing activates Desdobro, Grupamento, Fração em Ativos and Leilão de Fração in place once the factor is available; a further re-import writes nothing', async () => {
    // Three independent positions, one file, imported three times:
    //  - BBAS3: 70 @ 100,00 → Desdobro +630 (blocked on import 1 — no factor
    //    yet — resolved on import 2 to a ×10 split, 700 @ 10,00).
    //  - GRND3: 105 @ 10,00 → Grupamento 10,5 (factor 0,1; blocked on import 1;
    //    resolved on import 2) → Fração 0,5 → Leilão 0,5 @ 98,00. Once the
    //    Grupamento resolves, the fraction's origin is a split/grupamento, so
    //    BR-007-04b makes it a `sell` dated at the Fração's own date (2024-05-30)
    //    priced at the auction's 98,00: proceeds 49,00 − cost 0,5 × 100,00 =
    //    50,00 → realised **−1,00**; the Leilão is consumed (`superseded`).
    //  - ITSA4: 100 @ 20,00 → Bonificação em Ativos 5,2 (mapped directly, v3 —
    //    does not depend on B3's factor at all) → 105,2, fractional part 0,2 →
    //    Fração 0,2 → Leilão 0,2 @ 12,50. BR-007-05a: origin bonificação, so
    //    this resolves on **import 1 already** (fracao_bonificacao, cost
    //    unchanged; leilao_fracoes income 0,2 × 12,50 = 2,50) — included here
    //    to cover both fraction origins in the same re-import scenario the
    //    issue's AC names, even though only the ratio-gated chains are
    //    actually blocked by the outage.
    const file = await buildMovimentacaoXlsx([
      compra('BBAS3 - Banco do Brasil ON', '10/01/2024', '70', '100,00'),
      desdobro('BBAS3 - Banco do Brasil ON', '05/03/2024', '630'),
      compra('GRND3 - Grendene ON', '01/05/2024', '105', '10,00'),
      grupamento('GRND3 - Grendene ON', '28/05/2024', '10,5'),
      fracao('GRND3 - Grendene ON', '30/05/2024', '0,5'),
      leilao('GRND3 - Grendene ON', '10/06/2024', '0,5', '98,00'),
      compra('ITSA4 - Itausa PN', '03/11/2025', '100', '20,00'),
      bonificacao('ITSA4 - Itausa PN', '10/12/2025', '5,2'),
      fracao('ITSA4 - Itausa PN', '15/12/2025', '0,2'),
      leilao('ITSA4 - Itausa PN', '20/01/2026', '0,2', '12,50'),
    ]);

    const source = new FakeFactorSource();
    source.set('BBAS', { outcome: 'failed', failureCode: 'timeout' });
    source.set('GRND', { outcome: 'failed', failureCode: 'timeout' });

    // --- Import 1: B3's factor source is down. ---
    const first = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, first, file);
    await handleImportStage({ batchId: first, userId }, handlerDeps(source));
    await handleImportCommit({ batchId: first, userId }, handlerDeps(source));

    const afterFirst = {
      bbasDesdobro: (await transactionsFor('BBAS3')).find((r) => r.type !== 'buy'),
      grndGrupamento: (await transactionsFor('GRND3')).find((r) => r.quantity === '10.50000000'),
      grndFracao: (await transactionsFor('GRND3')).find((r) => r.quantity === '0.50000000'),
      grndLeilao: (await transactionsFor('GRND3')).find((r) => r.unit_price === '98.00000000'),
    };
    // All four B3 corporate-event types are represented, unclassified, after
    // the outage: Desdobro and Grupamento for want of a factor, and the
    // Fração/Leilão pair that depends on the (still-unresolved) Grupamento.
    expect(afterFirst.bbasDesdobro).toMatchObject({ status: 'unclassified' });
    expect(afterFirst.grndGrupamento).toMatchObject({ status: 'unclassified' });
    expect(afterFirst.grndFracao).toMatchObject({ status: 'unclassified' });
    expect(afterFirst.grndLeilao).toMatchObject({ status: 'unclassified' });
    // ITSA4's bonificação-origin fraction, unaffected by the B3 outage,
    // resolves already on this first import.
    const itsaAfterFirst = await transactionsFor('ITSA4');
    expect(itsaAfterFirst.find((r) => r.type === 'fracao_bonificacao')).toMatchObject({
      status: 'active',
    });
    const leilaoFracoes = itsaAfterFirst.find((r) => r.type === 'leilao_fracoes');
    expect(leilaoFracoes).toMatchObject({ status: 'active' });
    expect(leilaoFracoes?.total_value).toBe('2.50000000');
    expect(await positionFor('ITSA4')).toMatchObject({
      quantity: '105.00000000',
      total_cost: '2000.00000000',
      realized_gain: '0.00000000',
      average_cost: '19.04761905',
    });

    // --- Import 2: the identical file, factor source now up. ---
    source.set('BBAS', {
      outcome: 'ok',
      factors: [factor('BBAS', 'desdobramento', '900', '2024-03-01')],
    });
    source.set('GRND', {
      outcome: 'ok',
      factors: [factor('GRND', 'grupamento', '0.1', '2024-05-24')],
    });
    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, file);
    await handleImportStage({ batchId: second, userId }, handlerDeps(source));
    await handleImportCommit({ batchId: second, userId }, handlerDeps(source));

    // Same transaction ids, same natural_key/occurrence, never flagged a user
    // edit, activated in place at the resolved type.
    const split = (await transactionsFor('BBAS3')).find(
      (r) => r.id === afterFirst.bbasDesdobro?.id,
    );
    expect(split).toMatchObject({
      type: 'split',
      status: 'active',
      natural_key: afterFirst.bbasDesdobro?.natural_key,
      occurrence: afterFirst.bbasDesdobro?.occurrence,
      is_user_modified: false,
      ratio: '10.00000000',
    });

    const grndAfterSecond = await transactionsFor('GRND3');
    const grupamentoTx = grndAfterSecond.find((r) => r.id === afterFirst.grndGrupamento?.id);
    expect(grupamentoTx).toMatchObject({
      type: 'grupamento',
      status: 'active',
      natural_key: afterFirst.grndGrupamento?.natural_key,
      occurrence: afterFirst.grndGrupamento?.occurrence,
      is_user_modified: false,
      ratio: '0.10000000',
    });
    const saleTx = grndAfterSecond.find((r) => r.id === afterFirst.grndFracao?.id);
    expect(saleTx).toMatchObject({
      type: 'sell',
      status: 'active',
      trade_date: '2024-05-30',
      unit_price: '98.00000000',
      total_value: '49.00000000',
      natural_key: afterFirst.grndFracao?.natural_key,
      occurrence: afterFirst.grndFracao?.occurrence,
      is_user_modified: false,
    });
    const consumedAuction = grndAfterSecond.find((r) => r.id === afterFirst.grndLeilao?.id);
    expect(consumedAuction).toMatchObject({
      status: 'superseded',
      natural_key: afterFirst.grndLeilao?.natural_key,
      occurrence: afterFirst.grndLeilao?.occurrence,
      is_user_modified: false,
    });

    expect(await positionFor('BBAS3')).toMatchObject({
      quantity: '700.00000000',
      total_cost: '7000.00000000',
      average_cost: '10.00000000',
    });
    expect(await positionFor('GRND3')).toMatchObject({
      quantity: '10.00000000',
      total_cost: '1000.00000000',
      realized_gain: '-1.00000000',
    });

    // The origin batch's row counts moved out of Needs attention: three
    // activations (Desdobro, Grupamento, the Fração sale) plus one supersede
    // (the consumed Leilão) — BR-005-10.
    const firstBatchAfter = await batchRow(first);
    expect(firstBatchAfter?.row_counts).toMatchObject({ needsAttention: 0 });

    // Refresh cadence (BR-008-29): both issuers were fetched once per import,
    // since import 1's outcome was `failed` for each and a failed fetch is
    // never fresh.
    expect(source.calls.filter((c) => c === 'BBAS')).toHaveLength(2);
    expect(source.calls.filter((c) => c === 'GRND')).toHaveLength(2);

    // --- Import 3: the identical file again writes nothing. ---
    const before = {
      count: await transactionCount(),
      bbasUpdatedAt: split?.updated_at,
      grndUpdatedAt: [grupamentoTx?.updated_at, saleTx?.updated_at, consumedAuction?.updated_at],
    };
    const third = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, third, file);
    await handleImportStage({ batchId: third, userId }, handlerDeps(source));
    await handleImportCommit({ batchId: third, userId }, handlerDeps(source));

    expect(await transactionCount()).toBe(before.count);
    const grndAfterThird = await transactionsFor('GRND3');
    expect(grndAfterThird.find((r) => r.id === afterFirst.grndGrupamento?.id)?.updated_at).toEqual(
      before.grndUpdatedAt[0],
    );
    expect(grndAfterThird.find((r) => r.id === afterFirst.grndFracao?.id)?.updated_at).toEqual(
      before.grndUpdatedAt[1],
    );
    expect(grndAfterThird.find((r) => r.id === afterFirst.grndLeilao?.id)?.updated_at).toEqual(
      before.grndUpdatedAt[2],
    );
    expect(await positionFor('GRND3')).toMatchObject({
      quantity: '10.00000000',
      realized_gain: '-1.00000000',
    });
    expect(await positionFor('BBAS3')).toMatchObject({ quantity: '700.00000000' });
    expect(await positionFor('ITSA4')).toMatchObject({ quantity: '105.00000000' });
  });

  it('SPEC-008 BR-008-29: a failing factor source leaves the commit successful, the row unclassified, and the outage recorded', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        compra('FESA4 - Fesa PN', '01/01/2024', '10', '1,00'),
        desdobro('FESA4 - Fesa PN', '05/01/2024', '10'),
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps(new FakeFactorSource()));

    const source = new FakeFactorSource();
    source.set('FESA', { outcome: 'failed', failureCode: 'timeout' });
    await handleImportCommit({ batchId, userId }, handlerDeps(source));

    expect((await batchRow(batchId))?.status).toBe('committed');
    const desdobro_ = (await transactionsFor('FESA4')).find((r) => r.type !== 'buy');
    expect(desdobro_).toMatchObject({ status: 'unclassified' });
    expect(await fetchOutcomeFor('FESA')).toMatchObject({
      outcome: 'failed',
      failure_code: 'timeout',
    });
    // Nothing moved: the position replays only the buy.
    expect(await positionFor('FESA4')).toMatchObject({ quantity: '10.00000000' });
  });

  it('SPEC-008 BR-008-29: an outage suppresses a previously stored factor for this commit', async () => {
    const factors = new DrizzleCorporateEventFactorRepository(appDb);
    await factors.recordFetch(
      'FESA',
      {
        outcome: 'ok',
        factors: [factor('FESA', 'desdobramento', '100', '2024-01-04')],
      },
      new Date('2026-03-01T12:00:00Z'),
    );

    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        compra('FESA4 - Fesa PN', '01/01/2024', '10', '1,00'),
        desdobro('FESA4 - Fesa PN', '05/01/2024', '10'),
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps(new FakeFactorSource()));

    const source = new FakeFactorSource();
    source.set('FESA', { outcome: 'failed', failureCode: 'timeout' });
    await handleImportCommit({ batchId, userId }, handlerDeps(source));

    const desdobro_ = (await transactionsFor('FESA4')).find((row) => row.type !== 'buy');
    expect(desdobro_).toMatchObject({ status: 'unclassified' });
    expect(await positionFor('FESA4')).toMatchObject({ quantity: '10.00000000' });
    expect(await fetchOutcomeFor('FESA')).toMatchObject({
      outcome: 'failed',
      failure_code: 'timeout',
    });
  });

  it('SPEC-008 BR-008-29: a factor source that throws also leaves the commit successful, with no fetch recorded', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        compra('KLBN4 - Klabin PN', '01/01/2024', '10', '1,00'),
        desdobro('KLBN4 - Klabin PN', '05/01/2024', '10'),
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps(new FakeFactorSource()));

    const source = new FakeFactorSource();
    source.throwFor('KLBN');
    // `refreshFactorsForBatch` (worker/handlers/import.ts) wraps the whole
    // refresh in try/catch — an outage, however it fails, must never fail the
    // commit (BR-008-27/BR-008-29).
    await expect(
      handleImportCommit({ batchId, userId }, handlerDeps(source)),
    ).resolves.toBeUndefined();

    expect((await batchRow(batchId))?.status).toBe('committed');
    const desdobro_ = (await transactionsFor('KLBN4')).find((r) => r.type !== 'buy');
    expect(desdobro_).toMatchObject({ status: 'unclassified' });
    // The throw happened before `store.recordFetch` — never called for this
    // issuer, unlike the `failed`-outcome case above, which does record one.
    expect(await fetchOutcomeFor('KLBN')).toBeUndefined();
  });

  it('SPEC-008 BR-008-29: an ok issuer is not refetched inside the refresh window; a failed issuer is always retried', async () => {
    const source = new FakeFactorSource();
    source.set('WEGE', { outcome: 'ok', factors: [] });
    source.set('KLBN', { outcome: 'failed', failureCode: 'timeout' });

    const commit = async (produto: string, data: string, desdobroData: string) => {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(
        uploadDir,
        batchId,
        await buildMovimentacaoXlsx([
          compra(produto, data, '10', '1,00'),
          desdobro(produto, desdobroData, '10'),
        ]),
      );
      await handleImportStage({ batchId, userId }, handlerDeps(source));
      await handleImportCommit({ batchId, userId }, handlerDeps(source));
    };

    // First commit of each issuer: both fetched once.
    await commit('WEGE3 - WEG ON', '01/01/2024', '05/01/2024');
    await commit('KLBN4 - Klabin PN', '01/01/2024', '05/01/2024');
    expect(source.calls.filter((c) => c === 'WEGE')).toHaveLength(1);
    expect(source.calls.filter((c) => c === 'KLBN')).toHaveLength(1);

    // Second commit of each issuer, on a different position (a different B3
    // class code, so no natural-key collision with the first): `quotes
    // .b3_factor_refresh_days` (default 7) has not elapsed on the fixed test
    // clock — an `ok` fetch is fresh and skipped; a `failed` one is never
    // fresh (`refresh-corporate-event-factors.ts`'s `isFresh`) and is retried.
    await commit('WEGE4 - WEG PNA', '01/06/2024', '05/06/2024');
    await commit('KLBN3 - Klabin ON', '01/06/2024', '05/06/2024');
    expect(source.calls.filter((c) => c === 'WEGE')).toHaveLength(1);
    expect(source.calls.filter((c) => c === 'KLBN')).toHaveLength(2);
  });

  it('BR-005-20b/BR-006-16: a Desdobro classified by hand is never touched by a later import', async () => {
    const first = await newPendingBatch('b3_movimentacao');
    const file = await buildMovimentacaoXlsx([
      compra('BBAS3 - Banco do Brasil ON', '10/01/2024', '70', '100,00'),
      desdobro('BBAS3 - Banco do Brasil ON', '05/03/2024', '630'),
    ]);
    await saveUploadedFile(uploadDir, first, file);
    // No factor available: the row commits `unclassified` with a transaction id.
    await handleImportStage({ batchId: first, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit({ batchId: first, userId }, handlerDeps(new FakeFactorSource()));

    const stagedRows = await withTenant(
      userId,
      async (tx) => buildIngestionDeps(tx, userId, clock).rows.listByBatch(first),
      appDb,
    );
    const desdobroRow = stagedRows.find(
      (r) => r.record.kind === 'transaction' && r.record.b3Type === 'Desdobro',
    );
    if (desdobroRow === undefined) throw new Error('missing Desdobro row');

    const classified = await withTenant(
      userId,
      async (tx) =>
        classifyImportRow(buildIngestionDeps(tx, userId, clock), {
          rowId: desdobroRow.id,
          type: 'split',
          ratio: Quantity.fromString('10'),
        }),
      appDb,
    );
    expect(classified.ok).toBe(true);

    const beforeReimport = (await transactionsFor('BBAS3')).find((r) => r.type === 'split');
    expect(beforeReimport).toMatchObject({ status: 'active', is_user_modified: true });
    const countBefore = await transactionCount();

    // Re-import the identical file, this time with a confirming factor
    // available — BR-006-16: a user's classification is never reverted.
    const source = new FakeFactorSource();
    source.set('BBAS', {
      outcome: 'ok',
      factors: [factor('BBAS', 'desdobramento', '900', '2024-03-01')],
    });
    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, file);
    await handleImportStage({ batchId: second, userId }, handlerDeps(source));
    await handleImportCommit({ batchId: second, userId }, handlerDeps(source));

    expect(await transactionCount()).toBe(countBefore);
    const afterReimport = (await transactionsFor('BBAS3')).find((r) => r.id === beforeReimport?.id);
    expect(afterReimport).toEqual(beforeReimport);
  });

  it('SPEC-005 BR-005-24 (amended): a Posição discrepancy on a position holding an unclassified Desdobro is blamed on the ledger, not missing history', async () => {
    // 70 bought, an unresolved Desdobro of +630 that never applies — the
    // ledger replays 70 while B3's Posição, taken after the split, shows 700.
    // Before #113's fix this read as `missing_history_before_import_range`
    // (the Posição batch's own rows never hold an `unclassified` one); the
    // fix reads the ledger's unclassified transactions on the position
    // instead.
    const movimentacao = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      movimentacao,
      await buildMovimentacaoXlsx([
        compra('BBAS3 - Banco do Brasil ON', '10/01/2024', '70', '100,00'),
        desdobro('BBAS3 - Banco do Brasil ON', '05/03/2024', '630'),
      ]),
    );
    await handleImportStage({ batchId: movimentacao, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit(
      { batchId: movimentacao, userId },
      handlerDeps(new FakeFactorSource()),
    );
    expect(await positionFor('BBAS3')).toMatchObject({ quantity: '70.00000000' });

    const posicao = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      posicao,
      await buildPosicaoXlsx({
        Acoes: [{ produto: 'BBAS3 - BANCO DO BRASIL', codigo: 'BBAS3', quantidade: '700' }],
      }),
    );
    await handleImportStage({ batchId: posicao, userId }, handlerDeps(new FakeFactorSource()));
    await handleImportCommit(
      { batchId: posicao, userId, asOf: '2024-04-01' },
      handlerDeps(new FakeFactorSource()),
    );

    const report = (await batchRow(posicao))?.reconciliation as {
      status: string;
      discrepancies: {
        assetCode: string;
        computedQuantity: string;
        b3Quantity: string;
        difference: string;
        cause: string;
      }[];
    } | null;
    expect(report?.status).toBe('discrepancies_found');
    const discrepancy = report?.discrepancies.find((d) => d.assetCode === 'BBAS3');
    expect(discrepancy).toMatchObject({
      computedQuantity: '70',
      b3Quantity: '700',
      difference: '630',
      cause: 'unclassified_rows_affecting_asset',
    });
  });
  /**
   * #136 — the defect this test is named for, in the shape it appeared in:
   * B3 spelled Inter's DTVM one way on the extract carrying WEGE3's buys and
   * another on the one carrying its `Desdobro`, so the event resolved against
   * a position of zero and refused `no_basis`, and the sale behind it refused
   * `insufficient_quantity` for ever after. One institution, one position, and
   * BR-005-20b sees the whole history.
   */
  it('BR-005-20b/BR-007-08 (#136): a Desdobro spelled at one institution resolves against buys spelled at another', async () => {
    const INTER_FULL = 'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA';
    const INTER_SHORT = 'INTER DTVM LTDA';
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        { ...compra('WEGE3 - WEG S.A.', '10/01/2021', '5', '30,00'), instituicao: INTER_FULL },
        { ...compra('WEGE3 - WEG S.A.', '20/01/2021', '5', '32,00'), instituicao: INTER_FULL },
        // 10 held, +10 credited → derived ratio exactly 2, which is what B3's
        // published `desdobramento` factor of 100 (m = 1 + 100 ÷ 100) states.
        { ...desdobro('WEGE3 - WEG S.A.', '29/04/2021', '10'), instituicao: INTER_SHORT },
        {
          data: '30/04/2021',
          movimentacao: 'Venda',
          entradaSaida: 'Debito',
          produto: 'WEGE3 - WEG S.A.',
          instituicao: INTER_SHORT,
          quantidade: '20',
          precoUnitario: '20,00',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps(new FakeFactorSource()));

    const source = new FakeFactorSource();
    source.set('WEGE', {
      outcome: 'ok',
      factors: [factor('WEGE', 'desdobramento', '100', '2021-04-27')],
    });
    await handleImportCommit({ batchId, userId }, handlerDeps(source));

    const { rows: institutions } = await migratorPool.query('SELECT name FROM institutions');
    expect(institutions.map((row) => row.name)).toEqual([INTER_FULL]);

    const rows = await transactionsFor('WEGE3');
    const split = rows.find((r) => r.type === 'split');
    expect(split).toMatchObject({ status: 'active', ratio: '2.00000000' });
    expect(rows.find((r) => r.type === 'sell')).toMatchObject({ status: 'active' });

    // 310,00 for 20 shares after the split; all 20 sold, so the position
    // closes and BR-007-07 resets it.
    expect(await positionFor('WEGE3')).toMatchObject({
      quantity: '0.00000000',
      total_cost: '0.00000000',
      realized_gain: '90.00000000',
    });
  });
});
