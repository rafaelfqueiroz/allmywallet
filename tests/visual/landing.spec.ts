import { expect, test } from '@playwright/test';

/**
 * #37 — the public surface, in pixels.
 *
 * `/primitives` proves every component in isolation; this proves the one page
 * assembled from them, in both themes and at both viewport sizes. The landing
 * page is also the only screen in the product a visitor sees *before* deciding
 * to trust it, so a broken layout here costs more than the same break on an
 * internal screen would.
 *
 * Baselines are recorded in the pinned Playwright container (DS-42,
 * `pnpm test:visual:docker`). A copy captured natively on macOS rasterises
 * text differently and fails in CI forever.
 */
test('the landing page is unchanged', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await page.goto('/');

  // Anonymous is the state this page exists for; `src/middleware.ts` would
  // redirect a session-carrying context away before a screenshot happened.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await expect(page).toHaveScreenshot('landing.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
  });
});
