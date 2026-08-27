import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-019 — Objetivos, over the real stack.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SEEDS TWO CALENDAR YEARS
 *
 * AC-7 is "switching the year redraws the earnings chart and leaves the
 * growth chart unchanged" and AC-8 is "no month outside the selected year
 * appears anywhere on the page". Neither is observable with a single year of
 * data — a page with only one year to show cannot demonstrate that switching
 * years changes one figure and not the other, and a page with only one
 * year's income cannot demonstrate that a *different* year's months stay off
 * the page. So the wallet here is given a fixed, unambiguous past allocation
 * (2020) alongside a present one, with income recorded in both years.
 * ---------------------------------------------------------------------------
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

async function seedWallet(userId: string, name: string): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [randomUUID(), userId, name],
    );
    return rows[0]?.id ?? '';
  } finally {
    await pool.end();
  }
}

/**
 * BR-019-11 — the growth burn-up needs `cost_basis_after` on the allocation
 * event, which `earnings.spec.ts`'s own `seedAllocation` never sets (that
 * journey has no use for it). Without it every point on the invested line is
 * `GrowthUnavailable.COST_BASIS_NOT_RECORDED`, which would leave this test
 * unable to see a real figure to assert on.
 */
async function seedAllocation(
  userId: string,
  walletId: string,
  assetCode: string,
  options: {
    readonly quantity: string;
    readonly effectiveOn: string;
    readonly costBasisAfter: string;
  },
): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
      assetCode,
    ]);
    const assetId = rows[0]?.id;
    if (assetId === undefined) throw new Error(`no asset seeded for ${assetCode}`);

    await pool.query(
      `INSERT INTO wallet_allocation_events
         (id, user_id, wallet_id, asset_id, quantity, effective_on, cause, cost_basis_after)
       VALUES ($1, $2, $3, $4, $5, $6, 'assignment', $7)`,
      [
        randomUUID(),
        userId,
        walletId,
        assetId,
        options.quantity,
        options.effectiveOn,
        options.costBasisAfter,
      ],
    );
  } finally {
    await pool.end();
  }
}

