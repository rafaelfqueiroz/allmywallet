import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

/**
 * #37 — the redirect that keeps `/` prerendered.
 *
 * The E2E suite drives this in a real browser, which is where it matters. This
 * exists for the two properties a browser test states awkwardly: that *both*
 * cookie names are recognised (the `__Secure-` one only ever appears over
 * https, so a local suite can never exercise it and production is the first
 * place a mistake would show), and that the check is presence-only — a
 * middleware that started verifying sessions would need a database on the edge
 * and would quietly become an authorisation control.
 */
function request(cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest('http://localhost:3000/', { headers });
}

describe('middleware', () => {
  it('lets an anonymous visitor through to the prerendered landing page', () => {
    const response = middleware(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a signed-in visitor to the ledger', () => {
    const response = middleware(request('authjs.session-token=any-token'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/transactions');
  });

  it('recognises the secure cookie name production actually sets', () => {
    const response = middleware(request('__Secure-authjs.session-token=any-token'));

    expect(response.headers.get('location')).toBe('http://localhost:3000/transactions');
  });

  it('ignores unrelated cookies', () => {
    const response = middleware(request('theme=dark; other=1'));

    expect(response.headers.get('location')).toBeNull();
  });
});
