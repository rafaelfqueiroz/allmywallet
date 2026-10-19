import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-014 — the Earnings report, over the real stack.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CENTRAL JOURNEY IS A REALLOCATION
 *
 * BR-014-12 is the rule this report lives or dies by: **reallocating a holding
 * today must not change last year's income.** Every part of it is invisible to
 * a unit test of the calculation, because the thing that has to hold is the
 * chain — the allocation write appends an event dated by the trade, the report
 * folds those events per pay date, and the page reads the fold. Any link can
 * break while the other two pass their own tests.
 *
 * So this seeds a holding, files it into one wallet, pays a provento, moves it
 * to another wallet, and asserts the first wallet still shows the income. That
 * is the sequence a user performs, and it is the one that would silently
 * rewrite history if the report ever fell back to current allocations.
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
 * A provento in the ledger, dated by its pay date (BR-014-08 — the date B3's
 * Movimentação extract records, and the one that matches a bank statement).
 */
async function seedEarning(
  userId: string,
  assetCode: string,
  options: { readonly amount: string; readonly payDate: string; readonly type?: string },
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
       VALUES ($1, $2, $3, $4, 'active', $5, 100, 0, 0, $6, $7, 1, true, false)`,
      [
        randomUUID(),
        userId,
        assetId,
        options.type ?? 'dividend',
        options.payDate,
        options.amount,
        `e2e-${randomUUID()}`,
      ],
    );
  } finally {
    await pool.end();
  }
}

/** What the allocation write path records — here, directly, at a past date. */
async function seedAllocation(
  userId: string,
  walletId: string,
  assetCode: string,
  options: { readonly quantity: string; readonly effectiveOn: string },
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
         (id, user_id, wallet_id, asset_id, quantity, effective_on, cause)
       VALUES ($1, $2, $3, $4, $5, $6, 'assignment')`,
      [randomUUID(), userId, walletId, assetId, options.quantity, options.effectiveOn],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Dates relative to today, and every journey asks for `period=12m`.
 *
 * A fixed month would drift in and out of the default YTD window depending on
 * when the suite runs — green in September, silently empty in January, which
 * is the worst kind of flake because it looks like a real regression on a
 * branch that changed nothing.
 */
function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const EARLY = daysAgo(200);
const MOVED = daysAgo(100);
const LATE = daysAgo(50);
const TWELVE_MONTHS = 'period=12m';

test('reports proventos by type, and reaches the report from the shared nav', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'PETRE', quantity: '100', averageCost: '10', price: '40' },
  ]);
  await seedEarning(userId, String(code), { amount: '120', payDate: EARLY });
  await seedEarning(userId, String(code), { amount: '80', payDate: EARLY, type: 'jcp' });

  await page.goto(`/reports?${TWELVE_MONTHS}`);
  await page.getByRole('link', { name: 'Proventos' }).click();
  // SPEC-022 BR-022-03 / BR-011-11 (#209) — the tab carries the period.
  await expect(page).toHaveURL(/\/reports\/earnings\?period=12m$/);

  await expect(page.locator('#__next_error__')).toHaveCount(0);

  // BR-014-01: the period's total, through the whole stack.
  await expect(page.getByText(/R\$\s*200,00/).first()).toBeVisible();
  // BR-014-02: JCP reported apart from dividends, not folded into one figure.
  await expect(page.getByText(/R\$\s*120,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*80,00/).first()).toBeVisible();

  // BR-014-05: 200 received on a position that cost 1.000 → 20 % on cost.
  await expect(page.getByText('20,00%').first()).toBeVisible();
});

/**
 * BR-014-09/10 / DL-014-06 — the section says why it is empty. An empty
 * section would read as "you have no upcoming income", which is a claim this
 * product has no source for.
 */
test('states that announced proventos are unavailable rather than showing none', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'PETRF', quantity: '100', averageCost: '10', price: '40' },
  ]);
  await seedEarning(userId, String(code), { amount: '50', payDate: EARLY });

  await page.goto(`/reports/earnings?${TWELVE_MONTHS}`);

  await expect(page.getByRole('heading', { name: 'Proventos anunciados' })).toBeVisible();
  await expect(page.getByText(/não sabemos/i)).toBeVisible();
});

