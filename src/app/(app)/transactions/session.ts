import type { UserId } from '@/core/shared/ids';
import { requireUserId } from '@/lib/session';

/**
 * AR-12: `requireUserId()` (src/lib/session.ts) is the only sanctioned source
 * of tenant identity. This is the non-throwing variant for read paths, where
 * "not signed in" is a normal render state (show a sign-in prompt) rather
 * than a fault — mirrors `(app)/reports/session.ts` and `(app)/wallets/session.ts`.
 */
export async function tryUserId(): Promise<UserId | undefined> {
  try {
    return await requireUserId();
  } catch {
    return undefined;
  }
}
