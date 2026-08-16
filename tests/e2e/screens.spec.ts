import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * SPEC-016 BR-016-15 / TS-27 — axe on the real pages, in a real browser.
 *
 * The `components` vitest project already asserts axe per primitive, but jsdom
 * has no layout and no paint: it cannot see contrast, and it cannot see a
 * violation that only exists once components are composed into a page. This is
 * the pass that can.
 *
 * Every route is checked signed-out, which is the state a fresh browser
 * reaches. That is not a limitation of the suite so much as the currently
 * reachable surface — SPEC-001's session wiring is still stubbed on several of
 * these routes (`TODO(#6)`), so there is no authenticated state to drive yet.
 */
const ROUTES = [
  '/',
  '/signin',
  '/wallets',
  '/import',
  '/reports',
  '/preferences',
  '/privacy',
  // SPEC-004 BR-004-15: the policy is public and unauthenticated, so it is
  // reachable in exactly the state this suite runs in.
  '/privacy-policy',
] as const;

for (const route of ROUTES) {
  test(`${route} has no accessibility violations`, async ({ page }) => {
    await page.goto(route);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

/**
 * SPEC-011 BR-011-16 — "an explanatory empty state, never a misleading zero".
 * A blank region and "R$ 0,00" are the two failure modes; both would pass a
 * smoke test that only checked the page loaded.
 */
test('an empty screen explains itself rather than rendering nothing', async ({ page }) => {
  await page.goto('/wallets');

  await expect(page.getByRole('status').first()).toBeVisible();
});

test('every page renders exactly one h1', async ({ page }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    // More than one is a document-outline bug; none leaves screen-reader users
    // with no way to identify the page.
    await expect(page.locator('h1'), `${route} should have one h1`).toHaveCount(1);
  }
});
