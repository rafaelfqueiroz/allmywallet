import type { UserId } from '@/core/shared/ids';

/**
 * TODO(#6): resolve the real session via Auth.js once SPEC-001/SPEC-003 land
 * on their own branch. Both helpers below are the single place that gap
 * lives for this route, so replacing them is a one-file change once
 * `withTenant` and a session helper exist.
 *
 * `requireSessionUserId` throws rather than returning a placeholder id —
 * AR-12 requires `userId` to come from the verified session, never a request
 * parameter, and a stub id here would be exactly that workaround wearing a
 * disguise: it would let a write silently land against a made-up account
 * instead of failing loudly where the real gap is.
 */
export function requireSessionUserId(): UserId {
  throw new Error(
    'TODO(#6): no session resolution wired yet — SPEC-001/SPEC-003 auth lands on a separate branch.',
  );
}

/** Non-throwing variant for read paths, where "not signed in" is a normal render state, not a fault. */
export function trySessionUserId(): UserId | undefined {
  try {
    return requireSessionUserId();
  } catch {
    return undefined;
  }
}