async function seedEarning(
  userId: string,
  assetCode: string,
  options: { readonly amount: string; readonly payDate: string },
): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
      assetCode,
    ]);
    const assetId = rows[0]?.id;
    if (assetId === undefined) throw new Error(`no asset seeded for ${assetCode}`);

    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, type, status, trade_date, quantity, unit_price, fees,
          total_value, natural_key, occurrence, is_manual, is_user_modified)
       VALUES ($1, $2, $3, 'dividend', 'active', $4, 100, 0, 0, $5, $6, 1, true, false)`,
      [randomUUID(), userId, assetId, options.payDate, options.amount, `e2e-${randomUUID()}`],
    );
  } finally {
    await pool.end();
  }
}

async function seedGoal(
  userId: string,
  walletId: string,
  options:
    | {
        readonly kind: 'growth';
        readonly name: string;
        readonly amount: string;
        readonly basis: string;
      }
    | {
        readonly kind: 'earnings';
        readonly name: string;
        readonly amount: string;
        readonly period: string;
      },
): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO wallet_goals (id, user_id, wallet_id, name, kind, amount, basis, period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        userId,
        walletId,
        options.name,
        options.kind,
        options.amount,
        options.kind === 'growth' ? options.basis : null,
        options.kind === 'earnings' ? options.period : null,
      ],
    );
  } finally {
    await pool.end();
  }
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Unambiguously a past calendar year, whenever this suite happens to run. */
const OLD_YEAR = '2020';
const OLD_ALLOCATION_DATE = `${OLD_YEAR}-01-10`;
const OLD_EARNING_DATE = `${OLD_YEAR}-03-15`;
const RECENT_EARNING_DATE = daysAgo(10);
const CURRENT_YEAR = String(new Date().getUTCFullYear());

test('a wallet shows its growth and earnings goals on separate charts (AC-1), reachable as text (AC-18)', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'OBJEA', quantity: '100', averageCost: '10', price: '40' },
  ]);
  const walletId = await seedWallet(userId, 'Independência');

  // Held since 2020, at a recorded cost of R$ 1.000,00 — the invested-basis
  // growth goal's "Hoje" figure.
  await seedAllocation(userId, walletId, String(code), {
    quantity: '100',
    effectiveOn: OLD_ALLOCATION_DATE,
    costBasisAfter: '1000.00',
  });
  await seedEarning(userId, String(code), { amount: '100', payDate: OLD_EARNING_DATE });
  await seedEarning(userId, String(code), { amount: '200', payDate: RECENT_EARNING_DATE });

  await seedGoal(userId, walletId, {
    kind: 'growth',
    name: 'Construir patrimônio',
    amount: '5000.00',
    basis: 'invested',
  });
  await seedGoal(userId, walletId, {
    kind: 'earnings',
    name: 'Renda mensal',
    amount: '150.00',
    period: 'monthly',
  });

  await page.goto(`/wallets/${walletId}/goals`);
  await expect(page.locator('#__next_error__')).toHaveCount(0);

  // AC-1: both goal names appear as their own titled section, each with a
  // chart of its own (`role="img"`, from `ChartContainer`).
  await expect(page.getByRole('heading', { name: 'Construir patrimônio' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Renda mensal' })).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(2);

  // BR-019-11 — the invested figure, reconciled from the seeded cost basis.
  await expect(page.getByText(/R\$\s*1\.000,00/).first()).toBeVisible();

  // AC-18 — the growth chart's own figures are also a visible table, not only
  // pixels in the SVG.
  await expect(page.getByRole('table', { name: 'Valores do gráfico de evolução' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Valores do gráfico de proventos' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('switching the year redraws the earnings chart and leaves the growth chart unchanged (AC-7), never mixing years (AC-8)', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'OBJEB', quantity: '100', averageCost: '10', price: '40' },
  ]);
  const walletId = await seedWallet(userId, 'Renda passiva');

  await seedAllocation(userId, walletId, String(code), {
    quantity: '100',
    effectiveOn: OLD_ALLOCATION_DATE,
    costBasisAfter: '2000.00',
  });
  // 2020 pays 100; this year pays 200 — two distinct, distinguishable totals.
  await seedEarning(userId, String(code), { amount: '100', payDate: OLD_EARNING_DATE });
  await seedEarning(userId, String(code), { amount: '200', payDate: RECENT_EARNING_DATE });

  await seedGoal(userId, walletId, {
    kind: 'growth',
    name: 'Aposentadoria',
    amount: '9000.00',
    basis: 'invested',
  });
  await seedGoal(userId, walletId, {
    kind: 'earnings',
    name: 'Proventos anuais',
    amount: '5000.00',
    period: 'yearly',
  });

  // Default view: the current year. Its total (200) is on the page, 2020's
  // (100) is not, and the growth figure (2.000,00) is present either way.
  await page.goto(`/wallets/${walletId}/goals`);
  await expect(page.getByText(/R\$\s*2\.000,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*200,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*100,00/)).toHaveCount(0);

  // AC-8: every month cell on the current year's table starts with this
  // year's own prefix — none of 2020's months leaked onto the page.
  const monthCellsNow = await page
    .getByRole('table', { name: 'Valores do gráfico de proventos' })
    .locator('th[scope="row"]')
    .allTextContents();
  expect(monthCellsNow.length).toBeGreaterThan(0);
  for (const month of monthCellsNow) expect(month.startsWith(`${CURRENT_YEAR}-`)).toBe(true);

  // Switch to 2020 via the year selector.
  await page.goto(`/wallets/${walletId}/goals?year=${OLD_YEAR}`);

  // AC-7 — the earnings figure redrew: 2020's total (100) is now on the page
  // and this year's (200) is gone.
  await expect(page.getByText(/R\$\s*100,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*200,00/)).toHaveCount(0);

  // AC-7 — the growth chart did not move: the same invested figure as before.
  await expect(page.getByText(/R\$\s*2\.000,00/).first()).toBeVisible();

  // AC-8, on the other year: every month cell now starts with 2020's own
  // prefix, and none of this year's leaked in either direction.
  const monthCells2020 = await page
    .getByRole('table', { name: 'Valores do gráfico de proventos' })
    .locator('th[scope="row"]')
    .allTextContents();
  expect(monthCells2020.length).toBeGreaterThan(0);
  for (const month of monthCells2020) expect(month.startsWith(`${OLD_YEAR}-`)).toBe(true);
});
