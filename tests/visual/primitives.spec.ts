import { expect, test } from '@playwright/test';

/**
 * DL-16 / DL-C2 — the pass that jsdom cannot do.
 *
 * The `components` vitest project proves structure, aria and keyboard
 * behaviour, and explicitly disables axe's `color-contrast` rule because jsdom
 * has no paint. This is where colour, contrast, spacing and both themes are
 * actually checked, by comparing pixels.
 *
 * **Baselines must be generated in the pinned container** (`pnpm
 * test:visual:docker`). macOS and Linux rasterise fonts differently, so a
 * baseline captured on a developer's Mac fails in CI forever — and the failure
 * looks like a real regression, which is worse than no test.
 *
 * One screenshot per project rather than one per component: the route renders
 * every primitive in every variant in a single document, so four images cover
 * the system and any drift shows as a diff instead of as silence.
 */
test('the primitives route is unchanged', async ({ page }) => {
  await page.goto('/primitives');

  // The route is 404 in production builds by design; a visual run against a
  // production server would otherwise "pass" by photographing the 404 page.
  await expect(page.locator('h1')).toBeVisible();

  // The skeletons pulse. Without this the diff is a coin toss on every run.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await expect(page).toHaveScreenshot('primitives.png', {
    fullPage: true,
    // Sub-pixel text rendering differs even between runs on the same machine.
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
  });
});
