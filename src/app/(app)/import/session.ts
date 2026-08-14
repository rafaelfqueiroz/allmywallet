import type { UserId } from '@/core/shared/ids';
import { requireUserId } from '@/lib/session';

/**
 * AR-12: `requireUserId()` is the only sanctioned source of tenant identity.
 * Non-throwing variant for read paths, matching `(app)/wallets/session.ts`.
 */
export async function tryUserId(): Promise<UserId | undefined> {
  try {
    return await requireUserId();
  } catch {
    return undefined;
  }
}
