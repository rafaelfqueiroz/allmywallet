import { expect, test } from './support/authenticated';

/**
 * #37 — the public surface at `/`.
 *
 * Two journeys that no unit or component test can stand in for. The first is
 * the whole point of the page: an anonymous visitor arrives, learns what the
 * product is, and reaches sign-in. The second is a *routing* behaviour that
 * exists nowhere in the React tree — `src/middleware.ts` runs before the page
 * does, so the only way to check it is to drive a browser holding a session
 * cookie.
 */
test.describe('landing page', () => {
  test('greets an anonymous visitor and leads them into sign-in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The hero's call to action, not the header's — this is the path the page
    // is built around.
    await page.getByRole('main').getByRole('link', { name: 'Começar agora' }).click();

    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole('button', { name: /google/i })).toBeVisible();
  });

  // SPEC-004 BR-004-15: the policy informs the decision to create an account,
  // so it has to be readable *before* there is an account.
  test('reaches the privacy policy from the footer without an account', async ({ page }) => {
    await page.goto('/');

    await page
      .getByRole('contentinfo')
      .getByRole('link', { name: 'Política de privacidade' })
      .click();

    await expect(page).toHaveURL(/\/privacy-policy$/);
  });

  // SPEC-003 BR-003-08 / SPEC-004 BR-004-02 — the two claims the page makes on
  // the product's behalf. If either stops being true in the code, it has to
  // stop being said here, and this is what fails first.
  test('states the credential and CPF positions on the page itself', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText(/senha de banco/i).first()).toBeVisible();
    await expect(page.getByText(/CPF/).first()).toBeVisible();
  });

  test('sends a signed-in visitor to the application instead of the pitch', async ({
    signedIn,
  }) => {
    await signedIn.page.goto('/');

    // The redirect is `src/middleware.ts`, before the prerendered page is even
    // looked up — which is what lets `/` stay static for everyone else.
    await expect(signedIn.page).toHaveURL(/\/transactions$/);
  });

  // The matcher covers `/` and nothing else, deliberately: an unverified
  // cookie check in front of a route that does its own verified one is how a
  // routing convenience becomes an accidental security control.
  test('leaves every other route alone for a signed-in visitor', async ({ signedIn }) => {
    await signedIn.page.goto('/privacy-policy');

    await expect(signedIn.page).toHaveURL(/\/privacy-policy$/);
  });
});
