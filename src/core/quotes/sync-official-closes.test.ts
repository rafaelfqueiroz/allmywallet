import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { Asset } from './ports';
import { syncOfficialCloses } from './sync-official-closes';
import {
  FakeCloseGapRepository,
  FakeOfficialCloseSource,
  FakeQuoteRepository,
  FakeUnofficialClosesPort,
} from './test-support';

/**
 * SPEC-008 BR-008-09/BR-008-30/BR-008-31, SPEC-021 BR-021-28/29/30/31/33
 * (#171) — the shared close job/catch-up use case. `fetch-official-closes.test.ts`
 * covers the day-vs-annual/classification mechanics; this covers the write
 * rules onto `price_quotes`/`price_quote_gaps`.
 */
const d = (value: string): BusinessDate => BusinessDate.of(value);
const OPTIONS = { annualFileMinDays: 100, currentYear: 2026 };

const PETR4: Asset = {
  id: AssetId.generate(),
  code: 'PETR4',
  name: 'Petrobras PN',
  assetClass: 'stock',
};
const VALE3: Asset = {
  id: AssetId.generate(),
  code: 'VALE3',
  name: 'Vale ON',
  assetClass: 'stock',
};
const CDB01: Asset = {
  id: AssetId.generate(),
  code: 'CDB Banco X',
  name: 'CDB Banco X',
  assetClass: 'cdb',
};

function setup() {
  const source = new FakeOfficialCloseSource();
  const repository = new FakeQuoteRepository();
  const gaps = new FakeCloseGapRepository();
  const unofficial = new FakeUnofficialClosesPort();
  return { source, repository, gaps, unofficial };
}

