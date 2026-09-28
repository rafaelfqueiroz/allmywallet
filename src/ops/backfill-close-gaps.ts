import { db as globalDb, type Database } from '@/db/client';
import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { backfillMissedCloses, type BackfillPorts } from '@/core/quotes/backfill-missed-closes';
import type { AssetCatalogPort } from '@/core/quotes/ports';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import {
  buildQuoteProvider,
  buildQuotesComposition,
  resolveQuoteBudgetConfig,
} from '@/worker/handlers/composition';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';

/**
 * #151 — retry every recorded close gap a later request may still fill, then
 * rebuild snapshots from the earliest day that gained a close.
 *
 * Worker-start catch-up (SPEC-021 BR-021-28) only ever looks *forward* from
 * the newest close captured among held assets. So when some assets were
 * captured and others were refused — a missing brapi token quoted three test
 * tickers and nothing else — the refused days lie behind that point and no
 * later start revisits them. This is the by-hand revisit.
 *
 * Each asset goes through `backfillMissedCloses` with **its own** gap dates,
 * never the union of every asset's: a union would ask for, and then mark as
 * `not_supplied`, days an asset was never missing. Budget, idempotence and
 * "never touches `latest_quotes`" are that use case's rules (BR-021-31–33),
 * unchanged here.
 */
export interface BackfillCloseGapsDeps extends BackfillPorts {
  readonly catalog: Pick<AssetCatalogPort, 'findByIds'>;
  readonly retryableGaps: () => Promise<ReadonlyMap<AssetId, readonly BusinessDate[]>>;
  readonly budget: { readonly monthlyQuota: number; readonly ondemandReservePct: number };
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
  // Determinism, as in `backfillMissedCloses`: a nearly-spent budget always
  // covers the same assets. `code` is unique, so no tie-break is needed.
  const assets = [...(await deps.catalog.findByIds([...gapsByAsset.keys()]))].sort((a, b) =>
    a.code < b.code ? -1 : 1,
  );

  let recovered = 0;
  let stillMissing = 0;
  let requests = 0;
  let earliest: BusinessDate | null = null;
  for (const asset of assets) {
    const days = gapsByAsset.get(asset.id) ?? [];
    const summary = await backfillMissedCloses(deps, [asset], days, deps.budget);
    recovered += summary.recovered.length;
    stillMissing += summary.gaps.length;
    requests += summary.requests;
    for (const quote of summary.recovered) {
      if (earliest === null || quote.date < earliest) earliest = quote.date;
    }
  }

  // BR-021-30's rule: one rebuild from the earliest changed day forward.
  if (earliest !== null) await deps.rebuildSnapshotsFrom(earliest);

  return { assets: assets.length, recovered, stillMissing, requests, rebuiltFrom: earliest };
}

export async function buildBackfillCloseGapsDeps(
  database: Database = globalDb,
): Promise<BackfillCloseGapsDeps> {
  const composition = buildQuotesComposition(database);
  const gaps = new DrizzleCloseGapRepository(database);
  const { monthlyQuota, ondemandReservePct } = await resolveQuoteBudgetConfig(database);
  const { clock, calendar } = composition;
  return {
    repository: composition.repository,
    budgetCounter: composition.budgetCounter,
    clock,
    catalog: composition.catalog,
    provider: await buildQuoteProvider(database),
    gaps,
    retryableGaps: () => gaps.listRetryableGaps(),
    budget: { monthlyQuota, ondemandReservePct },
    rebuildSnapshotsFrom: async (from) => {
      await handleValuationSnapshot({ from }, { database, clock, calendar });
    },
  };
}
