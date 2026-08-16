import { expect, test } from '@playwright/test';

/**
 * SPEC-001 (#42) — the session endpoint has to *answer*.
 *
 * Every other test in this suite asserts that a page renders, and every one of
 * them passed throughout the period Auth.js was rejecting the host: a session
 * read that throws is caught upstream and rendered as the signed-out state,
 * which is a perfectly good-looking page. The defect was invisible to
 * page-level assertions by construction, so the assertion has to sit one level
 * down, on the endpoint itself.
 *
 * These run against the standalone production build (NODE_ENV=production),
 * which is the only environment where the bug appears — Auth.js trusts the
 * host by default everywhere else, so a dev-server test would pass regardless
 * of whether the configuration exists.
 */
test.describe('session endpoint', () => {
  test('answers 200 with JSON rather than failing on an untrusted host', async ({ request }) => {
    const response = await request.get('/api/auth/session');

    // Untrusted host does not return an empty session — it returns an error
    // status, which is what makes this a real check and not a tautology.
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');

    // Nobody is signed in here, and that is the correct answer: `{}` or
    // `null`. The assertion is that Auth.js reached a *decision*, not which
    // decision it reached.
    const body: unknown = await response.json();
    expect(body === null || typeof body === 'object').toBe(true);
    expect((body as { user?: unknown } | null)?.user).toBeUndefined();
  });

  test('serves the providers list, proving the callback origin resolves', async ({ request }) => {
    // Auth.js builds each provider's `signinUrl` and `callbackUrl` from the
    // trusted origin, so this endpoint fails on exactly the misconfiguration
    // #42 describes — and unlike /session it also proves the origin the URLs
    // are built from is real.
    const response = await request.get('/api/auth/providers');

    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, { callbackUrl?: string }>;
    // SPEC-001 BR-001-01: Google is the only provider, ever.
    expect(Object.keys(body)).toEqual(['google']);
    expect(body.google?.callbackUrl).toMatch(/^https?:\/\/.+\/api\/auth\/callback\/google$/);
  });
});
