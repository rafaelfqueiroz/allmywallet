import { revalidatePath } from 'next/cache';

/**
 * SPEC-022 BR-022-05 — Configurações › Carteiras' screens read the wallets and
 * their allocations, so a write that changes either refreshes all of them: the
 * list's asset counts, the assignment queue, and the wallet's own page.
 *
 * Callers that change the holding set also call `revalidatePortfolio()`; this
 * is the setup side of the same write. `walletId` is optional because a
 * write that names an asset rather than a wallet (clearing a rule) can change
 * any wallet's page, so every one is refreshed.
 */
export const WALLET_SETTINGS_PATHS = [
  '/settings/wallets',
  '/settings/wallets/new',
  '/settings/wallets/assign',
] as const;

export function walletSettingsPath(walletId: string): string {
  return `/settings/wallets/${walletId}`;
}

export function revalidateWalletSettings(walletId?: string): void {
  for (const path of WALLET_SETTINGS_PATHS) revalidatePath(path);
  if (walletId === undefined) revalidatePath('/settings/wallets/[walletId]', 'page');
  else revalidatePath(walletSettingsPath(walletId));
}
