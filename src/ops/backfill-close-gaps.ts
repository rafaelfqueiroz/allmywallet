import { db as globalDb, type Database } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { fetchOfficialCloses, type WantedClose } from '@/core/quotes/fetch-official-closes';
import type { AssetCatalogPort, OfficialCloseSource, PriceQuote } from '@/core/quotes/ports';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import {
  buildOfficialCloseSource,
  buildQuotesComposition,
} from '@/worker/handlers/composition';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';

/**
 * #151, rewritten for #171 onto `fetchOfficialCloses` — retry every recorded
 * close gap a later request may still fill, then rebuild snapshots from the
 * earliest day that gained a close. Every close this recovers is B3's own
 * COTAHIST (BR-008-09), never an intraday-provider quote.
 *
 * Worker-start catch-up (SPEC-021 BR-021-28) only ever looks *forward* from
 * the newest close captured among held assets. So when some assets were
 * captured and others were refused — a missing brapi token quoted three test
 * tickers and nothing else, back when brapi's own history fed this path — the
 * refused days lie behind that point and no later start revisits them. This
 * is the by-hand revisit.
 *
 * Each asset asks only for **its own** recorded gap dates, never the union of
 * every asset's: a union would ask for, and mark as recovered-or-not, days an
 * asset was never missing. `fetchOfficialCloses` classifies every pair; a
 * `found` pair is upserted (`upsertClosePrice`, which clears its gap row in
 * the same transaction — BR-021-31); anything else (`notSupplied`,
 * `unavailable`, `unpublished`) leaves the gap exactly as it was, to be
 * retried on a later run.
 */
export interface BackfillCloseGapsDeps {
  readonly source: OfficialCloseSource;
  readonly repository: { readonly upsertClosePrice: (quote: PriceQuote) => Promise<void> };
  readonly catalog: Pick<AssetCatalogPort, 'findByIds'>;
  readonly retryableGaps: () => Promise<ReadonlyMap<AssetId, readonly BusinessDate[]>>;
  readonly annualFileMinDays: number;
  readonly currentYear: number;
  readonly rebuildSnapshotsFrom: (from: BusinessDate) => Promise<void>;
}

export interface BackfillCloseGapsSummary {
  readonly assets: number;
  readonly recovered: number;
  readonly stillMissing: number;
  readonly requests: number;
  /** `null` when nothing was recovered, so nothing needed rebuilding. */
  readonly rebuiltFrom: BusinessDate | null;
}

export async function backfillCloseGaps(
  deps: BackfillCloseGapsDeps,
): Promise<BackfillCloseGapsSummary> {
  const gapsByAsset = await deps.retryableGaps();
  // Determinism: a nearly-spent run always covers the same assets first.
  // `code` is unique, so no tie-break is needed.
  const assets = [...(await deps.catalog.findByIds([...gapsByAsset.keys()]))].sort((a, b) =>
    a.code < b.code ? -1 : 1,
  );

  const wanted: WantedClose[] = [];
  for (const asset of assets) {
    for (const date of gapsByAsset.get(asset.id) ?? []) {
      wanted.push({ assetId: asset.id, ticker: asset.code, date });
    }
  }

  const result = await fetchOfficialCloses(
    { source: deps.source },
    wanted,
    { annualFileMinDays: deps.annualFileMinDays, currentYear: deps.currentYear },
  );

  let earliest: BusinessDate | null = null;
  for (const pair of result.found) {
    const quote: PriceQuote = {
      assetId: pair.assetId,
      date: pair.date,
      close: pair.close,
      source: deps.source.source,
    };
    await deps.repository.upsertClosePrice(quote);
    if (earliest === null || pair.date < earliest) earliest = pair.date;
  }

  // BR-021-30's rule: one rebuild from the earliest changed day forward.
  if (earliest !== null) await deps.rebuildSnapshotsFrom(earliest);

  return {
    assets: assets.length,
    recovered: result.found.length,
    stillMissing: wanted.length - result.found.length,
    requests: result.requests,
    rebuiltFrom: earliest,
  };
}

export async function buildBackfillCloseGapsDeps(
  database: Database = globalDb,
): Promise<BackfillCloseGapsDeps> {
  const composition = buildQuotesComposition(database);
  const gaps = new DrizzleCloseGapRepository(database);
  const annualFileMinDays = (
    await resolveConfig('quotes.cotahist_annual_min_days', { db: database })
  ).value;
  const { clock, calendar } = composition;
  return {
    source: await buildOfficialCloseSource(database),
    repository: composition.repository,
    catalog: composition.catalog,
    retryableGaps: () => gaps.listRetryableGaps(),
    annualFileMinDays,
    currentYear: Number(clock.today().slice(0, 4)),
    rebuildSnapshotsFrom: async (from) => {
      await handleValuationSnapshot({ from }, { database, clock, calendar });
    },
  };
}
