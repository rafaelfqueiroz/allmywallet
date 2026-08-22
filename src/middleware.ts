import { NextResponse, type NextRequest } from 'next/server';

/**
 * #37 — a signed-in visitor who lands on `/` goes to the application instead
 * of reading the pitch for a product they already use.
 *
 * **Why here and not in the page.** Redirecting from `page.tsx` means calling
 * `tryUserId()`, and reading the session opts `/` into dynamic rendering — the
 * one page in the product that must stay prerendered and indexable (DS-40).
 * Middleware runs before the cache lookup, so the marketing page keeps its
 * static output and the redirect still happens on the first byte.
 *
 * **What this check is, precisely.** It tests for the *presence* of Auth.js's
 * session cookie, not for a valid session — middleware runs on the edge
 * runtime, which has no database connection, and `sessions` is the only place
 * a database-strategy session can be verified (SPEC-001 BR-001-06/07). So a
 * stale or forged cookie buys a redirect to `/transactions` and nothing else:
 * that route resolves the session properly and renders its signed-out state.
 * This is a routing convenience and is *never* an authorisation decision —
 * every protected surface still calls `requireUserId()` for itself (AR-12).
 */
const SESSION_COOKIES = [
  'authjs.session-token',
  // Auth.js adds the `__Secure-` prefix whenever the cookie is set over https,
  // which is every deployed environment and none of the local ones. Both names
  // have to be checked or the redirect works in development and silently stops
  // working in production.
  '__Secure-authjs.session-token',
] as const;

export function middleware(request: NextRequest): NextResponse {
  const signedIn = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!signedIn) return NextResponse.next();

  const destination = new URL('/transactions', request.url);

  return NextResponse.redirect(destination);
}

export const config = {
  /*
   * `/` only. Widening this matcher would put an unverified cookie check in
   * front of routes that do their own verified one, which is how a routing
   * convenience turns into a security control by accident.
   */
  matcher: '/',
};
