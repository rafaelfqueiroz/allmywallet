import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/authenticated';
import { seedCommittedImportBatch, seedPreviewedImportBatch } from './support/onboarding';
import { seedHeldFixedIncomeWithMissingRate } from './support/fixed-income';

/**
 * SPEC-020 — the guided first run, over the real stack.
 *
 * TS-25: user-visible outcomes only. `core/onboarding`'s own branches are unit
 * (`status.test.ts`, `gates.test.ts`, `dismiss.test.ts`) and integration
 * (`tests/integration/onboarding.test.ts`) tests; this file asserts what a
 * signed-in browser actually sees.
 *
 * Both e2e-desktop and e2e-mobile run every test here (`playwright.config.ts`
 * matches `tests/e2e/**\/*.spec.ts` in both projects), so any assertion that
 * reaches into the application shell accounts for the mobile drawer the same
 * way `navigation.spec.ts` does.
 */

const isMobile = (viewportWidth: number) => viewportWidth < 768;

test.describe('the guided onboarding flow', () => {
  /** AC-1 / BR-020-02 — "first sign-in lands on onboarding, not on an empty dashboard." */
  test('a fresh signed-in user visiting the root lands on the guide', async ({ signedIn }) => {
    await signedIn.page.goto('/');

    await expect(signedIn.page).toHaveURL(/\/onboarding$/);
    await expect(
      signedIn.page.getByRole('heading', { level: 1, name: 'Primeiros passos' }),
    ).toBeVisible();
  });

  /**
   * BR-020-03 — "onboarding is complete at the first successfully committed
   * import. Nothing else gates completion." A returning user with one never
   * meets the guide again.
   */
  test('a returning user with a committed import lands on the dashboard, not the guide', async ({
    signedIn,
  }) => {
    await seedCommittedImportBatch(signedIn.userId);
    await signedIn.page.goto('/');

    await expect(signedIn.page).toHaveURL(/\/dashboard$/);
  });

  /**
   * BR-020-11/12 / AC-8/AC-17 — dismissal hides the guide without marking any
   * step complete, and persists (BR-020-09: `users.onboarding_dismissed_at`,
   * not browser state) across a reload. The dashboard it lands on is still
   * the first-run empty state, never a fabricated figure (BR-020-27).
   */
  test('dismissing the guide shows the dashboard empty state, and it survives a reload', async ({
    signedIn,
  }) => {
    await signedIn.page.goto('/onboarding');
    await signedIn.page.getByRole('button', { name: 'Dispensar o guia' }).click();

    await expect(signedIn.page).toHaveURL(/\/dashboard$/);
    await expect(signedIn.page.getByRole('status').first()).toBeVisible();
    await expect(signedIn.page.locator('[data-slot="money"]')).toHaveCount(0);

    await signedIn.page.reload();
    await expect(signedIn.page).toHaveURL(/\/dashboard$/);
    await expect(signedIn.page.getByRole('status').first()).toBeVisible();
  });

  /**
   * BR-020-13 / AC-7 — "the guide can be reopened at any time from a help
   * entry point, which clears `onboarding_dismissed_at`." A POST, not a
   * `Link` (BR-020-12's "never a GET"), asserted here by its actual effect —
   * routing back to `/onboarding` — rather than by inspecting the markup.
   */
  test('the help entry point reopens the guide after it was dismissed', async ({
    signedIn,
    viewport,
  }) => {
    await signedIn.page.goto('/onboarding');
    await signedIn.page.getByRole('button', { name: 'Dispensar o guia' }).click();
    await expect(signedIn.page).toHaveURL(/\/dashboard$/);

    if (viewport && isMobile(viewport.width)) {
      await signedIn.page.getByRole('button', { name: 'Abrir menu' }).click();
    }
    await signedIn.page.getByRole('button', { name: 'Guia de primeiros passos' }).click();

    await expect(signedIn.page).toHaveURL(/\/onboarding$/);
  });

  /**
   * BR-020-20/21/24 / AC-13/AC-16 — the guide names all three extracts,
   * advises the earliest available date, and states when it was last
   * verified against B3.
   */
  test('names all three extracts, the earliest-date advice, and the verification stamp', async ({
    signedIn,
  }) => {
    await signedIn.page.goto('/onboarding');

    for (const label of ['Movimentação', 'Negociação', 'Posição']) {
      await expect(signedIn.page.getByText(label, { exact: false }).first()).toBeVisible();
    }
    await expect(signedIn.page.getByText(/data inicial mais antiga/)).toBeVisible();
    // BR-016-18 — `dd/mm/yyyy`, never the ISO string the date is stored as.
    await expect(signedIn.page.getByText(/Verificado na B3 em \d{2}\/\d{2}\/\d{4}/)).toBeVisible();
  });

  /**
   * BR-020-22 / AC-14 — "together or one at a time, in any order". A user who
   * sent Movimentação alone is still guided, can still send the other two from
   * here, and is pointed at the preview waiting for them.
   */
  test('with one extract staged, the guide still offers the upload and links to its preview', async ({
    signedIn,
  }) => {
    const batchId = await seedPreviewedImportBatch(signedIn.userId);

    await signedIn.page.goto('/');
    await expect(signedIn.page).toHaveURL(/\/onboarding$/);

    await expect(signedIn.page.getByText(/pronto para revisão no passo 3/)).toBeVisible();
    await expect(signedIn.page.getByLabel(/arquivo/i)).toBeVisible();
    await expect(
      signedIn.page.getByRole('link', { name: 'Revisar e confirmar importação' }),
    ).toHaveAttribute('href', `/import/${batchId}`);

    // BR-020-11 — dismissible at any step, not only the first.
    await signedIn.page.getByRole('button', { name: 'Dispensar o guia' }).click();
    await expect(signedIn.page).toHaveURL(/\/dashboard$/);
  });

  /**
   * BR-020-26 — "the guide states that only the three B3 extracts are
   * accepted, and that assets outside B3 custody need manual entry."
   */
  test('states that assets outside B3 custody need manual entry', async ({ signedIn }) => {
    await signedIn.page.goto('/onboarding');
    await expect(signedIn.page.getByText(/entrada manual|registre-o manualmente/i)).toBeVisible();
  });

  /**
   * BR-020-31 / AC-20 — "diagram text alternatives convey the export steps,
   * verified by reading them with the images suppressed." Every `<svg>` is
   * hidden via injected CSS, which is what a screen reader or an
   * images-disabled render effectively does; the ordered text steps are the
   * thing that has to survive that.
   */
  test('the export steps survive with every diagram image hidden', async ({ signedIn }) => {
    await signedIn.page.goto('/onboarding');
    await signedIn.page.addStyleTag({ content: 'svg { display: none !important; }' });

    // `role="img"` is `ExtractDiagram`'s own marker (the nav's lucide icons
    // carry no such role), so this is specifically the three export diagrams,
    // confirmed hidden rather than merely "a style tag was added".
    const diagrams = signedIn.page.locator('svg[role="img"]');
    await expect(diagrams).toHaveCount(3);
    for (const diagram of await diagrams.all()) {
      await expect(diagram).toBeHidden();
    }

    for (const path of [
      'Extratos → Movimentação → Baixar',
      'Extratos → Negociação → Baixar',
      'Minha carteira → Investimentos → Posição → Baixar',
    ]) {
      await expect(signedIn.page.getByText(path)).toBeVisible();
    }
  });

  /**
   * BR-020-31 / AC-19 — keyboard-only operability, by **Tab traversal**, not
   * `.focus()`: a control with `tabindex=-1` or trapped behind a
   * non-focusable wrapper accepts programmatic focus and is still unreachable
   * for a keyboard user. The walk starts at the skip link and records every
   * control Tab lands on, in whatever order the page puts them, until the
   * upload field, the upload submit, the link to the B3 portal and dismiss
   * have all been reached; it then tabs on to dismiss, which `Enter`
   * activates. The staged-batch test above covers the review link; review and
   * commit themselves happen on `/import/[batchId]`, whose keyboard behaviour
   * is SPEC-005's.
   */
  test('the guide is traversable and dismissible by keyboard alone', async ({ signedIn }) => {
    const { page } = signedIn;
    await page.goto('/onboarding');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();

    const upload = page.getByLabel(/arquivo/i);
    const submit = page.getByRole('button', { name: /^enviar$/i });
    const portal = page.getByRole('link', { name: /investidor/i }).first();
    const dismiss = page.getByRole('button', { name: 'Dispensar o guia' });
    const isFocused = (locator: typeof upload) =>
      locator.evaluate((node) => node === document.activeElement);

    const reached = { upload: false, submit: false, portal: false, dismiss: false };
    const allReached = () => Object.values(reached).every(Boolean);
    for (let press = 0; press < 200 && !allReached(); press += 1) {
      await page.keyboard.press('Tab');
      if (await isFocused(upload)) reached.upload = true;
      if (await isFocused(submit)) reached.submit = true;
      if (await isFocused(portal)) reached.portal = true;
      if (await isFocused(dismiss)) reached.dismiss = true;
    }
    expect(reached).toEqual({ upload: true, submit: true, portal: true, dismiss: true });

    // Tab on (wrapping if dismiss came earlier in the order) until it has focus.
    for (let press = 0; press < 200 && !(await isFocused(dismiss)); press += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  /** AC-19 — axe at WCAG 2.1 AA on the guide itself. */
  test('has no accessibility violations', async ({ signedIn }) => {
    await signedIn.page.goto('/onboarding');

    const results = await new AxeBuilder({ page: signedIn.page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('the fixed-income rate gate', () => {
  /** AC-19 — axe at WCAG 2.1 AA on the resolution screen a gate links to. */
  test('the rate form has no accessibility violations', async ({ signedIn }) => {
    const { assetId } = await seedHeldFixedIncomeWithMissingRate(signedIn.userId, 'AXEFI');
    // BR-020-03: needed so this tenant is not mid-redirect to `/onboarding`
    // while asserting an unrelated screen's accessibility.
    await seedCommittedImportBatch(signedIn.userId);

    await signedIn.page.goto(`/fixed-income/${assetId}`);
    await expect(signedIn.page.getByRole('heading', { level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page: signedIn.page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
