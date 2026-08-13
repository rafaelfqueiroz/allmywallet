import { logger } from '@/lib/logger';
import { BusinessDate, type Clock } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import type {
  IndexSeriesCode,
  IndexSeriesProvider,
  IndexSeriesRepositoryPort,
  QuoteProvider,
} from '@/core/quotes/ports';
import {
  buildIndexSeriesProvider,
  buildQuoteProvider,
  buildQuotesComposition,
} from './composition';

export interface BcbSyncDeps {
  readonly clock: Clock;
  readonly indexSeriesRepository: IndexSeriesRepositoryPort;
  readonly provider: IndexSeriesProvider;
  readonly quoteProvider: QuoteProvider;
}

/**
 * SPEC-008 `bcb.sync` — BCB SGS series 12 (CDI), 433 (IPCA), 11 (Selic),
 * fetched once daily. "Backfill history" (spec AC) means: on first load
 * (nothing stored yet) fetch from `BACKFILL_START`; every later run fetches
 * only since the latest stored point, so a daily sync is a small
 * incremental request, not a full re-download.
 *
 * `BACKFILL_START` is a one-time technical default for how far back the
 * initial load reaches, not a business threshold — SPEC-002's registry
 * governs cadences/thresholds/budgets an operator tunes; this is neither.
 */
const BACKFILL_START = BusinessDate.of('2000-01-01');
const SGS_CODES: readonly IndexSeriesCode[] = ['CDI', 'IPCA', 'SELIC'];

export async function handleBcbSync(overrides?: Partial<BcbSyncDeps>): Promise<void> {
  const composition = buildQuotesComposition();
  const clock = overrides?.clock ?? composition.clock;
  const indexSeriesRepository =
    overrides?.indexSeriesRepository ?? composition.indexSeriesRepository;
  const provider = overrides?.provider ?? buildIndexSeriesProvider();

  let totalPoints = 0;
  for (const code of SGS_CODES) {
    const latest = await indexSeriesRepository.latestDate(code);
    const since = latest ?? BACKFILL_START;
    const fetched = await provider.fetchSeries(code, since);
    if (!fetched.ok) {
      logger.error({ queue: 'bcb.sync', code, err: fetched.error }, 'bcb.sync fetch failed');
      continue;
    }
    // AR-19: `upsertPoints` is keyed `(code, date)` — a retried sync for
    // dates already stored overwrites with the same values, not a duplicate.
    await indexSeriesRepository.upsertPoints(fetched.value);
    totalPoints += fetched.value.length;
  }

  // IBOV is not a BCB SGS series (see bcb-sgs.ts) — fetched via the same
  // QuoteProvider equities use, once daily, and stored as an index point
  // rather than a held-asset quote. A pragmatic decision, flagged in the
  // dispatch report: the spec's Description lists IBOV alongside the BCB
  // series but names no source for it, and no BR/AC in scope tests it
  // directly.
  const quoteProvider = overrides?.quoteProvider ?? (await buildQuoteProvider());
  const ibov = await quoteProvider.fetchQuote('^BVSP');
  if (ibov.ok) {
    // Money and Quantity are both plain-decimal wrappers over the same
    // string representation (core/shared/money.ts) — round-tripping through
    // the string, not a JS number, keeps AR-06 intact while converting
    // between the two branded types.
    await indexSeriesRepository.upsertPoints([
      {
        code: 'IBOV',
        date: clock.today(),
        value: Quantity.fromString(ibov.value.price.toString()),
        source: ibov.value.source,
      },
    ]);
    totalPoints += 1;
  } else {
    logger.warn({ queue: 'bcb.sync', err: ibov.error }, 'bcb.sync: IBOV fetch failed');
  }

  logger.info({ queue: 'bcb.sync', totalPoints }, 'bcb.sync cycle complete');
}
