import { expect, test } from './support/authenticated';
import { dismissOnboarding } from './support/onboarding';

/**
 * SPEC-022 BR-022-16 (as amended, DL-022-18), BR-022-15 — Configurações is two
 * rows of tabs: its sections as the main tabs, each section's tasks as pills
 * beneath them, every one a URL of its own. No side sub-navigation (#241).
 */
const SECTIONS = [
  {
    section: 'Carteiras',
    tasksLabel: 'Tarefas de Carteiras',
    tasks: [
      ['Minhas carteiras', /\/settings\/wallets$/],
      ['Atribuir ativos', /\/settings\/wallets\/assign$/],
      ['Parâmetros', /\/settings\/wallets\/parameters$/],
    ],
  },
  {
    section: 'Importar',
    tasksLabel: 'Tarefas de Importar',
    tasks: [
      ['Enviar', /\/settings\/import$/],
      ['Histórico', /\/settings\/import\/history$/],
      ['Parâmetros', /\/settings\/import\/parameters$/],
    ],
  },
  {
    section: 'Observar preços',
    tasksLabel: 'Tarefas de Observar preços',
    tasks: [
      ['Regras', /\/settings\/watch$/],
      ['Parâmetros', /\/settings\/watch\/parameters$/],
    ],
  },
] as const;

test.describe('Configurações: two rows of tabs', () => {
  test('every section and task is reachable by its tab, and a reload keeps both selected', async ({
    signedIn,
  }) => {
    test.setTimeout(90_000);
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    await page.goto('/settings');

    const sections = page.getByRole('navigation', { name: 'Seções de Configurações' });
    for (const { section, tasksLabel, tasks } of SECTIONS) {
      await sections.getByRole('link', { name: section }).click();
      const pills = page.getByRole('navigation', { name: tasksLabel });
      // The section opens on its first task.
      await expect(page).toHaveURL(tasks[0][1]);

      for (const [task, url] of tasks) {
        await pills.getByRole('link', { name: task }).click();
        await expect(page).toHaveURL(url);

        for (const reloaded of [false, true]) {
          if (reloaded) await page.reload();
          const where = `${section} › ${task}${reloaded ? ' (reloaded)' : ''}`;
          await expect(sections.getByRole('link', { name: section }), where).toHaveAttribute(
            'aria-current',
            'page',
          );
          await expect(pills.getByRole('link', { name: task }), where).toHaveAttribute(
            'aria-current',
            'page',
          );
          // One current tab per row.
          await expect(sections.locator('[aria-current="page"]'), where).toHaveCount(1);
          await expect(pills.locator('[aria-current="page"]'), where).toHaveCount(1);
        }
      }
    }
  });

  test("each section's primary action sits on the pill row", async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    const row = page.locator('[data-slot="settings-tasks"]');

    await page.goto('/settings/wallets/assign');
    await row.getByRole('link', { name: 'Nova carteira' }).click();
    await expect(page).toHaveURL(/\/settings\/wallets\/new$/);

    // A rule starts from a held asset, so "Nova regra" lands on those without one.
    await page.goto('/settings/watch/parameters');
    await row.getByRole('link', { name: 'Nova regra' }).click();
    await expect(page).toHaveURL(/\/settings\/watch#ativos-sem-regra$/);
    await expect(
      page.getByRole('heading', { name: 'Ativos que você pode observar' }),
    ).toBeVisible();

    await page.goto('/settings/import');
    await expect(row.getByRole('link')).toHaveCount(3);
  });
});
