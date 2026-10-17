import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-022 BR-022-03 / BR-022-17 (#209) — **Relatórios holds performance over
 * a period, and every tab takes one.** Its tabs are Evolução patrimonial,
 * Rentabilidade and Proventos; the scope is the header selector Portfólio
 * shares, carried in the URL.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

const TABS = [
  { label: 'Evolução patrimonial', path: '/reports' },
  { label: 'Rentabilidade', path: '/reports/performance' },
  { label: 'Proventos', path: '/reports/earnings' },
] as const;

async function seedWallet(userId: string, name: string): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const id = randomUUID();
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      id,
      userId,
      name,
    ]);
    return id;
  } finally {
    await pool.end();
  }
}

test('every Relatórios tab shows a period, and no tab is current state', async ({ signedIn }) => {
  const { page } = signedIn;

  for (const tab of TABS) {
    await page.goto(tab.path);
    await expect(page.getByRole('heading', { level: 1, name: 'Relatórios' })).toBeVisible();

    const tabs = page.getByRole('navigation', { name: 'Relatórios' });
    await expect(tabs.getByRole('link')).toHaveCount(TABS.length);
    await expect(tabs.getByRole('link', { name: tab.label })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // BR-022-03 / BR-011-01 — the period, on every tab.
    await expect(page.getByLabel('Período')).toBeVisible();
    // BR-022-17 — the scope is the header's selector, not a field of the bar.
    await expect(page.locator('[data-slot="scope-selector"]')).toBeVisible();
    await expect(page.locator('form select[name="wallet"]')).toHaveCount(0);
    // The CSV is holdings by grouping — Evolução patrimonial's subject only.
    if (tab.path !== '/reports') {
      await expect(page.getByRole('link', { name: 'Exportar CSV' })).toHaveCount(0);
    }
  }

  // Visão geral and Composição left with #208.
  const tabs = page.getByRole('navigation', { name: 'Relatórios' });
  await expect(tabs.getByRole('link', { name: 'Visão geral' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Composição' })).toHaveCount(0);
});

test('the scope chosen in Portfólio is still the scope in Relatórios, tab after tab', async ({
  signedIn,
  viewport,
}) => {
  const { page, userId } = signedIn;
  const name = 'Escopo compartilhado';
  /** The application menu: the sidebar, or below `md` the drawer behind its button. */
  const menu = async () => {
    if (viewport && viewport.width < 768) {
      await page.getByRole('button', { name: 'Abrir menu' }).click();
    }
    return page.getByRole('navigation', { name: 'Navegação' });
  };
  const walletId = await seedWallet(userId, name);

  await page.goto('/portfolio');
  await page.locator('[data-slot="scope-selector"]').click();
  await page.getByRole('menuitemradio', { name }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio\\?wallet=${walletId}$`));

  // The application menu carries the scope between the two destinations.
  await (await menu()).getByRole('link', { name: 'Relatórios' }).click();
  await expect(page).toHaveURL(new RegExp(`/reports\\?wallet=${walletId}$`));
  await expect(page.locator('[data-slot="scope-selector"]')).toContainText(name);

  // Applying a period keeps the header's wallet (the bar carries it hidden).
  await page.getByLabel('Período').selectOption('12m');
  await page.getByRole('button', { name: /aplicar/i }).click();
  await expect(page).toHaveURL(new RegExp(`wallet=${walletId}`));
  await expect(page).toHaveURL(/period=12m/);

  // Switching tabs keeps the scope and the period (BR-011-11).
  for (const tab of TABS.slice(1)) {
    await page
      .getByRole('navigation', { name: 'Relatórios' })
      .getByRole('link', { name: tab.label })
      .click();
    await expect(page).toHaveURL(new RegExp(`${tab.path}\\?`));
    await expect(page).toHaveURL(new RegExp(`wallet=${walletId}`));
    await expect(page).toHaveURL(/period=12m/);
    await expect(page.locator('[data-slot="scope-selector"]')).toContainText(name);
    await expect(page.getByLabel('Período')).toHaveValue('12m');
  }

  // And back to Portfólio, still scoped.
  await (await menu()).getByRole('link', { name: 'Portfólio' }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio\\?wallet=${walletId}$`));
});

/**
 * #227 review — the filter fields are uncontrolled, and the header's scope
 * selector navigates on the client. Choosing a wallet moves the default
 * grouping from asset class to asset (BR-011-04); the select must follow, or
 * it disagrees with the report and the next Aplicar changes the grouping
 * again. Portfólio › Composição's grouping form has the same shape.
 */
test('the grouping field follows a scope chosen in the header', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const name = 'Agrupamento';
  const walletId = await seedWallet(userId, name);

  for (const path of ['/reports', '/portfolio/composition']) {
    await page.goto(path);
    const grouping = page.getByRole('combobox', { name: /agrupar por/i });
    await expect(grouping).toHaveValue('asset_class');

    await page.locator('[data-slot="scope-selector"]').click();
    await page.getByRole('menuitemradio', { name }).click();
    await expect(page).toHaveURL(new RegExp(`wallet=${walletId}`));
    await expect(grouping).toHaveValue('asset');
  }
});

/**
 * SPEC-022 BR-022-03 / SPEC-015 BR-015-04 — composition drift over the period
 * is shown in Evolução patrimonial. A baseline snapshot before the period
 * holds stock and FII half and half; today the tenant holds stock alone, so
 * FII went from 50 % to 0 % — the position that left, which is the drift the
 * table exists to show.
 */
test('Evolução patrimonial shows the composition drift over the period', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedHoldings(userId, [{ code: 'DRIFT', quantity: '100', averageCost: '10', price: '10' }]);

  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    // Dated by São Paulo's calendar, the app's own; Postgres' CURRENT_DATE is
    // UTC's (see hide-values.spec.ts).
    await pool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       VALUES ($1, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20, 1000, 1000, 0, $2)`,
      [userId, JSON.stringify({ stock: '500', fii: '500' })],
    );
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 10, 'YYYY-MM-DD') AS from,
              to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS to`,
    );
    const range = rows[0];
    if (range === undefined) throw new Error('no range');

    await page.goto(`/reports?period=custom&from=${range.from}&to=${range.to}`);
  } finally {
    await pool.end();
  }

  const drift = page.getByRole('table', {
    name: 'Participação de cada classe de ativo no início e no fim do período',
  });
  await expect(drift).toBeVisible();
  const fii = drift.getByRole('row', { name: /FII/ });
  // Opening, closing, change — each cell on its own, so 50,00 cannot also
  // satisfy the closing column.
  const cells = fii.getByRole('cell');
  await expect(cells.nth(0)).toHaveText(/^50,00\s*%$/);
  await expect(cells.nth(1)).toHaveText(/^0,00\s*%$/);
  await expect(cells.nth(2)).toHaveText(/^[-−]50,00\s*%$/);
});

