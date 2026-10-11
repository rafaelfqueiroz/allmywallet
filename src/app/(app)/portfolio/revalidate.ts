import { revalidatePath } from 'next/cache';
import { revalidateWalletSettings } from '@/app/(app)/settings/wallets/revalidate';

/**
 * SPEC-022 BR-022-02 — Portfólio's four tabs read one holding set, so a write
 * that changes it (an allocation, a wallet, a goal, a transaction) refreshes
 * every one of them rather than guessing which one the user returns to. The wallet
 * scope is a query parameter, not a path, so these paths cover every
 * scope.
 */
export const PORTFOLIO_PATHS = [
  '/portfolio',
  '/portfolio/composition',
  '/portfolio/wallets',
  '/portfolio/goals',
] as const;

export function revalidatePortfolio(): void {
  for (const path of PORTFOLIO_PATHS) revalidatePath(path);
  // Not Portfólio's, but readers of the same holding set: Configurações ›
  // Carteiras counts the assets of each wallet, lists what is held and not yet
  // assigned, and shows each wallet's allocations — so a transaction or import
  // that changes the holdings changes those too.
  revalidateWalletSettings();
}