describe('syncOfficialCloses (SPEC-008 BR-008-09/BR-008-30/BR-008-31, SPEC-021 BR-021-28-33)', () => {
  it('a window pair with no stored close is recorded', async () => {
    const ports = setup();
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.recorded.map((q) => [q.date, q.close.toString(), q.source])).toEqual([
      ['2026-03-16', '32.4', 'b3_cotahist'],
    ]);
    expect(summary.superseded).toEqual([]);
    expect(summary.earliestChanged).toBe('2026-03-16');
    expect((await ports.repository.getClosePrice(PETR4.id, d('2026-03-16')))?.source).toBe(
      'b3_cotahist',
    );
  });

  it('a stored brapi_free close in the window is replaced (superseded), not merely left alone', async () => {
    const ports = setup();
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-16'),
      close: Money.fromString('32.00'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.recorded).toEqual([]);
    expect(summary.superseded.map((q) => [q.date, q.close.toString(), q.source])).toEqual([
      ['2026-03-16', '32.4', 'b3_cotahist'],
    ]);
  });

  it('a stored brapi_free close COTAHIST does not supply is deleted and recorded as a gap', async () => {
    const ports = setup();
    // COTAHIST priced PETR4 before, so a day without its row is a gap.
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-13'),
      close: Money.fromString('31.90'),
      source: 'b3_cotahist',
    });
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-16'),
      close: Money.fromString('32.00'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2026-03-16'), []); // published, no row for PETR4

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.removed).toEqual([{ assetId: PETR4.id, date: '2026-03-16' }]);
    expect(summary.gaps).toEqual([
      { assetId: PETR4.id, date: '2026-03-16', reason: 'not_supplied' },
    ]);
    expect(await ports.repository.getClosePrice(PETR4.id, d('2026-03-16'))).toBeNull();
    expect(summary.earliestChanged).toBe('2026-03-16');
  });

  it('not_supplied with nothing stored is only a gap — nothing to delete', async () => {
    const ports = setup();
    // COTAHIST priced PETR4 before, so a day without its row is a gap.
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-13'),
      close: Money.fromString('31.90'),
      source: 'b3_cotahist',
    });
    ports.source.seedDay(d('2026-03-16'), []);

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.removed).toEqual([]);
    expect(summary.gaps).toEqual([
      { assetId: PETR4.id, date: '2026-03-16', reason: 'not_supplied' },
    ]);
    expect(summary.earliestChanged).toBeNull();
  });

  it('unavailable with a stored non-official close leaves it untouched, retried next run', async () => {
    const ports = setup();
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-16'),
      close: Money.fromString('32.00'),
      source: 'brapi_free',
    });
    ports.source.seedDayError(d('2026-03-16'), 'OFFICIAL_CLOSES_UNAVAILABLE');

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.gaps).toEqual([]);
    expect(summary.removed).toEqual([]);
    expect((await ports.repository.getClosePrice(PETR4.id, d('2026-03-16')))?.source).toBe(
      'brapi_free',
    );
  });

  it('unavailable with nothing stored is recorded as a provider_unavailable gap', async () => {
    const ports = setup();
    ports.source.seedDayError(d('2026-03-16'), 'OFFICIAL_CLOSES_UNAVAILABLE');

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.gaps).toEqual([
      { assetId: PETR4.id, date: '2026-03-16', reason: 'provider_unavailable' },
    ]);
  });

  it('unpublished writes nothing and records nothing; a second run after publication records it', async () => {
    const ports = setup();
    // Nothing seeded → NOT_PUBLISHED.
    const first = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);
    expect(first.recorded).toEqual([]);
    expect(first.gaps).toEqual([]);
    expect(first.unpublished).toBe(1);
    expect(await ports.repository.getClosePrice(PETR4.id, d('2026-03-16'))).toBeNull();
    expect(ports.gaps.gaps.size).toBe(0);

    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);
    const second = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);
    expect(second.recorded.map((q) => q.date)).toEqual(['2026-03-16']);
  });

  it('AR-19: a second run with everything already recorded from COTAHIST makes zero source calls', async () => {
    const ports = setup();
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);
    await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    const before = ports.source.dayCalls.length + ports.source.yearCalls.length;
    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);
    const after = ports.source.dayCalls.length + ports.source.yearCalls.length;

    expect(after).toBe(before);
    expect(summary.requests).toBe(0);
    expect(summary.recorded).toEqual([]);
    expect(summary.superseded).toEqual([]);
  });

  it('supersede pairs reach outside the window and cover an asset not currently held', async () => {
    const ports = setup();
    const soldAsset = AssetId.generate();
    // A stale brapi_free close far outside this run's window, on an asset not passed in `assets`.
    ports.unofficial.seed({
      assetId: soldAsset,
      code: 'ITSA4',
      date: d('2024-01-15'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2024-01-15'), [
      { ticker: 'ITSA4', date: d('2024-01-15'), close: Money.fromString('9.80') },
    ]);

    // The run's own window is unrelated (today's close for a different, held asset).
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.superseded.map((q) => [q.assetId, q.date, q.close.toString()])).toEqual([
      [soldAsset, '2024-01-15', '9.8'],
    ]);
    expect(summary.recorded.map((q) => q.date)).toEqual(['2026-03-16']);
  });

  it('a class outside stock/fii/bdr/etf is never asked for, even if passed in `assets`', async () => {
    const ports = setup();
    const summary = await syncOfficialCloses(ports, [CDB01], [d('2026-03-16')], OPTIONS);

    expect(summary.recorded).toEqual([]);
    expect(summary.gaps).toEqual([]);
    expect(ports.source.dayCalls).toEqual([]);
    expect(ports.source.yearCalls).toEqual([]);
  });

  it('earliestChanged is the earliest date written or deleted, across recorded/superseded/removed', async () => {
    const ports = setup();
    await ports.repository.upsertClosePrice({
      assetId: VALE3.id,
      date: d('2026-03-12'),
      close: Money.fromString('61.00'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2026-03-12'), []); // VALE3's stale close is not supplied → deleted
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(
      ports,
      [PETR4, VALE3],
      [d('2026-03-12'), d('2026-03-16')],
      OPTIONS,
    );

    expect(summary.earliestChanged).toBe('2026-03-12');
  });

  it('earliestChanged is null when nothing was written or deleted', async () => {
    const ports = setup();
    ports.source.seedDayError(d('2026-03-16'), 'OFFICIAL_CLOSES_UNAVAILABLE');
    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);
    expect(summary.earliestChanged).toBeNull();
  });

  it('an empty asset list, or an empty day window, makes no source call', async () => {
    const ports = setup();
    expect((await syncOfficialCloses(ports, [], [d('2026-03-16')], OPTIONS)).requests).toBe(0);
    expect((await syncOfficialCloses(ports, [PETR4], [], OPTIONS)).requests).toBe(0);
    expect(ports.source.dayCalls).toEqual([]);
  });
  it('a retryable gap outside the window is asked again: filled when COTAHIST has it, counted unavailable when it cannot be read', async () => {
    const ports = setup();
    // Brapi-era gaps (relabelled retryable by migration 0031), long before this run's window.
    ports.unofficial.seedRetryableGap({ assetId: VALE3.id, code: 'VALE3', date: d('2026-01-12') });
    ports.unofficial.seedRetryableGap({ assetId: VALE3.id, code: 'VALE3', date: d('2026-01-13') });
    ports.source.seedDay(d('2026-01-12'), [
      { ticker: 'VALE3', date: d('2026-01-12'), close: Money.fromString('55.10') },
    ]);
    ports.source.seedDayError(d('2026-01-13'), 'OFFICIAL_CLOSES_UNAVAILABLE');

    const summary = await syncOfficialCloses(ports, [PETR4], [], OPTIONS);

    expect(summary.recorded.map((q) => [q.date, q.close.toString()])).toEqual([
      ['2026-01-12', '55.1'],
    ]);
    expect(summary.unavailable).toBe(1);
    expect(summary.gaps).toEqual([
      { assetId: VALE3.id, date: '2026-01-13', reason: 'provider_unavailable' },
    ]);
    expect(summary.earliestChanged).toBe('2026-01-12');
  });

  it('a retryable gap inside the window is asked for once, not twice', async () => {
    const ports = setup();
    ports.unofficial.seedRetryableGap({ assetId: PETR4.id, code: 'PETR4', date: d('2026-03-16') });
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(summary.recorded).toHaveLength(1);
    expect(summary.requests).toBe(1);
  });

  it('a close COTAHIST does not supply is recorded as a gap before the stored close is deleted', async () => {
    // A crash between the two must leave the non-official close in place, so
    // the next run asks again — never a day with neither a close nor a gap.
    const ports = setup();
    // COTAHIST priced PETR4 before, so a day without its row is a gap.
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-13'),
      close: Money.fromString('31.90'),
      source: 'b3_cotahist',
    });
    const order: string[] = [];
    const recordGap = ports.gaps.recordGap.bind(ports.gaps);
    ports.gaps.recordGap = async (gap) => {
      order.push('gap');
      await recordGap(gap);
    };
    const deleteClose = ports.repository.deleteClose.bind(ports.repository);
    ports.repository.deleteClose = async (assetId, date) => {
      order.push('delete');
      await deleteClose(assetId, date);
    };
    await ports.repository.upsertClosePrice({
      assetId: PETR4.id,
      date: d('2026-03-16'),
      close: Money.fromString('32.00'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'VALE3', date: d('2026-03-16'), close: Money.fromString('60.00') },
    ]);

    await syncOfficialCloses(ports, [PETR4], [d('2026-03-16')], OPTIONS);

    expect(order).toEqual(['gap', 'delete']);
  });
  it('an asset COTAHIST has never priced is not a gap: no row, no gap, and a stale gap is cleared', async () => {
    const ports = setup();
    // A held instrument B3's spot market has never listed (a debenture, a
    // subscription right): every day's file lacks it.
    await ports.gaps.recordGap({
      assetId: VALE3.id,
      date: d('2026-03-16'),
      reason: 'provider_unavailable',
    });
    ports.source.seedDay(d('2026-03-16'), [
      { ticker: 'PETR4', date: d('2026-03-16'), close: Money.fromString('32.40') },
    ]);

    const summary = await syncOfficialCloses(ports, [PETR4, VALE3], [d('2026-03-16')], OPTIONS);

    expect(summary.gaps).toEqual([]);
    expect(ports.gaps.gaps.size).toBe(0);
    expect(summary.recorded.map((q) => q.assetId)).toEqual([PETR4.id]);
  });

  it('a close found earlier in the same run counts: the next unsupplied day is a gap', async () => {
    const ports = setup();
    ports.source.seedDay(d('2026-03-13'), [
      { ticker: 'VALE3', date: d('2026-03-13'), close: Money.fromString('60.10') },
    ]);
    ports.source.seedDay(d('2026-03-16'), []);

    const summary = await syncOfficialCloses(
      ports,
      [VALE3],
      [d('2026-03-13'), d('2026-03-16')],
      OPTIONS,
    );

    expect(summary.gaps).toEqual([
      { assetId: VALE3.id, date: '2026-03-16', reason: 'not_supplied' },
    ]);
  });

  it('a brapi close for an asset COTAHIST has never priced is deleted without a gap', async () => {
    const ports = setup();
    await ports.repository.upsertClosePrice({
      assetId: VALE3.id,
      date: d('2026-03-16'),
      close: Money.fromString('55.00'),
      source: 'brapi_free',
    });
    ports.source.seedDay(d('2026-03-16'), []);

    const summary = await syncOfficialCloses(ports, [VALE3], [d('2026-03-16')], OPTIONS);

    expect(summary.removed).toEqual([{ assetId: VALE3.id, date: '2026-03-16' }]);
    expect(summary.gaps).toEqual([]);
    expect(summary.earliestChanged).toBe('2026-03-16');
  });
});
