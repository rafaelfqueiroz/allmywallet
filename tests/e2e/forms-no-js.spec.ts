import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHeldFixedIncomeWithMissingRate } from './support/fixed-income';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding } from './support/onboarding';

/**
 * SPEC-022 BR-022-37 (#238) — every create or edit form moved onto one layout:
 * a panel whose footer holds the buttons. DS-37 still holds for each of them:
 * the form posts natively, so it works with JavaScript off. The wallet forms'
 * own no-script journey is in settings-wallets.spec.ts; the import's in
 * import.spec.ts. This covers the rest — including the two mechanisms the
 * layout introduced: Excluir in an edit form's footer submitting a form of its
 * own (`form=`, a wallet and a goal), and a surface's parameters saved by one
 * form.
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

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    return (await pool.query<T>(sql, params as unknown[])).rows;
  } finally {
    await pool.end();
  }
}

const assetIdOf = async (code: string) =>
  (await query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [code]))[0]!.id;

/** A page with JavaScript off, carrying the signed-in session. */
async function withoutScript(
  browser: Browser,
  baseURL: string | undefined,
  signedInPage: Page,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ...(baseURL ? { baseURL } : {}),
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  try {
    await context.addCookies(await signedInPage.context().cookies());
    const page = await context.newPage();
    // Shorter than the test's own timeout, so a stuck step reports itself
    // rather than surfacing as the context closing under it.
    page.setDefaultTimeout(10_000);
    await run(page);
  } finally {
    await context.close();
  }
}

