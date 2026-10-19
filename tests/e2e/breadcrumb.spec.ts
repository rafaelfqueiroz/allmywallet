import { expect, test } from './support/authenticated';
import { dismissOnboarding } from './support/onboarding';

/**
 * SPEC-022 BR-022-09 (amended, DL-022-27, #254) — from `md` up, every
 * authenticated page shows a breadcrumb in the top bar that matches the
 * current sidebar item, tab and task, and updates on a client-side tab switch.
 * Below `md` the brand and the menu button hold the slot.
 */
const PAGES: readonly (readonly [string, readonly string[]])[] = [
  ['/dashboard', ['Dashboard']],
  ['/portfolio', ['Portfólio', 'Patrimônio']],
  ['/portfolio/composition', ['Portfólio', 'Composição']],
  ['/reports/earnings', ['Relatórios', 'Proventos']],
  ['/transactions', ['Transações']],
  ['/settings/wallets', ['Configurações', 'Carteiras', 'Minhas carteiras']],
  ['/settings/wallets/new', ['Configurações', 'Carteiras', 'Minhas carteiras']],
  ['/settings/wallets/assign', ['Configurações', 'Carteiras', 'Atribuir ativos']],
  ['/settings/wallets/parameters', ['Configurações', 'Carteiras', 'Parâmetros']],
  ['/settings/import', ['Configurações', 'Importar', 'Enviar']],
  ['/settings/import/history', ['Configurações', 'Importar', 'Histórico']],
  ['/settings/import/parameters', ['Configurações', 'Importar', 'Parâmetros']],
  ['/settings/watch', ['Configurações', 'Observar preços', 'Regras']],
  ['/settings/watch/parameters', ['Configurações', 'Observar preços', 'Parâmetros']],
  ['/preferences', ['Preferências']],
];

test.describe('the top bar’s breadcrumb', () => {
  test('names every destination, tab and Configurações task', async ({ signedIn, viewport }) => {
    test.skip(!viewport || viewport.width < 768, 'the breadcrumb is hidden below md');
    test.setTimeout(90_000);
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);

    const crumb = page.getByRole('banner').getByRole('navigation', { name: 'Você está em' });
    for (const [path, trail] of PAGES) {
      await page.goto(path);
      await expect(crumb.getByRole('listitem'), path).toHaveText([...trail]);
      // The last crumb is the page itself; every earlier one is a link.
      await expect(crumb.locator('[aria-current="page"]'), path).toHaveText(trail.at(-1) ?? '');
      await expect(crumb.getByRole('link'), path).toHaveCount(trail.length - 1);
    }
  });

  test('follows a client-side tab switch without a reload, and links back up', async ({
    signedIn,
    viewport,
  }) => {
    test.skip(!viewport || viewport.width < 768, 'the breadcrumb is hidden below md');
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    await page.goto('/settings/import');

    const crumb = page.getByRole('banner').getByRole('navigation', { name: 'Você está em' });
    await expect(crumb.getByRole('listitem')).toHaveText(['Configurações', 'Importar', 'Enviar']);

    // A marker a full page load would wipe.
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await page
      .getByRole('navigation', { name: 'Tarefas de Importar' })
      .getByRole('link', { name: 'Histórico' })
      .click();
    await expect(page).toHaveURL(/\/settings\/import\/history$/);
    await expect(crumb.getByRole('listitem')).toHaveText([
      'Configurações',
      'Importar',
      'Histórico',
    ]);
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);

    await crumb.getByRole('link', { name: 'Importar' }).click();
    await expect(page).toHaveURL(/\/settings\/import$/);
    await expect(crumb.getByRole('listitem')).toHaveText(['Configurações', 'Importar', 'Enviar']);
  });

  test('is hidden on a phone, where the brand holds the slot', async ({ signedIn, viewport }) => {
    test.skip(!viewport || viewport.width >= 768, 'the phone rendering');
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    await page.goto('/portfolio/composition');

    const bar = page.getByRole('banner');
    await expect(bar.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
    await expect(bar.getByRole('navigation', { name: 'Você está em' })).toBeHidden();
  });
});
