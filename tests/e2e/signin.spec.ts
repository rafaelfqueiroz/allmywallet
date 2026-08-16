import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * SPEC-001 — the only entry point into the product.
 *
 * BR-001-01 and BR-001-12 are checked here rather than in a unit test on
 * purpose: they are claims about what the *page a user actually loads*
 * contains, and the way they break is by something being added later — a
 * password field for "convenience", the no-recovery notice moved behind a
 * link. A rendered-page assertion is the only one that notices.
 */
test.describe('sign-in', () => {
  test('offers Google as the only way in — no credential input exists', async ({ page }) => {
    await page.goto('/signin');

    await expect(page.getByRole('button', { name: /google/i })).toBeVisible();

    // BR-001-01 / SPEC-003 BR-003-08: no password is ever collected. Asserting
    // the absence, because the risk is an addition, not a removal.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(/senha/i)).toHaveCount(0);
  });

  test('discloses the no-recovery consequence on the page itself', async ({ page }) => {
    await page.goto('/signin');

    // BR-001-12: stated before the user commits, not buried in terms.
    await expect(page.getByText(/perderá o acesso/i)).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/signin');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
