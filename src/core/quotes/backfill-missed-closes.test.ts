import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import { err, ok } from '@/core/shared/result';
import { backfillMissedCloses, type BackfillPorts } from './backfill-missed-closes';
import { CloseGapReason, QuoteProviderErrorCode, type Asset } from './ports';
import {
  FakeBudgetCounter,
  FakeCloseGapRepository,
  FakeQuoteProvider,
  FakeQuoteRepository,
} from './test-support';

/**
 * SPEC-021 BR-021-29/31/32/33 — recovering missed closes.
 *
 * Every price below is written as a string and compared as a string: the
 * value the provider supplied is the value stored, digit for digit (AR-06).
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);

const PETR4: Asset = {
  id: AssetId.generate(),
  code: 'PETR4',
  name: 'Petrobras',
  assetClass: 'stock',
};
const VALE3: Asset = { id: AssetId.generate(), code: 'VALE3', name: 'Vale', assetClass: 'stock' };
const DAYS = [d('2026-03-12'), d('2026-03-13'), d('2026-03-16')];
const OPTIONS = { monthlyQuota: 15000, ondemandReservePct: 10 };

function history(ticker: string, closes: Record<string, string>) {
  return () =>
    ok({
      ticker,
      source: 'brapi_free',
      closes: Object.entries(closes).map(([date, close]) => ({
        date: d(date),
        close: Money.fromString(close),
      })),
    });
}

function ports(overrides: Partial<BackfillPorts> = {}): BackfillPorts & {
  repository: FakeQuoteRepository;
  provider: FakeQuoteProvider;
  budgetCounter: FakeBudgetCounter;
  gaps: FakeCloseGapRepository;
} {
  return {
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    budgetCounter: new FakeBudgetCounter(),
    gaps: new FakeCloseGapRepository(),
    // Tue 17 March, 12:00 São Paulo — the morning the worker came back.
    clock: new FakeClock('2026-03-17T15:00:00Z'),
    ...overrides,
  } as never;
}

describe('backfillMissedCloses (SPEC-021)', () => {
  it('BR-021-29: recovers every missed close in one request, exactly as supplied', async () => {
    const p = ports();
    p.provider.setHistory(
      'PETR4',
      history('PETR4', { '2026-03-12': '31.10', '2026-03-13': '31.25', '2026-03-16': '32.40' }),
    );

    const summary = await backfillMissedCloses(p, [PETR4], DAYS, OPTIONS);

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'PETR4', from: '2026-03-12', to: '2026-03-16' },
    ]);
    expect(summary.requests).toBe(1);
    expect(summary.gaps).toEqual([]);
    expect(p.repository.closeWrites.map((q) => [q.date, q.close.toString(), q.source])).toEqual([
      ['2026-03-12', '31.1', 'brapi_free'],
      ['2026-03-13', '31.25', 'brapi_free'],
      ['2026-03-16', '32.4', 'brapi_free'],
    ]);
    // BR-021-32: one request, charged to the scheduled share of *this* month.
    expect(p.budgetCounter.incrementCalls).toEqual([{ yearMonth: '2026-03', kind: 'scheduled' }]);
  });

  it('BR-021-33: never touches the latest quote and never makes a live request', async () => {
    const p = ports();
    p.provider.setHistory('PETR4', history('PETR4', { '2026-03-16': '29.00' }));

    await backfillMissedCloses(p, [PETR4], DAYS, OPTIONS);

    expect(await p.repository.getLatestQuote(PETR4.id)).toBeNull();
    expect(p.provider.liveCallCount).toBe(0);
  });

  it('BR-021-31: a day the provider does not supply is recorded as a gap — never interpolated, never copied', async () => {
    const p = ports();
    // Friday 13 is missing from the provider's history.
    p.provider.setHistory(
      'PETR4',
      history('PETR4', { '2026-03-12': '31.10', '2026-03-16': '32.40' }),
    );

    const summary = await backfillMissedCloses(p, [PETR4], DAYS, OPTIONS);

    expect(summary.gaps).toEqual([
      { assetId: PETR4.id, date: '2026-03-13', reason: CloseGapReason.NOT_SUPPLIED },
    ]);
    // Not (31.10 + 32.40) / 2 = 31.75, not Thursday's 31.10 — no row at all.
    expect(await p.repository.getClosePrice(PETR4.id, d('2026-03-13'))).toBeNull();
    expect(summary.recovered.map((q) => q.date)).toEqual(['2026-03-12', '2026-03-16']);
  });

  it('BR-021-31: a failed request records every missing day as a provider gap and charges no budget', async () => {
    const p = ports();
    p.provider.setHistory('PETR4', () =>
      err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker: 'PETR4' })),
    );

    const summary = await backfillMissedCloses(p, [PETR4], DAYS, OPTIONS);

    expect(summary.requests).toBe(0);
    expect(p.budgetCounter.incrementCalls).toEqual([]);
    expect([...p.gaps.gaps.values()].map((g) => [g.date, g.reason])).toEqual([
      ['2026-03-12', 'provider_unavailable'],
      ['2026-03-13', 'provider_unavailable'],
      ['2026-03-16', 'provider_unavailable'],
    ]);
  });

  it('BR-021-32: days the budget cannot cover become gaps, and the asset order is deterministic', async () => {
    // quota 100, reserve 10% → scheduled share = floor(100 × 90 / 100) = 90.
    // Usage 89: one request fits (89 < 90), the next does not (90 < 90 is false).
    // Passed VALE3-first; PETR4 still goes first because assets are ordered by code.
    const p = ports();
    p.budgetCounter.seed('2026-03', { scheduled: 89, ondemand: 0 });
    p.provider.setHistory(
      'PETR4',
      history('PETR4', { '2026-03-12': '31.10', '2026-03-13': '31.25', '2026-03-16': '32.40' }),
    );
    p.provider.setHistory('VALE3', history('VALE3', { '2026-03-12': '60.00' }));

    const summary = await backfillMissedCloses(p, [VALE3, PETR4], DAYS, {
      monthlyQuota: 100,
      ondemandReservePct: 10,
    });

    expect(p.provider.historicalCalls.map((c) => c.ticker)).toEqual(['PETR4']);
    expect(summary.recovered).toHaveLength(3);
    expect(summary.gaps).toEqual(
      DAYS.map((date) => ({ assetId: VALE3.id, date, reason: CloseGapReason.BUDGET_EXHAUSTED })),
    );
    expect(await p.budgetCounter.getUsage('2026-03')).toEqual({ scheduled: 90, ondemand: 0 });
  });

  it('BR-008-20: on-demand spend inside its reserve does not block catch-up', async () => {
    // Reserve 10% of 100 = 10. On-demand has used all 10; scheduled has used 0 of its 90.
    const p = ports();
    p.budgetCounter.seed('2026-03', { scheduled: 0, ondemand: 10 });
    p.provider.setHistory('PETR4', history('PETR4', { '2026-03-12': '31.10' }));

    const summary = await backfillMissedCloses(p, [PETR4], [d('2026-03-12')], {
      monthlyQuota: 100,
      ondemandReservePct: 10,
    });

    expect(summary.requests).toBe(1);
  });

  it('AR-19: only the days still missing are requested; an asset with none is not requested at all', async () => {
    const p = ports();
    await p.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-12'),
      close: Money.fromString('31.10'),
      source: 'brapi_free',
    });
    for (const day of DAYS) {
      await p.repository.upsertClosePrice({
        assetId: VALE3.id,
        date: day,
        close: Money.fromString('60'),
        source: 'brapi_free',
      });
    }
    p.provider.setHistory(
      'PETR4',
      history('PETR4', { '2026-03-13': '31.25', '2026-03-16': '32.40' }),
    );

    const summary = await backfillMissedCloses(p, [PETR4, VALE3], DAYS, OPTIONS);

    expect(p.provider.historicalCalls).toEqual([
      { ticker: 'PETR4', from: '2026-03-13', to: '2026-03-16' },
    ]);
    expect(summary.requests).toBe(1);
  });

  it('a close recovered on a later start clears the gap the earlier start recorded', async () => {
    const p = ports();
    await p.gaps.recordGap({
      assetId: PETR4.id,
      date: d('2026-03-13'),
      reason: 'budget_exhausted',
    });
    p.provider.setHistory('PETR4', history('PETR4', { '2026-03-13': '31.25' }));

    await backfillMissedCloses(p, [PETR4], [d('2026-03-13')], OPTIONS);

    expect(p.gaps.gaps.size).toBe(0);
    expect(p.gaps.cleared).toEqual([`${PETR4.id}:2026-03-13`]);
  });

  it('no days → no requests, no gaps', async () => {
    const p = ports();
    const summary = await backfillMissedCloses(p, [PETR4], [], OPTIONS);
    expect(summary).toEqual({ recovered: [], gaps: [], requests: 0 });
    expect(p.provider.callCount).toBe(0);
  });
});