/**
 * SPEC-022 BR-022-18 / SPEC-016 BR-016-16 — the chart's figures are a table
 * that pages: twelve daily snapshots are more than the first page's ten, the
 * dates read `dd/mm/yyyy`, and the newest one leads.
 */
test('Evolução patrimonial lists the daily history as a paginated table', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedHoldings(userId, [{ code: 'HIST', quantity: '100', averageCost: '10', price: '10' }]);

  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       SELECT $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date - d, 1000 + d, 1000, 0,
              jsonb_build_object('stock', (1000 + d)::text)
         FROM generate_series(1, 12) AS d`,
      [userId],
    );
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 20, 'YYYY-MM-DD') AS from,
              to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS to`,
    );
    const range = rows[0];
    if (range === undefined) throw new Error('no range');
    await page.goto(`/reports?period=custom&from=${range.from}&to=${range.to}`);
  } finally {
    await pool.end();
  }

  // The block is the one thing visible at any width. The history is the last of the
  // two "datas" tables on the page: the composition bands come before it.
  const history = page
    .locator('[data-slot="data-table"]')
    .filter({ has: page.getByText(/^Mostrando 1–10 de \d+ datas$/) })
    .last();
  await expect(history).toBeVisible();
  // `dd/mm/yyyy` (AR-47), never the ISO date the series is keyed by.
  await expect(history.getByText(/^\d{2}\/\d{2}\/\d{4}$/).first()).toBeAttached();
  await expect(history.getByText(/\b\d{4}-\d{2}-\d{2}\b/)).toHaveCount(0);
  await expect(history.getByRole('button', { name: 'Página 2' })).toBeVisible();
});

