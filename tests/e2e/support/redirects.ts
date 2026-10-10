import { expect, type APIRequestContext } from '@playwright/test';

/**
 * SPEC-022 BR-022-08 — asserts that `from` answers with a **permanent**
 * redirect straight to `to`: one hop, status 308, nothing rendered first.
 *
 * `maxRedirects: 0` is the point, on both requests. Following the redirect and checking where the
 * browser ended up would also pass for a temporary redirect, a chain, or a
 * page that rendered and then client-side navigated — none of which keeps an
 * old e-mail link working the way BR-022-08 requires.
 *
 * Destination issues call this through `tests/e2e/redirects.spec.ts`, which
 * runs it over every row's `example` in `src/lib/legacy-redirects.ts`; a
 * journey that moves a screen can also call it directly for an old URL with a
 * query string worth pinning.
 */
export async function expectPermanentRedirect(
  request: APIRequestContext,
  from: string,
  to: string,
): Promise<void> {
  const response = await request.get(from, { maxRedirects: 0 });

  expect(response.status(), `${from} should redirect permanently`).toBe(308);
  const location = new URL(response.headers().location ?? '', 'http://placeholder.test');
  expect(`${location.pathname}${location.search}`, `${from} should land on ${to}`).toBe(to);

  // "Lands on the right screen": the destination must itself answer, without
  // a further redirect. A typo in a row and its example would agree with each
  // other and still send every old e-mail link to a 404.
  const landing = await request.get(to, { maxRedirects: 0 });
  expect(landing.status(), `${to} should render, not redirect again or fail`).toBe(200);
}
