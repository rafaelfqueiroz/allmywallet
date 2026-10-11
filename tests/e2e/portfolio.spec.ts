import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-022 BR-022-02 / #208 — **Portfólio**: Patrimônio, Composição, Carteiras
 * and Metas, the current state of everything held, over the real stack.
 *
 * The fixture, chosen so every figure below is hand-computable and one of them
 * is the defect BR-022-34 removes:
 *
 *   A  100 un, cost R$ 30,00, price R$ 40,00 → value 4.000,00, cost 3.000,00
 *   B  100 un, cost R$ 10,00, price R$ 10,00 → value 1.000,00, cost 1.000,00
 *                                       total  5.000,00          4.000,00
 *
 * All of A sits in the wallet "Longo prazo"; B is Não atribuído. So the wallet
 * holds 80,00 % of the portfolio with a result of +R$ 1.000,00, and Não
 * atribuído 20,00 % with R$ 0,00. A quantity summed across the two assets
 * would read **200** — a number of nothing, which is what "Reserva de
 * Oportunidade 30.500.000" was — and it must appear nowhere.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

const WALLET = 'Longo prazo';

interface Seeded {
  readonly walletId: string;
  readonly codes: readonly string[];
}

async function seedPortfolio(userId: string): Promise<Seeded> {
  const codes = await seedHoldings(userId, [
    { code: 'PORTA', quantity: '100', averageCost: '30', price: '40' },
    { code: 'PORTB', quantity: '100', averageCost: '10', price: '10' },
  ]);
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
      codes[0],
    ]);
    const assetId = rows[0]?.id;
    if (assetId === undefined) throw new Error(`no asset seeded for ${codes[0]}`);

    // `wallets.id` has no database default — the application generates it.
    const walletId = randomUUID();
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletId,
      userId,
      WALLET,
    ]);
    await pool.query(
      `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity, cost_basis_at_allocation)
       VALUES ($1, $2, $3, $4, 100, 3000)`,
      [randomUUID(), userId, walletId, assetId],
    );
    return { walletId, codes };
  } finally {
    await pool.end();
  }
}

const TABS = [
  { label: 'Patrimônio', path: '/portfolio' },
  { label: 'Composição', path: '/portfolio/composition' },
  { label: 'Carteiras', path: '/portfolio/wallets' },
  { label: 'Metas', path: '/portfolio/goals' },
] as const;

/** Both renderings of a table are in the DOM (DL-12); only one is displayed. */
function visible(page: Page, text: string | RegExp) {
  return page.getByText(text).filter({ visible: true }).first();
}

/**
 * BR-022-02 / DL-022-02 — current state takes no period. Relatórios' period
 * control is a select offering "Ano até hoje" beside two date fields
 * (`Controls.tsx`); none of them exists on any Portfólio tab, at either scope.
 * Matched by the option, not by a "Período" label: a yearly earnings goal's
 * own "Período" (monthly/yearly, SPEC-019) is part of the goal, not a range.
 */
test('every tab renders under one header, with no period control', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const { walletId } = await seedPortfolio(userId);

  for (const scope of ['', `?wallet=${walletId}`]) {
    for (const tab of TABS) {
      await page.goto(`${tab.path}${scope}`);
      await expect(page.locator('#__next_error__')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1, name: 'Portfólio' })).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Portfólio' }).getByRole('link', { name: tab.label }),
      ).toHaveAttribute('aria-current', 'page');

      await expect(page.locator('select option[value="ytd"]')).toHaveCount(0);
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
    }
  }
});

/**
 * BR-022-17 — one scope selector, carried in the URL: choosing a wallet on one
 * tab keeps it on every other tab and through a reload.
 */
test('the scope selector keeps its wallet across the four tabs and through a reload', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const { walletId } = await seedPortfolio(userId);

  await page.goto('/portfolio');
  const selector = page.locator('[data-slot="scope-selector"]');
  await expect(selector).toContainText('Todas as carteiras');
  await selector.click();
  await page.getByRole('menuitemradio', { name: WALLET }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio\\?wallet=${walletId}$`));

  for (const tab of TABS) {
    await page
      .getByRole('navigation', { name: 'Portfólio' })
      .getByRole('link', { name: tab.label })
      .click();
    await expect(page).toHaveURL(new RegExp(`${tab.path}\\?wallet=${walletId}$`));
    await expect(page.locator('[data-slot="scope-selector"]')).toContainText(WALLET);

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${tab.path}\\?wallet=${walletId}$`));
    await expect(page.locator('[data-slot="scope-selector"]')).toContainText(WALLET);
  }

  // And the scoped figures are the wallet's: Patrimônio shows A alone.
  await page.goto(`/portfolio?wallet=${walletId}`);
  await expect(visible(page, /R\$\s*4\.000,00/)).toBeVisible();
  await expect(page.getByText(/R\$\s*5\.000,00/)).toHaveCount(0);
});

/**
 * BR-022-02 — Patrimônio: the total, by class and by asset, with BR-005-27's
 * dates beside it.
 */
test('Patrimônio shows the total, the class card and every asset', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const { codes } = await seedPortfolio(userId);

  await page.goto('/portfolio');

  // Patrimônio 5.000,00; Valor aplicado 4.000,00; result +1.000,00, +25,00 %.
  await expect(visible(page, /R\$\s*5\.000,00/)).toBeVisible();
  await expect(visible(page, /R\$\s*4\.000,00/)).toBeVisible();
  await expect(visible(page, /\+R\$\s*1\.000,00/)).toBeVisible();
  await expect(visible(page, '+25,00%')).toBeVisible();

  // One class (both seeded assets are stocks): 100 % of the portfolio, 2 assets.
  const card = page.locator('[data-slot="class-card"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Ações');
  await expect(card).toContainText('100,00%');
  await expect(card).toContainText('2 ativos');

  for (const code of codes) await expect(visible(page, code)).toBeVisible();
  await expect(page.getByText(/última importação|nenhum extrato importado/i)).toBeVisible();
});

