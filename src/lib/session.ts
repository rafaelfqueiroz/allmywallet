import { auth } from '@/auth';
import { UserId } from '@/core/shared/ids';

// Re-exported so call sites that need both `requireUserId()` and tamper
// detection have a single import; the implementation lives in
// security-events.ts for its own testability reasons (see the comment
// there).
export { assertNoTenantOverride } from '@/lib/security-events';

/**
 * SPEC-003 BR-003-04 / AR-12: tenant identity comes from the verified session
 * only. `requireUserId()` is the *only* sanctioned way any route, server
 * action or Server Component obtains it — nothing reads a `user_id` out of a
 * request body, query string or header and treats it as identity. The
 * ESLint rule in `eslint.config.mjs` (search "BR-001-08") gives that a
 * mechanical backstop outside this file.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super('No authenticated session');
    this.name = 'UnauthenticatedError';
  }
}

export async function requireUserId(): Promise<UserId> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new UnauthenticatedError();
  return UserId.of(id);
}

/**
 * Non-throwing variant for read paths where "not signed in" is a normal
 * render state, not a fault — a Server Component that shows a
 * "sign in to continue" message instead of a thrown error. Mirrors the
 * `trySessionUserId()` shape `src/app/(settings)/preferences/session.ts`
 * established while auth had not landed yet on that branch; this is the
 * real implementation, now that it has.
 */
export async function tryUserId(): Promise<UserId | undefined> {
  try {
    return await requireUserId();
  } catch (error) {
    // #42: only "there is no session" becomes `undefined`. Anything else —
    // an Auth.js misconfiguration, an unreachable database — propagates.
    //
    // A bare `catch {}` here is what let a whole deployment authenticate
    // nobody while looking healthy: Auth.js threw `UntrustedHost` on every
    // session read, this swallowed it, and every screen rendered its
    // signed-out state. The two states are not the same and must not share a
    // code path. A configuration fault should surface as an error page and a
    // failed health check, which is loud, immediate and fixable; "everyone is
    // signed out" is none of those.
    if (error instanceof UnauthenticatedError) return undefined;
    throw error;
  }
}
