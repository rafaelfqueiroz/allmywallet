import { expect, test } from '@playwright/test';
import { LEGACY_REDIRECTS } from '@/lib/legacy-redirects';
import { expectPermanentRedirect } from './support/redirects';

/**
 * SPEC-022 BR-022-08 — every pre-M10 URL keeps working. One journey per row of
 * `src/lib/legacy-redirects.ts`, generated from the table, so a destination
 * issue that moves a screen adds its row and gets this check with no further
 * test code.
 *
 * Signed out on purpose: the redirect is the router's, before any page or
 * session read, and an e-mail recipient's browser may well have no session.
 *
 * The control journey proves the helper can fail: a route that has *not*
 * moved must not answer with a redirect.
 */
for (const row of LEGACY_REDIRECTS) {
  test(`${row.example.from} redirects permanently to ${row.example.to} (#${row.issue})`, async ({
    request,
  }) => {
    await expectPermanentRedirect(request, row.example.from, row.example.to);
  });
}

test('a route that has not moved answers without a redirect', async ({ request }) => {
  const response = await request.get('/privacy-policy', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
});