test.describe('BR-022-37 — the standard form posts without JavaScript', () => {
  test('Preferências: one form saves the changed parameter', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto('/preferences');
      await page.getByLabel('Limite de concentração (%)', { exact: true }).fill('41');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.goto('/preferences');
      await expect(page.getByLabel('Limite de concentração (%)', { exact: true })).toHaveValue(
        '41',
      );
    });
  });

  test('Objetivos: create, rename and delete a goal', async ({ browser, baseURL, signedIn }) => {
    const walletId = await seedWallet(signedIn.userId, 'Sem script');
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto(`/portfolio/goals?wallet=${walletId}`);
      const create = page
        .locator('form')
        .filter({ has: page.getByRole('heading', { name: 'Novo objetivo de crescimento' }) });
      await create.getByLabel('Nome', { exact: true }).fill('Meta sem script');
      await create.getByLabel('Valor (R$)', { exact: true }).fill('1000');
      await create.getByRole('button', { name: 'Criar objetivo' }).click();
      await expect(page.getByRole('heading', { name: 'Meta sem script' })).toBeVisible();

      const goal = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Meta sem script' }) });
      await goal.getByLabel('Nome', { exact: true }).fill('Meta renomeada');
      await goal.getByRole('button', { name: 'Salvar', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Meta renomeada' })).toBeVisible();

      // Excluir sits in the edit form's footer and submits its own form by `form=`.
      await page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Meta renomeada' }) })
        .getByRole('button', { name: 'Excluir objetivo' })
        .click();
      await expect(
        page.getByText('Esta carteira ainda não tem nenhum objetivo definido.'),
      ).toBeVisible();
    });
  });

  test('Observar preços: create a rule', async ({ browser, baseURL, signedIn }) => {
    const [code] = await seedHoldings(signedIn.userId, [
      { code: 'NJSW', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto('/settings/watch');
      await page.getByRole('link', { name: `Criar regra de ${code}` }).click();
      await page.getByLabel('Limite inferior (R$)').fill('20,00');
      await page.getByLabel('Neste limite ou abaixo dele, o preço significa').selectOption('buy');
      await page.getByRole('button', { name: 'Criar regra' }).click();
      await expect(page.getByRole('button', { name: 'Criar regra' })).toHaveCount(0, {
        timeout: 10_000,
      });
      await page.goto('/settings/watch');
      await expect(page.getByRole('link', { name: `Criar regra de ${code}` })).toHaveCount(0);

      // Edit it: the row's menu needs a script, so the editor is opened by URL.
      const assetId = await assetIdOf(code!);
      await page.goto(`/settings/watch?rule=${assetId}`);
      await page.getByLabel('Limite inferior (R$)').fill('21,00');
      await page.getByRole('button', { name: 'Salvar alterações' }).click();
      await page.goto(`/settings/watch?rule=${assetId}`);
      await expect(page.getByLabel('Limite inferior (R$)')).toHaveValue(/^21(\.0+)?$/);
    });
  });

  test('Renda fixa: supply a contract’s indexer and rate', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    const { assetId } = await seedHeldFixedIncomeWithMissingRate(signedIn.userId, 'NJSCDB');
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto(`/fixed-income/${assetId}`);
      await page.getByLabel('Indexador', { exact: true }).selectOption('cdi_percent');
      await page.getByLabel('Taxa contratada', { exact: true }).fill('110');
      await page.getByRole('button', { name: 'Salvar taxa' }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  });

  test('Transações: register a transaction', async ({ browser, baseURL, signedIn }) => {
    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto('/transactions/new');
      await page.getByLabel('Ou informe um código novo', { exact: true }).fill('CDB-SEM-JS');
      await page.getByLabel('Nome do ativo').fill('CDB sem script');
      await page.getByLabel('Classe').selectOption('cdb');
      await page.getByLabel('Tipo').selectOption('buy');
      await page.getByLabel('Data da operação').fill('2026-04-01');
      await page.getByLabel('Quantidade').fill('1');
      await page.getByLabel('Preço unitário', { exact: true }).fill('1.000,00');
      await page.getByRole('button', { name: 'Registrar transação' }).click();
      await expect(page).toHaveURL(/\/transactions$/);
      // The asset filter's <option> carries the name too; the row is what counts.
      // A CDB's row leads with its name (SPEC-022 BR-022-40, #242).
      await expect(
        page.getByText('CDB sem script', { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();
    });
  });

  test('Carteiras: Excluir carteira submits its own form', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    const walletId = await seedWallet(signedIn.userId, 'Excluir sem script');
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto(`/settings/wallets/${walletId}`);
      // Its own form holds no Nome, so a blank one does not block it.
      await page.getByLabel('Nome', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Excluir carteira', exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/wallets$/);
      await expect(page.getByText('Excluir sem script')).toHaveCount(0);
    });
  });

  test('Configurações › Parâmetros: a section’s parameters save', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto('/settings/wallets/parameters');
      await page.getByLabel('Tolerância de desvio (p.p.)', { exact: true }).fill('2.5');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await page.goto('/settings/wallets/parameters');
      await expect(page.getByLabel('Tolerância de desvio (p.p.)', { exact: true })).toHaveValue(
        '2.5',
      );
    });
  });

  test('Atribuir ativos: a standing rule from the queue', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    const [code] = await seedHoldings(signedIn.userId, [
      { code: 'NJSR', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await seedWallet(signedIn.userId, 'Regra sem script');
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto(`/settings/wallets/assign?resolve=${await assetIdOf(code!)}`);
      const panel = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: /^Regra permanente para / }) });
      await panel
        .getByLabel('Carteira das próximas compras', { exact: true })
        .selectOption({ label: 'Regra sem script' });
      await panel.getByRole('button', { name: 'Definir regra' }).click();
      // The rules list renders only once a rule exists (BR-010-14).
      await expect(
        page.getByRole('heading', { name: 'Regra permanente', exact: true }),
      ).toBeVisible();
    });
  });

  test('Carteiras › Balanceamento: the targets save', async ({ browser, baseURL, signedIn }) => {
    const [code] = await seedHoldings(signedIn.userId, [
      { code: 'NJSB', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    const walletId = await seedWallet(signedIn.userId, 'Metas sem script');
    await query(
      `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity, cost_basis_at_allocation)
       VALUES ($1, $2, $3, $4, 10, 200)`,
      [randomUUID(), signedIn.userId, walletId, await assetIdOf(code!)],
    );
    await dismissOnboarding(signedIn.userId);

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      await page.goto(`/portfolio/wallets?wallet=${walletId}`);
      await page.getByLabel('Modo', { exact: true }).selectOption({ label: 'Peso igual' });
      await page.getByRole('button', { name: 'Salvar metas' }).click();
      await page.goto(`/portfolio/wallets?wallet=${walletId}`);
      await expect(page.getByLabel('Modo', { exact: true })).toHaveValue('equal_weight');
    });
  });

  test('Transações: create and then edit an asset conversion', async ({
    browser,
    baseURL,
    signedIn,
  }) => {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const [from, to] = [`NJSFROM${suffix}`, `NJSTO${suffix}`];

    await withoutScript(browser, baseURL, signedIn.page, async (page) => {
      // Two assets with a history, through the form itself.
      for (const [code, date] of [
        [from, '2026-03-02'],
        [to, '2026-03-03'],
      ] as const) {
        await page.goto('/transactions/new');
        await page.getByLabel('Ou informe um código novo', { exact: true }).fill(code);
        await page.getByLabel('Nome do ativo').fill(`Ativo ${code}`);
        await page.getByLabel('Tipo').selectOption('buy');
        await page.getByLabel('Data da operação').fill(date);
        await page.getByLabel('Quantidade').fill('10');
        await page.getByLabel('Preço unitário', { exact: true }).fill('10,00');
        await page.getByRole('button', { name: 'Registrar transação' }).click();
        await expect(page).toHaveURL(/\/transactions$/);
      }

      await page.goto('/transactions/conversions/new');
      await page
        .getByLabel('Ativo de origem', { exact: true })
        .selectOption({ label: `${from} · Ativo ${from}` });
      await page
        .getByLabel('Ativo de destino', { exact: true })
        .selectOption({ label: `${to} · Ativo ${to}` });
      await page.getByLabel('Data da conversão', { exact: true }).fill('2026-03-10');
      await page.getByLabel('Quantidade que sai', { exact: true }).fill('10');
      await page.getByLabel('Quantidade que entra', { exact: true }).fill('5');
      await page.getByLabel('Custo transferido', { exact: true }).fill('100');
      await page.getByRole('button', { name: 'Registrar conversão' }).click();
      await expect(page).toHaveURL(/\/transactions$/);

      const [leg] = await query<{ id: string }>(
        `SELECT id FROM transactions WHERE user_id = $1 AND conversion_group_id IS NOT NULL LIMIT 1`,
        [signedIn.userId],
      );
      await page.goto(`/transactions/${leg!.id}/edit`);
      await page.getByRole('button', { name: 'Salvar conversão' }).click();
      await expect(page).toHaveURL(/\/transactions$/);
    });
  });
});
