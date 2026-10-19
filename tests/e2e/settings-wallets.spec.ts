import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding } from './support/onboarding';
import { expectPageSizeSurvivesReload } from './support/page-size';

/**
 * SPEC-022 BR-022-05/15/16/20/21 and SPEC-010 BR-010-03/07/09/12/13 —
 * Configurações › Carteiras, driven the way a person uses it: create a wallet,
 * edit it, assign a held asset from its own page, see the asset on it, delete
 * it; and resolve a pending allocation reached from the Dashboard.
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

/**
 * Allocates each held asset's whole quantity to a wallet, straight to the table:
 * what a wallet's page lists as its assets, without twelve trips through a form.
 */
async function allocateAll(
  userId: string,
  walletId: string,
  codes: readonly string[],
): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM assets WHERE code = ANY($1::text[])`,
      [codes],
    );
    for (const { id } of rows) {
      await pool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity, cost_basis_at_allocation)
         VALUES ($1, $2, $3, $4, 10, 200)`,
        [randomUUID(), userId, walletId, id],
      );
    }
  } finally {
    await pool.end();
  }
}

/** Twelve holdings, one over a page of ten, with codes that sort in seeding order. */
function manyHoldings(prefix: string) {
  return Array.from({ length: 12 }, (_, index) => ({
    code: `${prefix}${String(index + 1).padStart(2, '0')}`,
    quantity: '10',
    averageCost: '20.00',
    price: '25.00',
  }));
}

/**
 * The panel the queue's forms sit in: a table holds no form (BR-022-18), so the
 * forms for the asset being resolved are in a section of their own, titled by it.
 */
