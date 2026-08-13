import { describe, expect, it, vi } from 'vitest';

/**
 * `src/auth.ts` statically imports `next-auth`, which — under this project's
 * exact Next.js 16 / next-auth v5-beta version pairing — pulls in a
 * `next/server` import that Vitest's plain Node module resolution cannot
 * follow (`next-auth/lib/env.js` imports `next/server` without an extension;
 * Node's strict ESM resolver wants `next/server.js`). That makes `@/auth.ts`
 * itself un-importable from a unit test — not a defect in this file, a
 * version-pairing quirk in the frameworks it wires together, exercised for
 * real instead by `pnpm build` (which this dispatch ran directly against
 * placeholder env — see the #4/#6 report) and by the E2E sign-in journey.
 *
 * `vi.mock` intercepts the module graph before `@/lib/session.ts`'s own
 * `import { auth } from '@/auth'` is resolved, so the real `@/auth.ts` (and
 * therefore next-auth/next/server) is never evaluated here — this is what
 * makes `requireUserId()`'s actual decision (session present → branded id;
 * absent → throw) testable in isolation from that constraint.
 */
const authMock = vi.fn();
vi.mock('@/auth', () => ({ auth: authMock }));

describe('requireUserId (SPEC-003 BR-003-04 / AR-12)', () => {
  it('returns the session user id, branded, when a session exists', async () => {
    const { requireUserId } = await import('./session');
    const { UserId } = await import('@/core/shared/ids');
    const id = UserId.generate();
    authMock.mockResolvedValueOnce({ user: { id } });

    await expect(requireUserId()).resolves.toBe(id);
  });

  it('throws UnauthenticatedError when there is no session', async () => {
    const { requireUserId, UnauthenticatedError } = await import('./session');
    authMock.mockResolvedValueOnce(null);

    await expect(requireUserId()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('throws UnauthenticatedError when the session carries no user id', async () => {
    const { requireUserId, UnauthenticatedError } = await import('./session');
    authMock.mockResolvedValueOnce({ user: {} });

    await expect(requireUserId()).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