test('reallocating a holding today does not change what a wallet earned before', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'PETRG', quantity: '100', averageCost: '10', price: '40' },
  ]);
  const reserva = await seedWallet(userId, 'Reserva');
  const aposentadoria = await seedWallet(userId, 'Aposentadoria');

  // Held by Reserva when the first provento was paid...
  await seedAllocation(userId, reserva, String(code), {
    quantity: '100',
    effectiveOn: daysAgo(300),
  });
  await seedEarning(userId, String(code), { amount: '120', payDate: EARLY });

  // ...and moved to Aposentadoria afterwards, which is what a user does.
  await seedAllocation(userId, reserva, String(code), { quantity: '0', effectiveOn: MOVED });
  await seedAllocation(userId, aposentadoria, String(code), {
    quantity: '100',
    effectiveOn: MOVED,
  });
  await seedEarning(userId, String(code), { amount: '90', payDate: LATE });

  // Reserva keeps the earlier 120 even though it holds nothing today.
  await page.goto(`/reports/earnings?wallet=${reserva}&${TWELVE_MONTHS}`);
  await expect(page.getByText(/R\$\s*120,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*90,00/)).toHaveCount(0);

  // Aposentadoria has the later 90 and none of the earlier 120.
  await page.goto(`/reports/earnings?wallet=${aposentadoria}&${TWELVE_MONTHS}`);
  await expect(page.getByText(/R\$\s*90,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*120,00/)).toHaveCount(0);
});

/**
 * BR-014-11 / DL-006-06 — an `unclassified` row is stored and inert. It must
 * not reach an income total, and classifying it is what makes it count.
 */
test('excludes an unclassified provento from the total', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'PETRH', quantity: '100', averageCost: '10', price: '40' },
  ]);
  await seedEarning(userId, String(code), { amount: '70', payDate: EARLY });

  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
      String(code),
    ]);
    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, type, status, trade_date, quantity, unit_price, fees,
          total_value, natural_key, occurrence, is_manual, is_user_modified)
       VALUES ($1, $2, $3, 'dividend', 'unclassified', $4, 100, 0, 0, 999, $5, 1, false, false)`,
      [randomUUID(), userId, rows[0]?.id, EARLY, `e2e-${randomUUID()}`],
    );
  } finally {
    await pool.end();
  }

  await page.goto(`/reports/earnings?${TWELVE_MONTHS}`);

  await expect(page.getByText(/R\$\s*70,00/).first()).toBeVisible();
  await expect(page.getByText(/R\$\s*999,00/)).toHaveCount(0);
});

/**
 * SPEC-016 BR-016-16 / SPEC-022 BR-022-18 — the monthly chart's figures are a
 * table on the page, not a description only a screen reader reads, and it is
 * one of the tables that grow, so it says how many months it holds.
 */
test('shows the monthly proventos as a table beside the chart', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'PETRM', quantity: '100', averageCost: '10', price: '40' },
  ]);
  await seedEarning(userId, String(code), { amount: '120', payDate: EARLY });

  await page.goto(`/reports/earnings?${TWELVE_MONTHS}`);

  const monthly = page
    .locator('[data-slot="data-table"]')
    .filter({ has: page.getByText(/^Mostrando 1–\d+ de \d+ meses$/) })
    .first();
  await expect(monthly).toBeVisible();
  await expect(monthly).toContainText(/R\$\s*120,00/);
});

/**
 * SPEC-022 BR-022-38 — the monthly chart reads reais: its tooltip names the
 * month as a reader says it and the exact amount with centavos, the figure the
 * table lists for that month.
 */
test('the monthly chart’s axis reads months and its tooltip the exact amount', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [code] = await seedHoldings(userId, [
    { code: 'TIPM', quantity: '100', averageCost: '10', price: '40' },
  ]);
  await seedEarning(userId, String(code), { amount: '120.37', payDate: EARLY });

  await page.goto(`/reports/earnings?${TWELVE_MONTHS}`);

  const chart = page.getByRole('img', { name: 'Proventos mês a mês' });
  await expect(chart).toBeVisible();
  // SPEC-022 BR-022-42 — the month axis reads "set", never the `2026-09` key.
  const ticks = chart.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value');
  await expect(ticks.first()).toHaveText(/^[a-zç]{3}$/);
  for (const label of await ticks.allTextContents()) expect(label).toMatch(/^[a-zç]{3}$/);
  await expect(chart).not.toContainText(/\d{4}-\d{2}/);

  const bar = chart.locator('.recharts-bar-rectangle path').first();
  await bar.hover();

  const tooltip = chart.locator('.recharts-tooltip-wrapper');
  await expect(tooltip.locator('.recharts-tooltip-label')).toHaveText(/^[a-zç]+ de \d{4}$/);
  await expect(tooltip).toContainText(/Recebido no mês\s*:\s*R\$\s*120,37/);

  const monthly = page
    .locator('[data-slot="data-table"]')
    .filter({ has: page.getByText(/^Mostrando 1–\d+ de \d+ meses$/) })
    .first();
  await expect(monthly).toContainText(/R\$\s*120,37/);
});
