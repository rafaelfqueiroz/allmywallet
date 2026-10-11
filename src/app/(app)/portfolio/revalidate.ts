import { revalidatePath } from 'next/cache';

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

/**
 * Not Portfólio's, but a reader of the same holding set: Configurações ›
 * Carteiras › Atribuir ativos lists what is held and not yet assigned, so a
 * transaction or import that changes the holdings changes that queue too.
 */
const HOLDING_SETUP_PATHS = ['/settings/wallets/assign'] as const;

export function revalidatePortfolio(): void {
  for (const path of [...PORTFOLIO_PATHS, ...HOLDING_SETUP_PATHS]) revalidatePath(path);
}
