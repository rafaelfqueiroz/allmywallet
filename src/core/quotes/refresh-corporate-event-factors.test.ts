import { describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import type {
  CorporateEventFactor,
  CorporateEventFactorFetch,
  CorporateEventFactorFetchRecord,
  CorporateEventFactorSource,
  CorporateEventFactorStore,
} from './corporate-event-factors';
import { refreshCorporateEventFactors } from './refresh-corporate-event-factors';

/** TS-02 — a hand-written fake, not a mocking library. */
class FakeFactorSource implements CorporateEventFactorSource {
  readonly calls: string[] = [];
  private readonly responses = new Map<string, CorporateEventFactorFetch>();

  respondWith(issuerCode: string, fetch: CorporateEventFactorFetch): void {
    this.responses.set(issuerCode, fetch);
  }

  async fetchIssuer(issuerCode: string): Promise<CorporateEventFactorFetch> {
    this.calls.push(issuerCode);
    return this.responses.get(issuerCode) ?? { outcome: 'not_listed' };
  }
}

class FakeFactorStore implements CorporateEventFactorStore {
  private readonly fetches = new Map<string, CorporateEventFactorFetchRecord>();
  private readonly factors = new Map<string, CorporateEventFactor[]>();
  readonly recorded: { issuerCode: string; fetch: CorporateEventFactorFetch }[] = [];

  seedLastFetch(record: CorporateEventFactorFetchRecord): void {
    this.fetches.set(record.issuerCode, record);
  }

  async listByIssuers(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly CorporateEventFactor[]>> {
    const result = new Map<string, readonly CorporateEventFactor[]>();
    for (const code of issuerCodes) {
      const found = this.factors.get(code);
      if (found) result.set(code, found);
    }
    return result;
  }

  async lastFetches(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, CorporateEventFactorFetchRecord>> {
    const result = new Map<string, CorporateEventFactorFetchRecord>();
    for (const code of issuerCodes) {
      const record = this.fetches.get(code);
      if (record) result.set(code, record);
    }
    return result;
  }

  async recordFetch(
    issuerCode: string,
    fetch: CorporateEventFactorFetch,
    fetchedAt: Date,
  ): Promise<void> {
    this.recorded.push({ issuerCode, fetch });
    this.fetches.set(issuerCode, { issuerCode, fetchedAt, outcome: fetch.outcome });
  }
}

const REFRESH_AGE_DAYS = 7;
const NOW = '2026-03-16T12:00:00Z';

describe('refreshCorporateEventFactors (SPEC-008 BR-008-29, #113)', () => {
  it('a never-fetched issuer is fetched', async () => {
    const source = new FakeFactorSource();
    source.respondWith('MGLU', { outcome: 'ok', factors: [] });
    const store = new FakeFactorStore();

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual(['MGLU']);
    expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0 });
  });

  it('a fresh (within refreshAgeDays) ok fetch is skipped, not refetched', async () => {
    const source = new FakeFactorSource();
    const store = new FakeFactorStore();
    store.seedLastFetch({
      issuerCode: 'MGLU',
      outcome: 'ok',
      fetchedAt: new Date('2026-03-14T12:00:00Z'), // 2 days before NOW, < 7
    });

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual([]);
    expect(summary).toEqual({ fetched: 0, skipped: 1, failed: 0 });
  });

  it('a fresh not_listed fetch is also skipped — not_listed obeys the same age rule as ok', async () => {
    const source = new FakeFactorSource();
    const store = new FakeFactorStore();
    store.seedLastFetch({
      issuerCode: 'HGLG',
      outcome: 'not_listed',
      fetchedAt: new Date('2026-03-14T12:00:00Z'),
    });

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['HGLG'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual([]);
    expect(summary).toEqual({ fetched: 0, skipped: 1, failed: 0 });
  });

  it('a stale fetch (older than refreshAgeDays) is refetched', async () => {
    const source = new FakeFactorSource();
    source.respondWith('MGLU', { outcome: 'ok', factors: [] });
    const store = new FakeFactorStore();
    store.seedLastFetch({
      issuerCode: 'MGLU',
      outcome: 'ok',
      fetchedAt: new Date('2026-03-01T12:00:00Z'), // 15 days before NOW, >= 7
    });

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual(['MGLU']);
    expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0 });
  });

  it('a failed fetch is always refetched, however recent', async () => {
    const source = new FakeFactorSource();
    source.respondWith('MGLU', { outcome: 'ok', factors: [] });
    const store = new FakeFactorStore();
    store.seedLastFetch({
      issuerCode: 'MGLU',
      outcome: 'failed',
      fetchedAt: new Date('2026-03-16T11:59:00Z'), // one minute ago
    });

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual(['MGLU']);
    expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0 });
  });

  it('duplicates in the input issuer list are fetched once', async () => {
    const source = new FakeFactorSource();
    source.respondWith('MGLU', { outcome: 'ok', factors: [] });
    const store = new FakeFactorStore();

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU', 'MGLU', 'MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual(['MGLU']);
    expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 0 });
  });

  it('a source failure is recorded via the store, never thrown, and counted as failed', async () => {
    const source = new FakeFactorSource();
    source.respondWith('MGLU', { outcome: 'failed', failureCode: 'timeout' });
    const store = new FakeFactorStore();

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      ['MGLU'],
      REFRESH_AGE_DAYS,
    );

    expect(summary).toEqual({ fetched: 1, skipped: 0, failed: 1 });
    expect(store.recorded).toEqual([
      { issuerCode: 'MGLU', fetch: { outcome: 'failed', failureCode: 'timeout' } },
    ]);
  });

  it('an empty issuer list does nothing', async () => {
    const source = new FakeFactorSource();
    const store = new FakeFactorStore();

    const summary = await refreshCorporateEventFactors(
      { source, store, clock: new FakeClock(NOW) },
      [],
      REFRESH_AGE_DAYS,
    );

    expect(source.calls).toEqual([]);
    expect(summary).toEqual({ fetched: 0, skipped: 0, failed: 0 });
  });
});
