import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { ok } from '@/core/shared/result';
import type { Asset } from '@/core/quotes/ports';
import {
  FakeAssetCatalog,
  FakeBudgetCounter,
  FakeCloseGapRepository,
  FakeQuoteProvider,
  FakeQuoteRepository,
} from '@/core/quotes/test-support';
import { backfillCloseGaps } from './backfill-close-gaps';

/**
 * #151 — retrying the gaps a missing brapi token left behind. The recovery
 * rules themselves are `backfillMissedCloses`'s and tested there; this proves
 * the per-asset scoping and the single rebuild.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);

const ITSA4: Asset = { id: AssetId.generate(), code: 'ITSA4', name: 'Itaúsa', assetClass: 'stock' };
const HGLG11: Asset = {
  id: AssetId.generate(),
  code: 'HGLG11',
  name: 'CSHG Log',
  assetClass: 'fii',
};

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

function setup(gaps: Map<AssetId, readonly BusinessDate[]>) {
  const catalog = new FakeAssetCatalog();
  catalog.add(ITSA4);
  catalog.add(HGLG11);
  const rebuilds: BusinessDate[] = [];
  const deps = {
    repository: new FakeQuoteRepository(),
    provider: new FakeQuoteProvider(),
    budgetCounter: new FakeBudgetCounter(),
    gaps: new FakeCloseGapRepository(),
    clock: new FakeClock('2026-09-28T15:00:00Z'),
    catalog,
    retryableGaps: () => Promise.resolve(gaps),
    budget: { monthlyQuota: 15000, ondemandReservePct: 10 },
    rebuildSnapshotsFrom: (from: BusinessDate) => {
      rebuilds.push(from);
      return Promise.resolve();
    },
  };
  return { deps, rebuilds };
}

describe('backfillCloseGaps (#151)', () => {
  it('asks each asset for its own gap dates only, and rebuilds once from the earliest recovered day', async () => {
    const { deps, rebuilds } = setup(
      new Map([
        [ITSA4.id, [d('2026-09-21'), d('2026-09-22')]],
        [HGLG11.id, [d('2026-09-18')]],
      ]),
    );
    deps.provider.setHistory(
      'ITSA4',
      history('ITSA4', { '2026-09-21': '10.12', '2026-09-22': '10.30' }),
    );
    deps.provider.setHistory('HGLG11', history('HGLG11', { '2026-09-18': '158.40' }));

    const summary = await backfillCloseGaps(deps);

    expect(deps.provider.historicalCalls).toEqual([
      { ticker: 'HGLG11', from: '2026-09-18', to: '2026-09-18' },
      { ticker: 'ITSA4', from: '2026-09-21', to: '2026-09-22' },
    ]);
    expect(summary).toEqual({
      assets: 2,
      recovered: 3,
      stillMissing: 0,
      requests: 2,
      rebuiltFrom: '2026-09-18',
    });
    expect(rebuilds).toEqual(['2026-09-18']);
  });

  it('rebuilds nothing when no close was recovered', async () => {
    const { deps, rebuilds } = setup(new Map([[ITSA4.id, [d('2026-09-21')]]]));
    deps.provider.setHistory('ITSA4', history('ITSA4', {}));

    const summary = await backfillCloseGaps(deps);

    expect(summary.stillMissing).toBe(1);
    expect(summary.rebuiltFrom).toBeNull();
    expect(rebuilds).toEqual([]);
  });

  it('does nothing when there is no retryable gap', async () => {
    const { deps, rebuilds } = setup(new Map());

    const summary = await backfillCloseGaps(deps);

    expect(summary).toEqual({
      assets: 0,
      recovered: 0,
      stillMissing: 0,
      requests: 0,
      rebuiltFrom: null,
    });
    expect(deps.provider.callCount).toBe(0);
    expect(rebuilds).toEqual([]);
  });
});
