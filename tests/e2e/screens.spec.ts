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
  // #98 — the authenticated landing. Checked here in its signed-out state like
  // every other route; the populated page's own axe pass is
  // `dashboard.spec.ts`, which can sign in.
  '/dashboard',
  // #97 (SPEC-020) — the guided first run. Same reasoning as `/dashboard`
  // immediately above: the signed-in guide's own axe pass is
  // `onboarding.spec.ts`.
  '/onboarding',
  '/wallets',
  // SPEC-006 #9 — added when the ledger got a surface. Both render their
  // signed-out state here, which is the state this suite runs in.
  '/transactions',
  '/transactions/new',
  '/import',
  '/reports',
  '/reports/patrimonio',
  '/reports/performance',
  // SPEC-014 #17 — the fourth report.
  '/reports/earnings',
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
 * SPEC-022 BR-022-29 — both themes are first-class and both meet WCAG AA.
 * `/primitives` renders every primitive in every variant, including the status
 * badges (BR-022-31), so it is the one page where axe's `color-contrast` rule
 * sees every token pair. Run once per theme: the dark blocks are held identical
 * by `tests/structural/design-tokens.test.ts`, so the system preference stands
 * for the explicit `.dark` choice too.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`/primitives meets colour contrast in the ${colorScheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/primitives');
    await expect(page.locator('h1')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

/**
 * BR-022-29 again, for the state a static scan never sees: a control under the
 * pointer. The review of #218 found a select's placeholder at 4.28:1 once its
 * dark hover fill had settled, while the same control passed at rest. Reduced
 * motion makes the transition instant, so axe measures the settled colour.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`/primitives controls keep their contrast under hover in the ${colorScheme} theme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/primitives');

    const subjects = page.locator('[data-hover-subject]');
    await expect(subjects).toHaveCount(4);

    for (const subject of await subjects.all()) {
      await subject.hover();
      const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      expect(results.violations, await subject.evaluate((el) => el.outerHTML)).toEqual([]);
    }
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
