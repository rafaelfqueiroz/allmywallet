import type { AssetId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { ImportRow } from '@/core/ingestion/ports';
import type { PendingAllocation } from '@/core/wallets/pending';
import type { WalletAllocation } from '@/core/wallets/ports';

/**
 * SPEC-010 BR-010-15 — "auto-allocation is reported, never silent: the
 * post-import summary lists every allocation made and every purchase left
 * pending, each reversible or resolvable there."
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUMMARISES, PRECISELY
 *
 * It answers **"the purchases this import brought in — where did they end
 * up?"**, not "what did the commit job do at the instant it ran". The
 * difference matters and the first is the better answer:
 *
 *  - It stays true after the user resolves a pending item. A frozen record of
 *    the commit would keep saying "waiting for a decision" about something
 *    already decided, and a summary that goes stale is one users stop reading.
 *  - It needs no new table and no new column. `wallet_allocations` and the
 *    position cache already hold the current truth; recording a parallel copy
 *    at commit time would create a second thing that can disagree with them,
 *    which is exactly the failure mode SPEC-006 avoids by making transactions
 *    the single source.
 *
 * The cost is that it cannot distinguish "this import auto-allocated it" from
 * "it was already there and the import added to it". That distinction is not
 * what BR-010-15 is for — the rule exists so nothing moves silently, and the
 * per-asset destination is what tells a user that.
 * ---------------------------------------------------------------------------
 */

export interface AssetDestination {
  readonly walletId: WalletAllocation['walletId'];
  readonly quantity: Quantity;
}

export interface PostImportAsset {
  readonly assetId: AssetId;
  /** How much of this asset the import brought in — summed across its rows. */
  readonly importedQuantity: Quantity;
  /** Where the position currently sits. Empty means entirely unassigned. */
  readonly destinations: readonly AssetDestination[];
  /**
   * BR-010-12: what is still waiting for a decision, and why. `null` once
   * nothing is unassigned — which is what makes a resolved item disappear
   * from the "needs attention" half of the summary without the page having to
   * re-derive the rule.
   */
  readonly pending: PendingAllocation | null;
}

export interface PostImportSummary {
  readonly assets: readonly PostImportAsset[];
  /** True when nothing in this import needs a decision — the common case. */
  readonly settled: boolean;
}

/**
 * BR-006-03 again: only rows that became an active ledger transaction moved a
 * position, so only they can have moved an allocation. A duplicate changed
 * nothing and an invalid row was never applied.
 */
const COUNTED_CLASSIFICATIONS = new Set(['new']);

/** Only purchases can create an allocation decision (BR-010-10/11/16). */
const ACQUIRING_TYPES = new Set(['buy', 'transfer_in', 'subscription']);

export function buildPostImportSummary(input: {
  readonly rows: readonly ImportRow[];
  readonly allocations: readonly WalletAllocation[];
  readonly pending: readonly PendingAllocation[];
}): PostImportSummary {
  const imported = new Map<AssetId, Quantity>();

  for (const row of input.rows) {
    if (!COUNTED_CLASSIFICATIONS.has(row.classification)) continue;
    if (row.ledgerType === null || !ACQUIRING_TYPES.has(row.ledgerType)) continue;
    if (row.record.kind !== 'transaction') continue;
    imported.set(
      row.assetId,
      (imported.get(row.assetId) ?? Quantity.zero()).plus(row.record.quantity),
    );
  }

  const byAsset = new Map<AssetId, AssetDestination[]>();
  for (const allocation of input.allocations) {
    const list = byAsset.get(allocation.assetId) ?? [];
    list.push({ walletId: allocation.walletId, quantity: allocation.quantity });
    byAsset.set(allocation.assetId, list);
  }

  const pendingByAsset = new Map(input.pending.map((item) => [item.assetId, item]));

  const assets = [...imported.entries()]
    // Stable order so two renders of the same batch agree, and so a snapshot
    // test is not hostage to Map insertion order.
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([assetId, importedQuantity]) => ({
      assetId,
      importedQuantity,
      destinations: byAsset.get(assetId) ?? [],
      pending: pendingByAsset.get(assetId) ?? null,
    }));

  return { assets, settled: assets.every((asset) => asset.pending === null) };
}
