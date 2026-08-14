import { inArray } from 'drizzle-orm';
import { AssetId, type UserId, type WalletId } from '@/core/shared/ids';
import { computeUnassigned, type UnassignedHolding } from '@/core/wallets/allocate';
import { compareWallets, type WalletComparisonRow } from '@/core/wallets/compare-wallets';
import { listPendingAllocations, type PendingAllocation } from '@/core/wallets/pending';
import type { WalletAllocation } from '@/core/wallets/ports';
import type { Wallet } from '@/core/wallets/wallet';
import { withWalletDeps } from '@/app/(app)/wallets/composition';
import { db } from '@/db/client';
import { assets } from '@/db/schema/assets';

/**
 * AR-31: Server Components call a use case in `core/` directly, never the
 * database — enforced for `.tsx` files by ESLint (AR-35's block in
 * eslint.config.mjs), which is why the `@/db/*` import for asset labels
 * lives in this plain `.ts` module rather than in `page.tsx` itself.
 */

export interface AssetLabel {
  readonly code: string;
  readonly name: string;
}

const UNKNOWN_LABEL: AssetLabel = { code: '—', name: '—' };

/** `assets` is a shared reference table (AR-15) — no tenant scope needed to read it. */
export async function resolveAssetLabels(
  assetIds: readonly AssetId[],
): Promise<ReadonlyMap<AssetId, AssetLabel>> {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: assets.id, code: assets.code, name: assets.name })
    .from(assets)
    .where(inArray(assets.id, unique));
  return new Map(rows.map((row) => [AssetId.of(row.id), { code: row.code, name: row.name }]));
}

export function labelFor(labels: ReadonlyMap<AssetId, AssetLabel>, assetId: AssetId): AssetLabel {
  return labels.get(assetId) ?? UNKNOWN_LABEL;
}

export interface WalletsPageData {
  readonly comparison: readonly WalletComparisonRow[];
  readonly unassigned: readonly UnassignedHolding[];
  readonly pending: readonly PendingAllocation[];
  readonly labels: ReadonlyMap<AssetId, AssetLabel>;
}

export async function loadWalletsPageData(userId: UserId): Promise<WalletsPageData> {
  const { comparison, unassigned, pending } = await withWalletDeps(userId, async (deps) => {
    const [comparisonRows, unassignedRows, pendingRows] = await Promise.all([
      compareWallets(deps, userId),
      computeUnassigned(deps, userId),
      listPendingAllocations(deps, userId),
    ]);
    return { comparison: comparisonRows, unassigned: unassignedRows, pending: pendingRows };
  });

  const labels = await resolveAssetLabels([
    ...unassigned.map((holding) => holding.assetId),
    ...pending.map((item) => item.assetId),
  ]);

  return { comparison, unassigned, pending, labels };
}

export interface WalletDetailData {
  readonly wallet: Wallet;
  readonly allocations: readonly WalletAllocation[];
  readonly labels: ReadonlyMap<AssetId, AssetLabel>;
}

export async function loadWalletDetail(
  userId: UserId,
  walletId: WalletId,
): Promise<WalletDetailData | null> {
  const result = await withWalletDeps(userId, async (deps) => {
    const wallet = await deps.wallets.findById(walletId);
    if (wallet === null) return null;
    const allocations = await deps.allocations.listForWallet(walletId);
    return { wallet, allocations };
  });
  if (result === null) return null;

  const labels = await resolveAssetLabels(
    result.allocations.map((allocation) => allocation.assetId),
  );
  return { ...result, labels };
}

/** BR-010-09: assignment is also offered from a list of every wallet, for the "Needs attention" resolve form. */
export async function loadWalletChoices(userId: UserId): Promise<readonly Wallet[]> {
  return withWalletDeps(userId, (deps) => deps.wallets.list());
}
