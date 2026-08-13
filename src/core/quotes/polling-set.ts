import type { AssetId } from '@/core/shared/ids';
import type { Asset, AssetCatalogPort, AssetClass, HeldAssetsPort } from './ports';

/**
 * SPEC-008 BR-008-11: fixed income (CDB/LCI/LCA) has no intraday behaviour,
 * and Tesouro Direto is priced once daily by `tesouro.sync` rather than
 * polled intraday — so only these four classes ever join the scheduled
 * polling set.
 *
 * This filter, not a table constraint, is what enforces that. The `assets`
 * catalog is shared with SPEC-006's ledger and therefore *does* hold CDB rows
 * (a user who bought one has a transaction pointing at it); an asset held in
 * a non-zero position is simply never eligible unless its class is below.
 */
const INTRADAY_ELIGIBLE_CLASSES: ReadonlySet<AssetClass> = new Set(['stock', 'fii', 'bdr', 'etf']);

export function isIntradayEligible(assetClass: AssetClass): boolean {
  return INTRADAY_ELIGIBLE_CLASSES.has(assetClass);
}

/**
 * SPEC-008 BR-008-08: the polling set is derived, not configured — exactly
 * the distinct assets in at least one non-zero position, filtered to the
 * classes that actually have intraday behaviour. Pure and total: given the
 * same held assets it always produces the same set, which is what makes
 * "buying a new asset adds it next cycle, selling to zero removes it"
 * (the spec's acceptance criteria) fall out for free rather than needing its
 * own bookkeeping.
 */
export function derivePollingSet(heldAssets: readonly Asset[]): readonly AssetId[] {
  const eligibleIds = heldAssets
    .filter((asset) => isIntradayEligible(asset.assetClass))
    .map((asset) => asset.id);
  return Array.from(new Set(eligibleIds));
}

/**
 * The use-case wrapper: resolves held asset ids to their catalog entries (so
 * the class filter above can run) and derives the polling set. AR-02: a real
 * seam — `HeldAssetsPort`'s concrete adapter depends on wherever positions
 * live (see the ports.ts doc comment and the dispatch report).
 */
export async function computePollingSet(ports: {
  readonly heldAssets: HeldAssetsPort;
  readonly catalog: AssetCatalogPort;
}): Promise<readonly AssetId[]> {
  const heldIds = await ports.heldAssets.listDistinctHeldAssetIds();
  if (heldIds.length === 0) return [];
  const assets = await ports.catalog.findByIds(heldIds);
  return derivePollingSet(assets);
}
