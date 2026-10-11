import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding } from './support/onboarding';

/**
 * SPEC-022 BR-022-05/15/16/20/21 and SPEC-010 BR-010-03/07/09/12/13 —
 * Configurações › Carteiras, driven the way a person uses it: create a wallet,
 * edit it, assign a held asset from its own page, see the asset on it, delete
 * it; and resolve a pending allocation reached from the Painel.
 *
 * Holdings are seeded rather than imported: what is proven here is the setup
 * surface, and a held, unassigned position is its precondition.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

async function seedWallet(userId: string, name: string): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  const walletId = randomUUID();
  try {
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletId,
      userId,
      name,
    ]);
  } finally {
    await pool.end();
  }
  return walletId;
}

const isMobile = (viewportWidth: number | undefined) => (viewportWidth ?? 1280) < 768;

test.describe('Configurações › Carteiras', () => {
  test('creates, edits, assigns to and deletes a wallet', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'ASSG', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await dismissOnboarding(userId);

    // The list, empty: it says how to start (BR-022-18's empty state).
    await page.goto('/settings/wallets');
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    await expect(page.getByText('Você ainda não criou nenhuma carteira.')).toBeVisible();

    // The three tasks are three tabs, each its own URL (BR-022-15).
    const tabs = page.getByRole('navigation', { name: 'Tarefas de Carteiras' });
    await expect(tabs.getByRole('link', { name: 'Minhas carteiras' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tabs.getByRole('link', { name: 'Atribuir ativos' })).toHaveAttribute(
      'href',
      '/settings/wallets/assign',
    );
    await expect(tabs.getByRole('link', { name: 'Parâmetros' })).toHaveAttribute(
      'href',
      '/settings/wallets/parameters',
    );

    // BR-022-21: a name the input's `required` cannot see is refused by the
    // domain, and said under the field.
    await page.getByRole('link', { name: 'Nova carteira' }).first().click();
    await expect(page).toHaveURL(/\/settings\/wallets\/new$/);
    await expect(tabs.getByRole('link', { name: 'Minhas carteiras' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const name = page.getByLabel('Nome', { exact: true });
    await name.fill('   ');
    await page.getByLabel('Descrição', { exact: true }).fill('Para imprevistos');
    await page.getByRole('button', { name: 'Criar carteira' }).click();
    await expect(page.locator('#new-wallet-name-error')).toHaveText(
      'A carteira precisa de um nome.',
    );
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    // The rest of what was typed survives the refusal.
    await expect(page.getByLabel('Descrição', { exact: true })).toHaveValue('Para imprevistos');

    // The Objetivo instructions are behind the info icon (BR-022-20).
    await expect(page.getByLabel('Objetivo', { exact: true })).toHaveAccessibleDescription(
      /O propósito desta carteira/,
    );

    await name.fill('Reserva');
    await page.getByRole('button', { name: 'Criar carteira' }).click();

    // Created: on its own page.
    await expect(page).toHaveURL(/\/settings\/wallets\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Reserva' })).toBeVisible();
    await expect(page.getByText('Nenhum ativo atribuído a esta carteira ainda.')).toBeVisible();
    // BR-022-05: no portfolio figure on a setup screen.
    await expect(page.locator('main')).not.toContainText(/R\$\s*\d/);

    // Edit.
    await page.getByLabel('Nome', { exact: true }).fill('Reserva de emergência');
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Alterações salvas.' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Reserva de emergência' }),
    ).toBeVisible();

    // BR-010-05: more than is held is refused, under Quantidade, with the ceiling.
    const assign = page.locator('form').filter({ has: page.getByLabel('Ativo', { exact: true }) });
    await assign
      .getByLabel('Ativo', { exact: true })
      .selectOption({ label: `${code} — Ativo ${code} — 10 não atribuída(s)` });
    await assign.getByLabel('Quantidade', { exact: true }).fill('50');
    await assign.getByRole('button', { name: 'Atribuir', exact: true }).click();
    await expect(assign.getByLabel('Quantidade', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page.locator('#assign-quantity-error')).toContainText('você tem 10');
    await expect(page.getByText('Nenhum ativo atribuído a esta carteira ainda.')).toBeVisible();

    // BR-010-03: an empty quantity assigns the whole remainder in one click.
    await assign.getByLabel('Quantidade', { exact: true }).fill('');
    await assign.getByRole('button', { name: 'Atribuir', exact: true }).click();
    const table = page.getByRole('table');
    await expect(table).toContainText(code!);
    await expect(table).toContainText('10');
    // Nothing is left to assign, and the section says so.
    await expect(
      page.getByText('Todos os seus ativos já estão atribuídos a carteiras.'),
    ).toBeVisible();
    // The allocation table shows quantity, not cost (BR-022-05).
    await expect(table).not.toContainText('Custo');

    // The list counts it.
    await page.goto('/settings/wallets');
    // A table row on a desktop, a card on a phone (DL-12): whichever is shown.
    const row = page.locator('tr:visible, li:visible').filter({ hasText: 'Reserva de emergência' });
    await expect(row.getByText('1', { exact: true })).toBeVisible();

    // Delete (BR-010-07): back on the list, and the wallet is gone.
    await row.getByRole('link', { name: 'Reserva de emergência' }).click();
    await page.getByRole('button', { name: 'Excluir carteira' }).click();
    await expect(page).toHaveURL(/\/settings\/wallets$/);
    await expect(page.getByText('Você ainda não criou nenhuma carteira.')).toBeVisible();
  });

  test('a pending allocation reached from the Painel is resolved on Atribuir ativos', async ({
    signedIn,
    viewport,
  }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'PEND', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await seedWallet(userId, 'Aposentadoria');
    await dismissOnboarding(userId);

    await page.goto('/dashboard');
    const item = page.getByRole('listitem').filter({ hasText: code! });
    await item.getByRole('link', { name: 'Distribuir' }).click();

    await expect(page).toHaveURL(/\/settings\/wallets\/assign$/);
    await expect(page.getByRole('heading', { name: 'Precisa de atenção' })).toBeVisible();
    // Configurações is the current destination (BR-022-01); the sidebar is
    // a drawer on a phone, which the navigation spec covers.
    if (!isMobile(viewport?.width)) {
      await expect(page.getByRole('link', { name: 'Configurações' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }

    const queueItem = page.getByRole('listitem').filter({ hasText: code! });
    await queueItem
      .getByLabel('Atribuir a', { exact: true })
      .selectOption({ label: 'Aposentadoria' });
    // BR-010-13: the quantity arrives pre-filled with the unassigned remainder.
    await expect(queueItem.getByLabel('Quantidade', { exact: true })).toHaveValue('10');
    await queueItem.getByRole('button', { name: 'Atribuir', exact: true }).click();

    await expect(page.getByText('Nada esperando uma decisão no momento.')).toBeVisible();
  });

  test('every Carteiras screen holds at a phone width with no page scroll', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const walletId = await seedWallet(userId, 'Aposentadoria');
    await dismissOnboarding(userId);
    // 360px is the floor (SPEC-016 BR-016-12), below the Pixel 5 profile's own.
    await page.setViewportSize({ width: 360, height: 800 });

    for (const path of [
      '/settings/wallets',
      '/settings/wallets/new',
      '/settings/wallets/assign',
      '/settings/wallets/parameters',
      `/settings/wallets/${walletId}`,
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls the page sideways`).toBeLessThanOrEqual(0);
    }
  });

  test('has no axe violations on the list, the form, the queue and a wallet', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const walletId = await seedWallet(userId, 'Aposentadoria');
    await seedHoldings(userId, [
      { code: 'AXE', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await dismissOnboarding(userId);

    for (const path of [
      '/settings/wallets',
      '/settings/wallets/new',
      '/settings/wallets/assign',
      '/settings/wallets/parameters',
      `/settings/wallets/${walletId}`,
    ]) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, path).toEqual([]);
    }
  });

  test('/settings opens on Carteiras', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings\/wallets$/);
  });
});
