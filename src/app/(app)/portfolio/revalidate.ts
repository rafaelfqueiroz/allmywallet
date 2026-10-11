import { revalidatePath } from 'next/cache';

/**
 * SPEC-022 BR-022-02 — Portfólio's four tabs (and Carteiras' setup sub-tab) read one holding set, so a write
 * that changes it (an allocation, a wallet, a goal, a transaction) refreshes
 * every one of them rather than guessing which one the user returns to. The wallet
 * scope is a query parameter, not a path, so these paths cover every
 * scope.
 */
export const PORTFOLIO_PATHS = [
  '/portfolio',
  '/portfolio/composition',
  '/portfolio/wallets',
  '/portfolio/wallets/setup',
  '/portfolio/goals',
] as const;

export function revalidatePortfolio(): void {
  for (const path of PORTFOLIO_PATHS) revalidatePath(path);
}
