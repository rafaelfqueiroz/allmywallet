import { logger } from '@/lib/logger';
import { enqueue } from '@/lib/queue';
import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import type {
  AssetCatalogPort,
  CloseHistoryWriterPort,
  TesouroPriceProvider,
} from '@/core/quotes/ports';
import { QUEUE } from '@/worker/queues';
import type { SnapshotJobPayload } from '@/worker/handlers/valuation';
import { buildQuotesComposition, buildTesouroProvider } from './composition';

export interface TesouroSyncDeps {
  readonly catalog: AssetCatalogPort;
  readonly repository: CloseHistoryWriterPort;
  readonly provider: TesouroPriceProvider;
  /** Durable: a queued `valuation.snapshot` job, never a rebuild run in-line. */
  readonly enqueueSnapshotRebuild: (from: BusinessDate) => Promise<void>;
}

/**
 * SPEC-008 `tesouro.sync` — BR-008-12: Tesouro Direto prices are fetched
 * once daily, as often as Tesouro Transparente publishes. Titles are
 * onboarded into the `assets` catalog on first sight (AssetCatalogPort
 * .upsertByCode) and priced into `price_quotes`, the same authoritative
 * table `quotes.close-capture` writes to for equities — a Tesouro title has
 * no intraday quote to speak of, so it never touches `latest_quotes`.
 *
 * #161 — "backfill history" (SPEC-008's AC) and SPEC-021 BR-021-29: the file
 * is every title's whole history, and every run stores whatever of it is not
 * stored yet. A day the laptop was closed at 18:30, a file published after
 * the run, and everything before the first run are all filled by the next
 * run, with nothing to remember about which runs were missed. Matured titles
 * are catalogued and priced too: a title held until it matured
 * (`Tesouro Selic 2025`) has a value on every day it was held.
 *
 * **Snapshots for the filled days** (BR-021-30, BR-009-18): the run queues a
 * `valuation.snapshot` from the earliest day it filled, for every tenant. A
 * queued job, not a rebuild in-line and not the 19:40 cron: a filled day is
 * missing from no later run, so the one run that filled it is the only one
 * that knows to rebuild — and pg-boss keeps a queued job across a sleeping
 * laptop and a killed worker, where it drops a missed cron and loses an
 * in-flight rebuild. The job is queued after the closes commit, so it never
 * reads a history without them.
 *
 * AR-19: only missing `(asset, date)` closes are inserted, so a retried or
 * repeated sync writes nothing and queues nothing.
 */
export async function handleTesouroSync(overrides?: Partial<TesouroSyncDeps>): Promise<void> {
  const composition = buildQuotesComposition();
  const catalog = overrides?.catalog ?? composition.catalog;
  const repository = overrides?.repository ?? composition.repository;
  const provider = overrides?.provider ?? buildTesouroProvider();
  const enqueueSnapshotRebuild =
    overrides?.enqueueSnapshotRebuild ??
    ((from: BusinessDate) =>
      enqueue(QUEUE.VALUATION_SNAPSHOT, { from } satisfies SnapshotJobPayload));

  const fetched = await provider.fetchDailyPrices();
  if (!fetched.ok) {
    logger.error({ queue: 'tesouro.sync', err: fetched.error }, 'tesouro.sync fetch failed');
    return;
  }

  // One catalogue upsert per title, not per published day.
  const idByCode = new Map<string, AssetId>();
  for (const point of fetched.value) {
    if (idByCode.has(point.ticker)) continue;
    const asset = await catalog.upsertByCode({
      code: point.ticker,
      name: point.ticker,
      assetClass: 'tesouro_direto',
    });
    idByCode.set(point.ticker, asset.id);
  }

  const { inserted, earliest } = await repository.insertMissingCloses(
    fetched.value.map((point) => ({
      assetId: idByCode.get(point.ticker) as AssetId,
      date: point.date,
      close: point.price,
      source: point.source,
    })),
  );
  if (earliest !== null) await enqueueSnapshotRebuild(earliest);

  logger.info(
    { queue: 'tesouro.sync', titles: idByCode.size, closes: inserted, rebuildFrom: earliest },
    'tesouro.sync cycle complete',
  );
}