/**
 * BR-022-34 — no quantity total across different assets, on the tab that
 * replaced Relatórios' grouped table nor on the wallet comparison. Each
 * asset's own 100 may appear; their sum, 200, must not.
 */
test('no quantity total is shown across different assets', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedPortfolio(userId);

  for (const path of ['/portfolio', '/portfolio/wallets']) {
    await page.goto(path);
    await expect(visible(page, /R\$\s*5\.000,00/)).toBeVisible();
    await expect(page.getByText('200', { exact: true })).toHaveCount(0);
  }

  // The comparison has no quantity column at all.
  const comparison = page.getByRole('table', { name: 'Comparação entre carteiras' });
  await expect(comparison.getByRole('columnheader', { name: /quantidade/i })).toHaveCount(0);
});

/**
 * BR-022-02 / BR-022-34 — Carteiras compares wallets by value, cost, result
 * and share of the portfolio, with Não atribuído as a row, and the wallets
 * plus Não atribuído add up to the portfolio (BR-011-08).
 */
test('Carteiras compares wallets by value, cost, result and share', async ({
  signedIn,
  viewport,
}) => {
  test.skip(!viewport || viewport.width < 768, 'the comparison is a table; asserted by cell');
  const { page, userId } = signedIn;
  const { walletId } = await seedPortfolio(userId);

  await page.goto('/portfolio/wallets');
  const comparison = page.getByRole('table', { name: 'Comparação entre carteiras' });

  const wallet = comparison.getByRole('row', { name: new RegExp(WALLET) });
  await expect(wallet).toContainText('4.000,00');
  await expect(wallet).toContainText('3.000,00');
  await expect(wallet).toContainText('+R$');
  await expect(wallet).toContainText('1.000,00');
  await expect(wallet).toContainText('80,00%');

  const unassigned = comparison.getByRole('row', { name: /Não atribuído/ });
  await expect(unassigned).toContainText('1.000,00');
  await expect(unassigned).toContainText('20,00%');

  const total = comparison.getByRole('row', { name: /Total/ });
  await expect(total).toContainText('5.000,00');
  await expect(total).toContainText('4.000,00');
  await expect(total).toContainText('100,00%');

  // The wallet's name opens its balancing: this tab, scoped to it.
  await wallet.getByRole('link', { name: WALLET }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/wallets\\?wallet=${walletId}$`));
  await expect(page.getByRole('heading', { name: `Balanceamento · ${WALLET}` })).toBeVisible();
});

/** SPEC-019 — Metas at "all wallets" lists the wallets, each opening its goals. */
test('Metas lists the wallets and opens one scoped to it', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const { walletId } = await seedPortfolio(userId);

  await page.goto('/portfolio/goals');
  await page.getByRole('link', { name: WALLET }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/goals\\?wallet=${walletId}$`));
  await expect(page.getByRole('heading', { name: `Metas · ${WALLET}` })).toBeVisible();
  await expect(page.locator('[data-slot="scope-selector"]')).toContainText(WALLET);
});

/**
 * BR-022-08 — an old link from before #208 lands on the right tab with its
 * wallet selected. The redirect itself (308, one hop) is asserted per row in
 * `redirects.spec.ts`; this is what the person who clicked it sees.
 */
test('an old wallet link lands on the right tab with the wallet selected', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const { walletId } = await seedPortfolio(userId);

  await page.goto(`/wallets/${walletId}/balance`);
  await expect(page).toHaveURL(new RegExp(`/portfolio/wallets\\?wallet=${walletId}$`));
  await expect(page.locator('[data-slot="scope-selector"]')).toContainText(WALLET);

  await page.goto(`/wallets/${walletId}/goals`);
  await expect(page).toHaveURL(new RegExp(`/portfolio/goals\\?wallet=${walletId}$`));

  await page.goto('/wallets');
  await expect(page).toHaveURL(/\/portfolio\/wallets$/);

  await page.goto('/reports/composition');
  await expect(page).toHaveURL(/\/portfolio\/composition$/);
});

/**
 * The owner's decision on #208: wallet setup stays inside Carteiras, as its
 * **last** sub-tab, never on the analysis page (BR-022-15). #210 moves it to
 * Configurações › Carteiras.
 */
test('wallet setup is the last Carteiras sub-tab, apart from the comparison', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  await seedPortfolio(userId);

  await page.goto('/portfolio/wallets');
  const tabs = page.getByRole('navigation', { name: 'Carteiras', exact: true }).getByRole('link');
  await expect(tabs).toHaveText(['Comparação', 'Configurar']);
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Nova carteira' })).toHaveCount(0);

  await tabs.last().click();
  await expect(page).toHaveURL(/\/portfolio\/wallets\/setup$/);
  await expect(page.getByRole('heading', { name: 'Nova carteira' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Comparação entre carteiras' })).toHaveCount(0);
  // Portfólio's own tab bar still says where this is.
  await expect(
    page.getByRole('navigation', { name: 'Portfólio' }).getByRole('link', { name: 'Carteiras' }),
  ).toHaveAttribute('aria-current', 'page');

  // Creating a wallet from here works and lists it.
  await page.getByLabel('Nome', { exact: true }).fill('Reserva');
  await page.getByRole('button', { name: 'Criar carteira' }).click();
  await expect(page.getByRole('link', { name: 'Reserva', exact: true })).toBeVisible();
});