/**
 * SPEC-022 BR-022-38 — the value chart reads reais. Its axis is abbreviated
 * ("R$ 1 mil"), and its tooltip reads the point's `dd/mm/yyyy` and the exact
 * amount with centavos: the same figure the history table lists for that date,
 * formatted from the decimal rather than from the coordinate the chart plots.
 */
test('the value chart’s tooltip reads the date and the exact amount its table lists', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  await seedHoldings(userId, [{ code: 'TIPS', quantity: '100', averageCost: '10', price: '10' }]);

  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    // Centavos on every day, so a rounded or float-formatted figure cannot match.
    await pool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       SELECT $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date - d, 1000.37 + d, 1000, 0,
              jsonb_build_object('stock', (1000.37 + d)::text)
         FROM generate_series(1, 6) AS d`,
      [userId],
    );
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 6, 'YYYY-MM-DD') AS from,
              to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 'YYYY-MM-DD') AS to`,
    );
    const range = rows[0];
    if (range === undefined) throw new Error('no range');
    await page.goto(`/reports?period=custom&from=${range.from}&to=${range.to}`);
  } finally {
    await pool.end();
  }

  const chart = page.getByRole('img', { name: 'Patrimônio ao longo do tempo' });
  await expect(chart).toBeVisible();
  // The value axis, in abbreviated reais — never the bare coordinate.
  await expect(chart.getByText(/^R\$\s*\d+(,\d)?\s*mil$/).first()).toBeVisible();

  const surface = chart.locator('svg.recharts-surface').first();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (box === null) throw new Error('the chart has no box');
  // `hover` scrolls the chart into view; the point is a recent day, so its
  // date is on the table's first page.
  await surface.hover({ position: { x: box.width * 0.6, y: box.height / 2 } });

  const tooltip = chart.locator('.recharts-tooltip-wrapper');
  const when = tooltip.locator('.recharts-tooltip-label');
  const figure = tooltip.locator('.recharts-tooltip-item-value');
  await expect(when).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
  await expect(figure).toHaveText(/^R\$\s*1\.00\d,37$/);

  const history = page
    .locator('[data-slot="data-table"]')
    .filter({ has: page.getByText(/^Mostrando 1–\d+ de \d+ datas$/) })
    .last();
  // A table row on a wide screen, a card on a narrow one (DS-28).
  const row = history
    .locator('tr, li')
    .filter({ visible: true, hasText: (await when.textContent()) ?? '' });
  await expect(row).toContainText((await figure.textContent()) ?? '');

  // The other two money charts on the page: every series reads a figure.
  const contributions = page.getByRole('img', { name: 'Aportes por mês' });
  await contributions.locator('.recharts-bar-rectangle path').first().hover();
  const barTip = contributions.locator('.recharts-tooltip-wrapper');
  await expect(barTip.locator('.recharts-tooltip-label')).toHaveText(/^[a-zç]+ de \d{4}$/);
  await expect(barTip).toContainText(/R\$\s*[\d.]+,\d{2}/);
  await expect(barTip).not.toContainText('—');

  const stacked = page.getByRole('img', { name: 'Composição ao longo do tempo' });
  await stacked.hover();
  const bandTip = stacked.locator('.recharts-tooltip-wrapper');
  await expect(bandTip.locator('.recharts-tooltip-label')).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/);
  await expect(bandTip).toContainText(/Ações\s*:\s*R\$\s*1\.00\d,37/);
  await expect(bandTip).not.toContainText('—');
});
