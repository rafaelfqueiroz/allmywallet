import { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { OfficialCloseSourceErrorCode, type OfficialClosesFile, type OfficialCloseSource } from './ports';

/**
 * SPEC-008 BR-008-09/BR-008-30 (#171) — pure orchestration over
 * `OfficialCloseSource`. Writes nothing; `sync-official-closes.ts` is what
 * turns its four outcome lists into `price_quotes`/`price_quote_gaps` rows.
 *
 * One `(assetId, date)` pair the caller wants a close for.
 */
export interface WantedClose {
  readonly assetId: AssetId;
  /** `CODNEG` — the catalog's `code`, what `OfficialClose.ticker` is keyed on. */
  readonly ticker: string;
  readonly date: BusinessDate;
}

export interface FoundClose extends WantedClose {
  readonly close: Money;
}

export interface FetchOfficialClosesResult {
  readonly found: readonly FoundClose[];
  /** File published (date ≤ `lastDate`), no row for the ticker. */
  readonly notSupplied: readonly WantedClose[];
  /** `OfficialCloseSourceErrorCode.UNAVAILABLE` — a fault, not a day the file lacks. */
  readonly unavailable: readonly WantedClose[];
  /** `NOT_PUBLISHED`, or `lastDate === null`, or the date is after `lastDate`. */
  readonly unpublished: readonly WantedClose[];
  /** `OfficialCloseSource` calls actually made. */
  readonly requests: number;
}

export interface FetchOfficialClosesOptions {
  /** `quotes.cotahist_annual_min_days` — the threshold to read a year's annual file instead of its daily files. */
  readonly annualFileMinDays: number;
  /** The current year, in the caller's clock — bounds the NOT_PUBLISHED → annual-file fallback to past years. */
  readonly currentYear: number;
}

function yearOf(date: BusinessDate): number {
  return Number(date.slice(0, 4));
}

function byTickerThenDate(a: WantedClose, b: WantedClose): number {
  if (a.ticker !== b.ticker) return a.ticker < b.ticker ? -1 : 1;
  return BusinessDate.compare(a.date, b.date);
}

const EMPTY_RESULT: FetchOfficialClosesResult = {
  found: [],
  notSupplied: [],
  unavailable: [],
  unpublished: [],
  requests: 0,
};

/**
 * SPEC-008 BR-008-09/BR-008-30 (#171).
 *
 * Groups `wanted` by year. A year whose distinct wanted days meet
 * `annualFileMinDays` is read as one `fetchYear` call; otherwise each
 * distinct day is its own `fetchDay` call, ascending.
 *
 * A `fetchDay` that comes back `NOT_PUBLISHED` for a day in a year **before**
 * `currentYear` falls back to that year's annual file once — B3 may not keep
 * every daily file — and the annual file then answers that day and every
 * later day of the same year still pending, rather than one `fetchDay` each.
 * `NOT_PUBLISHED` in the current year is never retried this way: the file
 * simply is not out yet, and asking for the whole year's annual archive would
 * not change that.
 *
 * Every wanted pair is classified exactly once, in a deterministic order
 * (ticker, then date, within each year/day group) so a retried or repeated
 * run of the same `wanted` set reads identically (AR-19).
 */
export async function fetchOfficialCloses(
  ports: { readonly source: OfficialCloseSource },
  wanted: readonly WantedClose[],
  options: FetchOfficialClosesOptions,
): Promise<FetchOfficialClosesResult> {
  if (wanted.length === 0) return EMPTY_RESULT;

  const found: FoundClose[] = [];
  const notSupplied: WantedClose[] = [];
  const unavailable: WantedClose[] = [];
  const unpublished: WantedClose[] = [];
  let requests = 0;

  const byYear = new Map<number, WantedClose[]>();
  for (const pair of wanted) {
    const year = yearOf(pair.date);
    const list = byYear.get(year);
    if (list) list.push(pair);
    else byYear.set(year, [pair]);
  }

  function classify(file: OfficialClosesFile, pairs: readonly WantedClose[]): void {
    const byKey = new Map(file.closes.map((close) => [`${close.ticker}:${close.date}`, close]));
    for (const pair of pairs) {
      if (file.lastDate === null || BusinessDate.isAfter(pair.date, file.lastDate)) {
        unpublished.push(pair);
        continue;
      }
      const row = byKey.get(`${pair.ticker}:${pair.date}`);
      if (row) found.push({ ...pair, close: row.close });
      else notSupplied.push(pair);
    }
  }

  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const yearPairs = [...(byYear.get(year) ?? [])].sort(byTickerThenDate);
    const distinctDays = new Set(yearPairs.map((pair) => pair.date)).size;

    if (distinctDays >= options.annualFileMinDays) {
      const tickers = new Set(yearPairs.map((pair) => pair.ticker));
      requests += 1;
      const result = await ports.source.fetchYear(year, tickers);
      if (!result.ok) {
        const bucket =
          result.error.code === OfficialCloseSourceErrorCode.NOT_PUBLISHED ? unpublished : unavailable;
        bucket.push(...yearPairs);
        continue;
      }
      classify(result.value, yearPairs);
      continue;
    }

    const byDay = new Map<BusinessDate, WantedClose[]>();
    for (const pair of yearPairs) {
      const list = byDay.get(pair.date);
      if (list) list.push(pair);
      else byDay.set(pair.date, [pair]);
    }
    const days = [...byDay.keys()].sort();

    // Once this year falls back to its annual file, every remaining day is
    // answered from it too, rather than one more `fetchDay` each.
    let fallback: { readonly outcome: 'file'; readonly file: OfficialClosesFile } | { readonly outcome: 'unavailable' | 'unpublished' } | null = null;

    for (const day of days) {
      const dayPairs = [...(byDay.get(day) ?? [])].sort(byTickerThenDate);

      if (fallback) {
        if (fallback.outcome === 'file') classify(fallback.file, dayPairs);
        else if (fallback.outcome === 'unavailable') unavailable.push(...dayPairs);
        else unpublished.push(...dayPairs);
        continue;
      }

      const tickers = new Set(dayPairs.map((pair) => pair.ticker));
      requests += 1;
      const result = await ports.source.fetchDay(day, tickers);
      if (result.ok) {
        classify(result.value, dayPairs);
        continue;
      }

      if (result.error.code !== OfficialCloseSourceErrorCode.NOT_PUBLISHED) {
        unavailable.push(...dayPairs);
        continue;
      }

      if (year >= options.currentYear) {
        unpublished.push(...dayPairs);
        continue;
      }

      // Fall back to the annual file, once, for this day and every later
      // pending day of the same year.
      const remainingTickers = new Set(
        days.filter((d) => !BusinessDate.isBefore(d, day)).flatMap((d) => (byDay.get(d) ?? []).map((pair) => pair.ticker)),
      );
      requests += 1;
      const annual = await ports.source.fetchYear(year, remainingTickers);
      if (!annual.ok) {
        fallback = {
          outcome: annual.error.code === OfficialCloseSourceErrorCode.NOT_PUBLISHED ? 'unpublished' : 'unavailable',
        };
        if (fallback.outcome === 'unavailable') unavailable.push(...dayPairs);
        else unpublished.push(...dayPairs);
        continue;
      }
      fallback = { outcome: 'file', file: annual.value };
      classify(annual.value, dayPairs);
    }
  }

  return { found, notSupplied, unavailable, unpublished, requests };
}