function resolvePanel(page: Page, code: string) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^Resolver .*${code}`) }) });
}

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
    await expect(
      page
        .getByRole('navigation', { name: 'Seções de Configurações' })
        .getByRole('link', { name: 'Carteiras' }),
    ).toHaveAttribute('aria-current', 'page');
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
    // BR-022-16: not a task, so Carteiras stays the current section and the
    // way back sits where the task pills would.
    await expect(
      page
        .getByRole('navigation', { name: 'Seções de Configurações' })
        .getByRole('link', { name: 'Carteiras' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(tabs).toHaveCount(0);
    await expect(
      page
        .locator('[data-slot="settings-tasks"]')
        .getByRole('link', { name: 'Voltar para Minhas carteiras' }),
    ).toHaveAttribute('href', '/settings/wallets');

    // Edit.
    // Enter saves: Excluir carteira comes first in the footer but submits a form
    // of its own, so it is not this form's default button (#238 review).
    await page.getByLabel('Nome', { exact: true }).fill('Reserva de emergência');
    await page.getByLabel('Nome', { exact: true }).press('Enter');
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
    const table = page.locator('[data-slot="data-table"]').first();
    await expect(table).toContainText(code!);
    await expect(table).toContainText('10');
    // Nothing is left to assign, and the section says so.
    await expect(
      page.getByText('Todos os seus ativos já estão atribuídos a carteiras.'),
    ).toBeVisible();
    // The allocation table shows quantity, not cost (BR-022-05).
    await expect(table).not.toContainText('Custo');
    // BR-022-05, again with an asset on the wallet: this is where a cost or a
    // value would have appeared.
    await expect(page.locator('main')).not.toContainText(/R\$\s*\d/);

    // The list counts it.
    await page.goto('/settings/wallets');
    // A table row on a desktop, a card on a phone (DL-12): whichever is shown.
    const row = page.locator('tr:visible, li:visible').filter({ hasText: 'Reserva de emergência' });
    await expect(row.getByText('1', { exact: true })).toBeVisible();

    // Delete (BR-010-07): back on the list, and the wallet is gone.
    await row.getByRole('link', { name: 'Reserva de emergência' }).click();
    // SPEC-022 BR-022-37: Excluir sits in the edit form's footer and posts that
    // form to its own action — a blank Nome does not stop it.
    await page.getByLabel('Nome', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Excluir carteira', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/wallets$/);
    await expect(page.getByText('Você ainda não criou nenhuma carteira.')).toBeVisible();
  });

  test('a pending allocation reached from the Dashboard is resolved on Atribuir ativos', async ({
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

    // BR-022-18: the queue is a table, and its forms are not in it — the asset
    // is in the table and its forms are in the panel below.
    await expect(page.locator('[data-slot="data-table"]').first()).toContainText(code!);
    const queueItem = resolvePanel(page, code!);
    await queueItem
      .getByLabel('Atribuir a', { exact: true })
      .selectOption({ label: 'Aposentadoria' });
    // BR-010-13: the quantity arrives pre-filled with the unassigned remainder.
    await expect(queueItem.getByLabel('Quantidade', { exact: true })).toHaveValue('10');
    await queueItem.getByRole('button', { name: 'Atribuir', exact: true }).click();

    await expect(page.getByText('Nada esperando uma decisão no momento.')).toBeVisible();
  });

  /**
   * SPEC-010 BR-010-04/13 — a deliberate split, made in place. After the first
   * assignment the form must offer what is *left*, not what was just typed: the
   * queue pre-fills the new remainder, and a wallet's own page starts empty
   * again. Neither test navigates between the two assignments, which is the
   * only way to see a form that kept the submitted values after a success.
   */
  test('a partial assignment in the queue offers the remainder for the next one', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'SPLT', quantity: '100', averageCost: '20.00', price: '25.00' },
    ]);
    await seedWallet(userId, 'Aposentadoria');
    await seedWallet(userId, 'Trading');
    await dismissOnboarding(userId);

    await page.goto('/settings/wallets/assign');
    const item = resolvePanel(page, code!);
    await item.getByLabel('Atribuir a', { exact: true }).selectOption({ label: 'Aposentadoria' });
    await item.getByLabel('Quantidade', { exact: true }).fill('60');
    await item.getByRole('button', { name: 'Atribuir', exact: true }).click();

    // No navigation: the same form, now offering the 40 that remain.
    await expect(item.getByLabel('Quantidade', { exact: true })).toHaveValue('40');
    await expect(item.getByLabel('Atribuir a', { exact: true })).toHaveValue('');

    await item.getByLabel('Atribuir a', { exact: true }).selectOption({ label: 'Trading' });
    await item.getByRole('button', { name: 'Atribuir', exact: true }).click();
    await expect(page.locator('[data-slot="error-state"]')).toHaveCount(0);
    await expect(page.getByText('Nada esperando uma decisão no momento.')).toBeVisible();
  });

  /**
   * DESIGN.md DS-37 — the setup forms post **without JavaScript** (PR #229
   * review). A client function wrapped around the server action has no
   * `$$FORM_ACTION`, so the form would render with nowhere to post: every
   * form here must hand the server action itself to the hook.
   *
   * The context is built here because the `signedIn` fixture cannot disable
   * scripting; its cookies are copied so this is the same seeded tenant.
   */
  test('creates, edits and assigns with JavaScript switched off', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    const { page: seededPage, userId } = signedIn;
    const [held, pending] = await seedHoldings(userId, [
      { code: 'NOJS', quantity: '10', averageCost: '20.00', price: '25.00' },
      { code: 'NJSQ', quantity: '5', averageCost: '20.00', price: '25.00' },
    ]);
    await dismissOnboarding(userId);

    const context = await browser.newContext({
      javaScriptEnabled: false,
      ...(baseURL ? { baseURL } : {}),
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });
    try {
      await context.addCookies(await seededPage.context().cookies());
      const page = await context.newPage();

      // Create: the action redirects to the new wallet's page.
      await page.goto('/settings/wallets/new');
      await page.getByLabel('Nome', { exact: true }).fill('Sem script');
      await page.getByRole('button', { name: 'Criar carteira' }).click();
      await expect(page).toHaveURL(/\/settings\/wallets\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 2, name: 'Sem script' })).toBeVisible();

      // Edit.
      await page.getByLabel('Nome', { exact: true }).fill('Sem script, editada');
      await page.getByRole('button', { name: 'Salvar alterações' }).click();
      await expect(
        page.getByRole('heading', { level: 2, name: 'Sem script, editada' }),
      ).toBeVisible();

      // Assign from the wallet's page: an empty quantity takes everything (BR-010-03).
      await page
        .getByLabel('Ativo', { exact: true })
        .selectOption({ label: `${held} — Ativo ${held} — 10 não atribuída(s)` });
      await page.getByRole('button', { name: 'Atribuir', exact: true }).click();
      await expect(page.locator('[data-slot="data-table"]').first()).toContainText(held!);

      // Assign from the queue (BR-010-13): the same form, the wallet chosen.
      await page.goto('/settings/wallets/assign');
      const item = resolvePanel(page, pending!);
      await item.getByLabel('Atribuir a', { exact: true }).selectOption({
        label: 'Sem script, editada',
      });
      await item.getByRole('button', { name: 'Atribuir', exact: true }).click();
      await expect(page.getByText('Nada esperando uma decisão no momento.')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a partial assignment on a wallet’s page leaves the form empty for the next', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'WSPL', quantity: '100', averageCost: '20.00', price: '25.00' },
    ]);
    const walletId = await seedWallet(userId, 'Aposentadoria');
    await dismissOnboarding(userId);

    await page.goto(`/settings/wallets/${walletId}`);
    const asset = page.getByLabel('Ativo', { exact: true });
    const quantity = page.getByLabel('Quantidade', { exact: true });
    await asset.selectOption({ label: `${code} — Ativo ${code} — 100 não atribuída(s)` });
    await quantity.fill('60');
    await page.getByRole('button', { name: 'Atribuir', exact: true }).click();

    await expect(page.locator('[data-slot="data-table"]').first()).toContainText('60');
    await expect(quantity).toHaveValue('');
    await expect(asset).toHaveValue('');
    // What is left is what the select now offers.
    await expect(asset.locator('option', { hasText: '40 não atribuída(s)' })).toHaveCount(1);

    await asset.selectOption({ label: `${code} — Ativo ${code} — 40 não atribuída(s)` });
    await page.getByRole('button', { name: 'Atribuir', exact: true }).click();
    await expect(page.locator('[data-slot="data-table"]').first()).toContainText('100');
    await expect(page.locator('[data-slot="error-state"]')).toHaveCount(0);
  });

  /**
   * SPEC-010 BR-010-14 — a standing rule is per asset, so setting one on a
   * second wallet *moves* it. The select says where it points now, so the move
   * is never silent.
   */
  test('says where a standing rule currently points before moving it', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'RULE', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    const first = await seedWallet(userId, 'Aposentadoria');
    const second = await seedWallet(userId, 'Trading');
    await dismissOnboarding(userId);

    await page.goto(`/settings/wallets/${first}`);
    await page.getByLabel('Ativo da regra', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Definir regra' }).click();
    await expect(page.getByRole('button', { name: `Remover regra de ${code}` })).toBeVisible();

    await page.goto(`/settings/wallets/${second}`);
    await expect(
      page
        .getByLabel('Ativo da regra', { exact: true })
        .locator('option', { hasText: '(regra atual: Aposentadoria)' }),
    ).toHaveCount(1);
  });

  /**
   * SPEC-022 BR-022-18 — the queue is a table that pages, and a row's
   * "Resolver" opens that asset's forms without losing the table's own page.
   */
  test('the queue pages, and Resolver opens the asset it names', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const codes = await seedHoldings(userId, manyHoldings('QUE'));
    await seedWallet(userId, 'Aposentadoria');
    await dismissOnboarding(userId);

    await page.goto('/settings/wallets/assign');
    await expectPageSizeSurvivesReload(page, 'Ativos esperando uma decisão', 'pending', 12);

    // With no asset named, the panel opens on one of the queue's.
    await expect(page.getByRole('heading', { name: /^Resolver / })).toBeVisible();

    // A row's link opens that asset's forms, and the table keeps its own state.
    const third = codes[2]!;
    await page.getByRole('link', { name: `Resolver ${third}` }).click();
    await expect(page).toHaveURL(/[?&]resolve=/);
    await expect(page).toHaveURL(/[?&]pending_size=25(&|#|$)/);
    await expect(resolvePanel(page, third)).toBeVisible();
    await expect(resolvePanel(page, third).getByLabel('Atribuir a', { exact: true })).toBeVisible();
  });

  test('a wallet’s assigned assets and standing rules page, and keep the page size through a reload', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const codes = await seedHoldings(userId, manyHoldings('ALC'));
    const walletId = await seedWallet(userId, 'Aposentadoria');
    await allocateAll(userId, walletId, codes);
    await dismissOnboarding(userId);

    await page.goto(`/settings/wallets/${walletId}`);
    await expectPageSizeSurvivesReload(page, 'Ativos atribuídos', 'allocations', 12);
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
