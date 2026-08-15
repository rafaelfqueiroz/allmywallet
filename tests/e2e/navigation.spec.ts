import { expect, test } from '@playwright/test';

/**
 * DL-10/DL-11 — the application frame. Before PR2 the app had no navigation at
 * all; every screen was reachable only by typing a URL. These journeys are the
 * ones that would make that regression silent again.
 *
 * The suite runs twice, on `e2e-desktop` and `e2e-mobile`, because the two
 * viewports render genuinely different navigation: a sidebar and a drawer.
 */

const isMobile = (viewportWidth: number) => viewportWidth < 768;

test.describe('application navigation', () => {
  test('reaches every destination from the shell', async ({ page, viewport }) => {
    await page.goto('/wallets');

    if (viewport && isMobile(viewport.width)) {
      // Below md the sidebar is not rendered; the drawer is the only way.
      await page.getByRole('button', { name: 'Abrir menu' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }

    await page.getByRole('link', { name: 'Importar' }).click();
    await expect(page).toHaveURL(/\/import$/);
  });

  test('marks the current destination for assistive technology', async ({ page, viewport }) => {
    await page.goto('/import');

    if (viewport && isMobile(viewport.width)) {
      await page.getByRole('button', { name: 'Abrir menu' }).click();
    }

    await expect(page.getByRole('link', { name: 'Importar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('offers a skip link before the navigation', async ({ page }) => {
    await page.goto('/wallets');

    // Visible only on focus, so the first Tab is the assertion.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
  });
});
