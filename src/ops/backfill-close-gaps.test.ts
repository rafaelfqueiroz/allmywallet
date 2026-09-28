import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { BusinessDate } from '@/core/shared/clock';
import type { Asset } from '@/core/quotes/ports';
import { FakeAssetCatalog, FakeOfficialCloseSource, FakeQuoteRepository } from '@/core/quotes/test-support';
import { backfillCloseGaps } from './backfill-close-gaps';

/**
 * #151, rewritten for #171 — retrying the gaps a missing brapi token, and
 * later a COTAHIST outage, left behind. The recovery rules themselves are
 * `fetchOfficialCloses`'s and tested there; this proves the per-asset
 * scoping and the single rebuild.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);

const ITSA4: Asset = { id: AssetId.generate(), code: 'ITSA4', name: 'Itaúsa', assetClass: 'stock' };
const HGLG11: Asset = {
  id: AssetId.generate(),
  code: 'HGLG11',
  name: 'CSHG Log',
  assetClass: 'fii',
};

function setup(gaps: Map<AssetId, readonly BusinessDate[]>) {
  const catalog = new FakeAssetCatalog();
  catalog.add(ITSA4);
  catalog.add(HGLG11);
  const rebuilds: BusinessDate[] = [];
  const deps = {
    source: new FakeOfficialCloseSource(),
    repository: new FakeQuoteRepository(),
    catalog,
    retryableGaps: () => Promise.resolve(gaps),
    annualFileMinDays: 100,
    currentYear: 2026,
    rebuildSnapshotsFrom: (from: BusinessDate) => {
      rebuilds.push(from);
      return Promise.resolve();
    },
  };
  return { deps, rebuilds };
}

describe('backfillCloseGaps (#151, #171)', () => {
  it('asks each asset for its own gap dates only, and rebuilds once from the earliest recovered day', async () => {
    const { deps, rebuilds } = setup(
      new Map([
        [ITSA4.id, [d('2026-09-21'), d('2026-09-22')]],
        [HGLG11.id, [d('2026-09-18')]],
      ]),
    );
    deps.source.seedDay(d('2026-09-21'), [
      { ticker: 'ITSA4', date: d('2026-09-21'), close: Money.fromString('10.12') },
    ]);
    deps.source.seedDay(d('2026-09-22'), [
      { ticker: 'ITSA4', date: d('2026-09-22'), close: Money.fromString('10.30') },
    ]);
    deps.source.seedDay(d('2026-09-18'), [
      { ticker: 'HGLG11', date: d('2026-09-18'), close: Money.fromString('158.40') },
    ]);

    const summary = await backfillCloseGaps(deps);

    expect(summary).toEqual({
      assets: 2,
      recovered: 3,
      stillMissing: 0,
      requests: 3,
      rebuiltFrom: '2026-09-18',
    });
    expect(rebuilds).toEqual(['2026-09-18']);
    expect((await deps.repository.getClosePrice(ITSA4.id, d('2026-09-21')))?.close.toString()).toBe(
      '10.12',
    );
  });

  it('rebuilds nothing when no close was recovered', async () => {
    const { deps, rebuilds } = setup(new Map([[ITSA4.id, [d('2026-09-21')]]]));
    deps.source.seedDay(d('2026-09-21'), []); // published, still no row for ITSA4

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
    expect(deps.source.dayCalls).toEqual([]);
    expect(rebuilds).toEqual([]);
  });
});
