import { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { isIntradayEligible } from './polling-set';
import { fetchOfficialCloses, type FetchOfficialClosesOptions, type WantedClose } from './fetch-official-closes';
import {
  CloseGapReason,
  type Asset,
  type CloseGap,
  type CloseGapRepositoryPort,
  type OfficialCloseSource,
  type PriceQuote,
  type QuoteRepositoryPort,
  type UnofficialClosesPort,
} from './ports';

export interface SyncOfficialClosesRepository
  extends Pick<QuoteRepositoryPort, 'getClosePrice' | 'upsertClosePrice'> {
  /** BR-021-31: a close COTAHIST no longer supplies for a day must not stay in history. */
  deleteClose(assetId: AssetId, date: BusinessDate): Promise<void>;
}

export interface SyncOfficialClosesPorts {
  readonly source: OfficialCloseSource;
  readonly repository: SyncOfficialClosesRepository;
  readonly gaps: CloseGapRepositoryPort;
  readonly unofficial: UnofficialClosesPort;
}

export type SyncOfficialClosesOptions = FetchOfficialClosesOptions;

export interface RemovedClose {
  readonly assetId: AssetId;
  readonly date: BusinessDate;
}

export interface SyncOfficialClosesSummary {
  /** Written where no close existed before. */
  readonly recorded: readonly PriceQuote[];
  /** Written over a stored close from a different (non-COTAHIST) source. */
  readonly superseded: readonly PriceQuote[];
  /** Deleted: a stored non-official close COTAHIST does not supply for that day. */
  readonly removed: readonly RemovedClose[];
  readonly gaps: readonly CloseGap[];
  /** Count only — nothing is written or recorded for an unpublished day (BR-008-09). */
  readonly unpublished: number;
  readonly requests: number;
  /** Earliest date written or deleted; `null` when nothing changed. */
  readonly earliestChanged: BusinessDate | null;
}

interface Candidate {
  readonly assetId: AssetId;
  readonly ticker: string;
  readonly date: BusinessDate;
  /** Whether a close (necessarily not from COTAHIST — see how this map is built) already existed. */
  readonly hadPriorClose: boolean;
}

function candidateKey(assetId: AssetId, date: BusinessDate): string {
  return `${assetId}:${date}`;
}

/**
 * SPEC-008 BR-008-09/BR-008-30/BR-008-31, SPEC-021 BR-021-28/29/30/31/33
 * (#171) — the one use case both `quotes.close-capture` and worker-start
 * catch-up run: bring `price_quotes` for the given (already listed-class)
 * assets and window into agreement with B3's COTAHIST, the only source an
 * official close is ever read from (BR-008-09) — an intraday-provider quote
 * is never written here.
 *
 * Two independent reasons a pair is wanted:
 *
 *   (a) **window pairs** — for each asset × day in `days`, no close is
 *       stored yet, or the stored one is not from `source.source` (a
 *       `brapi_free` leftover BR-008-09 says must be superseded);
 *   (b) **supersede pairs** — every stored listed-asset close not from
 *       `source.source`, at *any* date, for *any* asset, held or not
 *       (`UnofficialClosesPort`). BR-008-09's supersession is not bounded by
 *       this run's own window: a close in history must never disagree with
 *       B3 about a day COTAHIST covers, however old or however long ago the
 *       asset was sold.
 *
 * `deleteClose`+`recordGap(not_supplied)` when a stored non-official close
 * turns out unsupplied by COTAHIST (BR-021-31: a gap row and a close for the
 * same day never coexist) — the plain `recordGap` when nothing was ever
 * stored. An `unavailable` day with a stored non-official close is left
 * alone (retried next run); one with nothing stored becomes a
 * `provider_unavailable` gap. An `unpublished` day writes and records
 * nothing — BR-008-09 says it is retried, never filled or marked.
 *
 * BR-021-32 (the monthly brapi quota) does not apply here — COTAHIST is a
 * public archive, not the brapi budget that rule governs — so nothing below
 * checks or charges one; satisfied vacuously.
 */
export async function syncOfficialCloses(
  ports: SyncOfficialClosesPorts,
  assets: readonly Asset[],
  days: readonly BusinessDate[],
  options: SyncOfficialClosesOptions,
): Promise<SyncOfficialClosesSummary> {
  // BR-008-11: only listed classes (stock/fii/bdr/etf) have a COTAHIST close.
  const listed = assets.filter((asset) => isIntradayEligible(asset.assetClass));
  const orderedAssets = [...listed].sort((a, b) => (a.code < b.code ? -1 : 1));
  const orderedDays = [...days].sort();

  const candidates = new Map<string, Candidate>();

  // (a) window pairs.
  for (const asset of orderedAssets) {
    for (const date of orderedDays) {
      const existing = await ports.repository.getClosePrice(asset.id, date);
      if (existing !== null && existing.source === ports.source.source) continue;
      candidates.set(candidateKey(asset.id, date), {
        assetId: asset.id,
        ticker: asset.code,
        date,
        hadPriorClose: existing !== null,
      });
    }
  }

  // (b) supersede pairs.
  const unofficial = await ports.unofficial.listUnofficialListedCloses(ports.source.source);
  for (const entry of unofficial) {
    candidates.set(candidateKey(entry.assetId, entry.date), {
      assetId: entry.assetId,
      ticker: entry.code,
      date: entry.date,
      hadPriorClose: true,
    });
  }

  const wanted: WantedClose[] = [...candidates.values()]
    .sort((a, b) => {
      if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
      return BusinessDate.compare(a.date, b.date);
    })
    .map(({ assetId, ticker, date }) => ({ assetId, ticker, date }));

  const result = await fetchOfficialCloses({ source: ports.source }, wanted, options);

  const recorded: PriceQuote[] = [];
  const superseded: PriceQuote[] = [];
  const removed: RemovedClose[] = [];
  const gaps: CloseGap[] = [];
  let earliestChanged: BusinessDate | null = null;

  function noteChanged(date: BusinessDate): void {
    if (earliestChanged === null || BusinessDate.isBefore(date, earliestChanged)) {
      earliestChanged = date;
    }
  }

  function candidateFor(assetId: AssetId, date: BusinessDate): Candidate {
    const candidate = candidates.get(candidateKey(assetId, date));
    if (!candidate) {
      // Every pair `fetchOfficialCloses` classifies came from `wanted`, built
      // from `candidates` above — reaching here would be this function's own bug.
      throw new Error('syncOfficialCloses: classified pair outside the wanted set');
    }
    return candidate;
  }

  for (const pair of result.found) {
    const quote: PriceQuote = {
      assetId: pair.assetId,
      date: pair.date,
      close: pair.close,
      source: ports.source.source,
    };
    await ports.repository.upsertClosePrice(quote);
    noteChanged(pair.date);
    if (candidateFor(pair.assetId, pair.date).hadPriorClose) superseded.push(quote);
    else recorded.push(quote);
  }

  for (const pair of result.notSupplied) {
    if (candidateFor(pair.assetId, pair.date).hadPriorClose) {
      await ports.repository.deleteClose(pair.assetId, pair.date);
      removed.push({ assetId: pair.assetId, date: pair.date });
      noteChanged(pair.date);
    }
    const gap: CloseGap = { assetId: pair.assetId, date: pair.date, reason: CloseGapReason.NOT_SUPPLIED };
    await ports.gaps.recordGap(gap);
    gaps.push(gap);
  }

  for (const pair of result.unavailable) {
    if (candidateFor(pair.assetId, pair.date).hadPriorClose) continue; // retried next run
    const gap: CloseGap = {
      assetId: pair.assetId,
      date: pair.date,
      reason: CloseGapReason.PROVIDER_UNAVAILABLE,
    };
    await ports.gaps.recordGap(gap);
    gaps.push(gap);
  }

  // result.unpublished: BR-008-09 — nothing written, nothing recorded.

  return {
    recorded,
    superseded,
    removed,
    gaps,
    unpublished: result.unpublished.length,
    requests: result.requests,
    earliestChanged,
  };
}
