import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { attachSession, seedSessionFor } from './support/authenticated';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding, seedPreviewedImportBatch } from './support/onboarding';
import { seedHeldFixedIncomeWithMissingRate } from './support/fixed-income';

/**
 * SPEC-022 BR-022-24..27 — the eye toggle, over the real stack.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS THE HTML RATHER THAN THE SCREEN
 *
 * BR-022-25 is about what the server sends, not about what is painted: an
 * amount hidden by CSS, or replaced after hydration, is still in the document.
 * So each page is fetched with the session's cookie and its **raw HTML** —
 * markup and the RSC payload the charts are hydrated from — is searched for
 * `R$` followed by a digit.
 *
 * And it seeds a tenant that owns something: positions with quotes, a wallet
 * with an allocation, a dividend, two goals, an import batch and a fixed-income
 * holding. An empty tenant renders empty states, and "no amount in the HTML"
 * would pass by there being no amount to hide — so the first assertion is
 * that, unmasked, the amounts are there.
 * ---------------------------------------------------------------------------
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

/**
 * `R$`, any spacing `Intl` or the HTML encoder may produce, a figure, and the
 * first word after it — skipping punctuation, escaped quotes and entities.
 */
const AMOUNT =
  /R\$(?:\s|&nbsp;|&#160;|&#xa0;|\\u00a0)*(\d[\d.,]*\d|\d)(?:&#?\w+;|[^A-Za-zÀ-ÿ&<])*([A-Za-zÀ-ÿ]*)/gi;

/**
 * The catalogue's own prose quotes two figures — "Não mostramos R$ 0,00 antes
 * disso", "abaixo de R$ 30\" pode…" — and every page ships the catalogue to the
 * client. Those are copy, not anybody's money. They are excused **with the word
 * that follows them in the copy**, so a real `R$ 0,00` elsewhere still counts.
 * Read from the catalogue itself, so a new example in the copy does not need
 * this list edited.
 */
const CATALOGUE_PHRASES = new Set(
  [
    ...readFileSync(
      new URL('../../src/i18n/messages/pt-BR.json', import.meta.url),
      'utf8',
    ).matchAll(AMOUNT),
  ].map(([, figure, word]) => `${figure} ${word}`),
);

/** Every figure after `R$` in a page that is not the catalogue's own copy. */
function amountsIn(document: string): string[] {
  return [...document.matchAll(AMOUNT)]
    .filter(([, figure, word]) => !CATALOGUE_PHRASES.has(`${figure} ${word}`))
    .map(([, figure]) => figure ?? '');
}

/** Pages that, unmasked, must show a seeded amount — so masked, the check means something. */
const PAGES_WITH_AMOUNTS = [
  '/dashboard',
  '/wallets',
  '/reports',
  '/reports/performance',
  '/reports/composition',
  '/reports/earnings',
  '/reports/patrimonio',
  '/transactions',
  '/watch',
] as const;

interface Seeded {
  readonly walletId: string;
  readonly transactionId: string;
  readonly batchId: string;
  readonly fixedIncomeId: string;
}

async function seedPortfolio(userId: string): Promise<Seeded> {
  const [code] = await seedHoldings(userId, [
    { code: 'MASKX', quantity: '100', averageCost: '30', price: '40' },
  ]);
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
      code,
    ]);
    const assetId = rows[0]?.id;
    if (assetId === undefined) throw new Error(`no asset seeded for ${code}`);

    const walletId = randomUUID();
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, 'Oculta')`, [
      walletId,
      userId,
    ]);
    await pool.query(
      `INSERT INTO wallet_allocation_events
         (id, user_id, wallet_id, asset_id, quantity, effective_on, cause, cost_basis_after)
       VALUES ($1, $2, $3, $4, 100, CURRENT_DATE - 30, 'assignment', 3000)`,
      [randomUUID(), userId, walletId, assetId],
    );

    const transactionId = randomUUID();
    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, type, status, trade_date, quantity, unit_price, fees,
          total_value, natural_key, occurrence, is_manual, is_user_modified)
       VALUES ($1, $2, $3, 'dividend', 'active', CURRENT_DATE - 10, 100, 0, 0, 150, $4, 1, true, false)`,
      [transactionId, userId, assetId, `e2e-${randomUUID()}`],
    );

    for (const goal of [
      { kind: 'growth', amount: 9000, basis: 'invested', period: null },
      { kind: 'earnings', amount: 1200, basis: null, period: 'yearly' },
    ]) {
      await pool.query(
        `INSERT INTO wallet_goals (id, user_id, wallet_id, name, kind, amount, basis, period)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          userId,
          walletId,
          `Meta ${goal.kind}`,
          goal.kind,
          goal.amount,
          goal.basis,
          goal.period,
        ],
      );
    }

    // SPEC-013 — two daily snapshots, so Patrimônio draws its value line and
    // the masking of a real chart's coordinates is exercised end to end.
    for (const [offset, total] of [
      [2, 4000],
      [1, 4100],
    ] as const) {
      await pool.query(
        `INSERT INTO daily_valuation_snapshots
           (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
         VALUES ($1, CURRENT_DATE - $2::int, $3, 3000, 150, $4)`,
        [userId, offset, total, JSON.stringify({ stock: String(total) })],
      );
    }

    // SPEC-018 — a rule with a threshold, so the watch row's bound and the
    // edit form's input both carry an amount.
    await pool.query(
      `INSERT INTO opportunity_rules (id, user_id, asset_id, lower_bound, lower_state, default_state)
       VALUES ($1, $2, $3, 35, 'buy', 'hold')`,
      [randomUUID(), userId, assetId],
    );

    const batchId = await seedPreviewedImportBatch(userId);
    // Past the first run, so Painel shows the portfolio rather than the guide.
    await dismissOnboarding(userId);
    const fixedIncome = await seedHeldFixedIncomeWithMissingRate(userId, 'CDBMASK');

    return { walletId, transactionId, batchId, fixedIncomeId: fixedIncome.assetId };
  } finally {
    await pool.end();
  }
}

/** The composition ring's coordinate for the seeded position, in the RSC payload. */
const RING_COORDINATE = /value\\?":4000\b/;

/** Patrimônio's value line, at the seeded snapshot of 4100. */
const LINE_COORDINATE = /value\\?":4100\b/;

/** The edit forms' inputs, carrying the seeded stored amounts. */
const GOAL_INPUT =
  /<input[^>]*name="amount"[^>]*value="9000"|<input[^>]*value="9000"[^>]*name="amount"/;
const RULE_INPUT =
  /<input[^>]*name="lowerPrice"[^>]*value="35"|<input[^>]*value="35"[^>]*name="lowerPrice"/;
const PRICE_INPUT = /<input[^>]*name="(unitPrice|fees)"/;

/** Every signed-in page, with the seeded ids filled in. */
function pages(seeded: Seeded): readonly string[] {
  return [
    '/dashboard',
    '/onboarding',
    '/wallets',
    `/wallets/${seeded.walletId}`,
    `/wallets/${seeded.walletId}/balance`,
    `/wallets/${seeded.walletId}/goals`,
    '/reports',
    '/reports/patrimonio',
    '/reports/performance',
    '/reports/earnings',
    '/reports/composition',
    '/transactions',
    '/transactions/new',
    '/transactions/conversions/new',
    `/transactions/${seeded.transactionId}/delete`,
    `/transactions/${seeded.transactionId}/edit`,
    '/import',
    `/import/${seeded.batchId}`,
    `/fixed-income/${seeded.fixedIncomeId}`,
    '/watch',
    '/account',
    '/preferences',
    '/privacy',
  ];
}

async function html(page: Page, path: string): Promise<string> {
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(200);
  return response.text();
}

async function turnMaskingOn(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const toggle = page.getByRole('button', { name: 'Ocultar valores' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  // The server applies it: the page comes back re-rendered, already masked.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

test('with masking on, no page sends an amount, and the choice follows the account to a new session', async ({
  signedIn,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { page, userId } = signedIn;
  const seeded = await seedPortfolio(userId);

  // Not vacuous: unmasked, the seeded amounts are in the HTML — on the pages
  // that list them, in the edit forms' inputs, and in the ring's coordinates.
  const shown: string[] = [];
  for (const path of pages(seeded)) {
    if (amountsIn(await html(page, path)).length > 0) shown.push(path);
  }
  expect(shown).toEqual(expect.arrayContaining([...PAGES_WITH_AMOUNTS]));
  const unmasked = await html(page, '/reports/composition');
  expect(amountsIn(unmasked)).toContain('4.000,00');
  expect(unmasked).toMatch(RING_COORDINATE);
  expect(await html(page, '/reports/patrimonio')).toMatch(LINE_COORDINATE);
  const goals = await html(page, `/wallets/${seeded.walletId}/goals`);
  expect(amountsIn(goals)).toContain('9.000,00');
  expect(goals).toMatch(GOAL_INPUT);
  expect(await html(page, '/watch')).toMatch(RULE_INPUT);
  expect(await html(page, `/transactions/${seeded.transactionId}/edit`)).toMatch(PRICE_INPUT);

  await turnMaskingOn(page);

  // BR-022-24/25 — every page, as the server sends it.
  // The ring's coordinates rode to the browser rescaled, not as the 4000 they
  // were: the RSC payload is HTML too.
  expect(await html(page, '/reports/composition')).not.toMatch(RING_COORDINATE);
  expect(await html(page, '/reports/patrimonio')).not.toMatch(LINE_COORDINATE);
  // Edit forms round-trip stored amounts through their inputs, so they are
  // replaced by "show values to edit" rather than rendered (BR-022-24).
  const maskedGoals = await html(page, `/wallets/${seeded.walletId}/goals`);
  expect(maskedGoals).not.toMatch(GOAL_INPUT);
  expect(maskedGoals).toContain('Mostrar valores');
  expect(await html(page, '/watch')).not.toMatch(RULE_INPUT);
  const maskedEdit = await html(page, `/transactions/${seeded.transactionId}/edit`);
  expect(maskedEdit).not.toMatch(PRICE_INPUT);
  expect(maskedEdit).toContain('Mostrar valores');

  const leaking: Record<string, string[]> = {};
  for (const path of pages(seeded)) {
    const found = amountsIn(await html(page, path));
    if (found.length > 0) leaking[path] = found;
  }
  expect(leaking).toEqual({});

  // BR-022-26 — what is painted instead, and what a screen reader hears.
  await page.goto('/reports/composition');
  await expect(page.getByText('Valor oculto').first()).toBeAttached();
  await expect(page.getByText('R$ ••••••').filter({ visible: true }).first()).toBeVisible();
  // DL-022-07 — quantities and percentages stay.
  await expect(
    page
      .getByText(/^\d{1,3},\d{2}%$/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  // BR-022-25 — "the state follows the user to another device": a new
  // context, a new session row, the same account.
  const elsewhere = await browser.newContext();
  try {
    await attachSession(
      elsewhere,
      await seedSessionFor(userId),
      baseURL ?? 'http://localhost:3000',
    );
    const other = await elsewhere.newPage();
    await other.goto('/dashboard');
    await expect(other.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(amountsIn(await html(other, '/reports/composition'))).toEqual([]);
  } finally {
    await elsewhere.close();
  }

  // And back: the toggle is a toggle.
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Ocultar valores' }).click();
  await expect(page.getByRole('button', { name: 'Ocultar valores' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(amountsIn(await html(page, '/reports/composition'))).toContain('4.000,00');
});

/**
 * BR-022-27 — exports are explicit requests for the data. Taken with masking
 * on, each one carries the real figures.
 */
test('with masking on, every export still carries the real figures', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedPortfolio(userId);
  await turnMaskingOn(page);

  // SPEC-011 BR-011-12 — the grouped report: 100 × R$ 40 = 4000.
  const report = await html(page, '/api/reports/export?grouping=asset_class');
  expect(report).toMatch(/\b4000\b/);
  expect(report).not.toContain('•');

  // SPEC-006 — the ledger export: the seeded dividend of 150.
  const ledger = await html(page, '/api/transactions/export');
  expect(ledger).toMatch(/\b150\b/);
  expect(ledger).not.toContain('•');

  // SPEC-004 — the data-rights export: the same dividend, and the goals' amounts.
  const rights = await html(page, '/api/privacy/export/csv');
  expect(rights).toMatch(/\b150\b/);
  expect(rights).toMatch(/\b9000\b/);
  expect(rights).not.toContain('•');
});
