import type { UserId, WalletId } from '@/core/shared/ids';
import { withWalletDeps } from '@/app/(app)/wallets/composition';

/**
 * The wallets a pending item can be assigned to, for the post-import summary's
 * resolve control (SPEC-010 BR-010-13).
 *
 * AR-31: the page is a Server Component, so the read lives in a plain `.ts`
 * module. It is here rather than in `wallets/data.ts` because that module's
 * loader answers the wallets *screen's* question — comparison rows, unassigned
 * holdings, pending items — and the summary needs only names.
 */
export interface WalletOption {
  readonly id: WalletId;
  readonly name: string;
}

export async function loadWalletOptions(userId: UserId): Promise<readonly WalletOption[]> {
  return withWalletDeps(userId, async (deps) => {
    const wallets = await deps.wallets.list();
    return wallets.map((wallet) => ({ id: wallet.id, name: wallet.name }));
  });
}

/**
 * A wallet id with no matching name means the wallet was deleted between the
 * allocation being written and this render. Falling back to the id keeps the
 * row truthful — it still holds that quantity — rather than dropping it and
 * making the quantities stop adding up.
 */
export function walletName(options: readonly WalletOption[], walletId: WalletId): string {
  return options.find((option) => option.id === walletId)?.name ?? walletId;
}
