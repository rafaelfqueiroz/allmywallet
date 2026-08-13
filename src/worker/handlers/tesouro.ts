import { logger } from '@/lib/logger';
import type {
  AssetCatalogPort,
  QuoteRepositoryPort,
  TesouroPriceProvider,
} from '@/core/quotes/ports';
import { buildQuotesComposition, buildTesouroProvider } from './composition';

export interface TesouroSyncDeps {
  readonly catalog: AssetCatalogPort;
  readonly repository: QuoteRepositoryPort;
  readonly provider: TesouroPriceProvider;
}

/**
 * SPEC-008 `tesouro.sync` — BR-008-12: Tesouro Direto prices are fetched
 * once daily, as often as Tesouro Transparente publishes. Titles are
 * onboarded into the `assets` catalog on first sight (AssetCatalogPort
 * .upsertByCode) and priced into `price_quotes`, the same authoritative
 * table `quotes.close-capture` writes to for equities — a Tesouro title has
 * no intraday quote to speak of, so it never touches `latest_quotes`.
 *
 * AR-19: `upsertClosePrice` is keyed `(asset_id, date)`, so a retried sync
 * for a date already written is a no-op overwrite with the same values, not
 * a duplicate.
 */
export async function handleTesouroSync(overrides?: Partial<TesouroSyncDeps>): Promise<void> {
  const composition = buildQuotesComposition();
  const catalog = overrides?.catalog ?? composition.catalog;
  const repository = overrides?.repository ?? composition.repository;
  const provider = overrides?.provider ?? buildTesouroProvider();

  const fetched = await provider.fetchDailyPrices();
  if (!fetched.ok) {
    logger.error({ queue: 'tesouro.sync', err: fetched.error }, 'tesouro.sync fetch failed');
    return;
  }

  let written = 0;
  for (const point of fetched.value) {
    const asset = await catalog.upsertByCode({
      code: point.ticker,
      name: point.ticker,
      assetClass: 'tesouro_direto',
    });
    await repository.upsertClosePrice({
      assetId: asset.id,
      date: point.date,
      close: point.price,
      source: point.source,
    });
    written += 1;
  }

  logger.info({ queue: 'tesouro.sync', titles: written }, 'tesouro.sync cycle complete');
}
