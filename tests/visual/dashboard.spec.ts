import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Page } from '@playwright/test';
import { dropSeededUser, expect, test as signedInTest } from '../e2e/support/authenticated';

/**
 * #257 — the populated Dashboard, in pixels (SPEC-022 BR-022-07, BR-022-36;
 * the 12/10/2026 adjustment frames, DL-022-24).
 *
 * `tests/e2e/dashboard.spec.ts` proves what the cards say and where they link;
 * this proves how they look — the panel footers, the narrow column, the watch
 * table's widths — so a later change cannot move the screen off its approved
 * frame without a diff. Desktop runs at the project's 1280px, the tightest
 * width `Split side="aside"`'s 27rem column is sized for, so a column change
 * shows there first.
 *
 * **One deterministic tenant that reaches every block:** three holdings, each
 * with a watch rule (buy, sell, hold — the hold one is the rule the card must
 * *not* list), a committed Posição batch with one open divergence, unclassified
 * import rows, a fixed-income contract with no rate, and one pending
 * allocation. Asset ids and codes are fixed, not `seedHoldings`' random
 * suffixes, so the codes in the picture are the same every run; the visual
 * projects run one at a time (`workers: 1`), so a fixed code never meets
 * itself, and the fixture removes the shared rows it wrote.
 *
 * **The only run-dependent text is pinned, not masked.** The header's
 * freshness line prints today's valuation date and the quote's time. A mask
 * would hide them but not hold the line's width, and on a phone the wrap — and
 * every card below it — would move with the digits. So the dates and times in
 * that one line are rewritten to fixed values before the screenshot; the
 * copy around them stays real. No figure is touched.
 *
 * Nothing here enqueues a pg-boss job: every row is written directly, and the
 * page reads stored quotes only (BR-018-11).
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

interface Holding {
  readonly id: string;
  readonly code: string;
  readonly quantity: string;
  readonly averageCost: string;
  readonly price: string;
}

/*
 * Hand-computed: value 100 × 25 + 40 × 50 + 60 × 20 = R$ 5.700,00; cost
 * 100 × 22 + 40 × 38 + 60 × 21 = R$ 4.980,00 — plus the CDB at cost (BR-009-13),
 * R$ 1.000,00 on both sides.
 */
const BUY: Holding = {
  id: '25700000-0000-4000-8000-000000000001',
  code: 'VBUY3',
  quantity: '100',
  averageCost: '22.00',
  price: '25.00',
};
const SELL: Holding = {
  id: '25700000-0000-4000-8000-000000000002',
  code: 'VSEL3',
  quantity: '40',
  averageCost: '38.00',
  price: '50.00',
};
const HOLD: Holding = {
  id: '25700000-0000-4000-8000-000000000003',
  code: 'VHLD3',
  quantity: '60',
  averageCost: '21.00',
  price: '20.00',
};
const CDB = { id: '25700000-0000-4000-8000-000000000004', code: 'CDBVIS26' } as const;
const ASSET_IDS = [BUY.id, SELL.id, HOLD.id, CDB.id];

/** A fixed Posição date, so the B3 card's "Posição de …" is the same every run. */
const POSICAO_AS_OF = '2026-10-16';

/*
 * AR-29 — the valuation compares a quote's **São Paulo** date with São Paulo's
 * today (`core/valuation/listed.ts`). `now() - 30 min` between 00:00 and 00:29
 * there is yesterday, which carries the price forward and adds "Preço mais
 * antigo" to the Patrimônio card; `CURRENT_DATE` is the database's own zone,
 * UTC in CI, which is tomorrow from 21:00. So the quote is clamped to São
 * Paulo's midnight and the close is dated by São Paulo's calendar.
 */
const SAO_PAULO_TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
const QUOTED_AT = `GREATEST(now() - interval '30 minutes',
  date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;

async function seedDashboard(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    for (const holding of [BUY, SELL, HOLD]) {
      // Shared reference data (AR-15); a run that died before its teardown
      // leaves the row behind, so the insert tolerates it.
      await pool.query(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'stock')
         ON CONFLICT (id) DO NOTHING`,
        [holding.id, holding.code, `Ativo ${holding.code}`],
      );
      const totalCost = String(Number(holding.quantity) * Number(holding.averageCost));
      await pool.query(
        `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [randomUUID(), userId, holding.id, holding.quantity, holding.averageCost, totalCost],
      );
      // BR-008-04's two timestamps, fresh, so no "Preço mais antigo" marker
      // and every rule evaluates against a known price.
      await pool.query(
        `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
         VALUES ($1, $2, ${QUOTED_AT}, now(), 'visual-seed')
         ON CONFLICT (asset_id) DO UPDATE
           SET price = EXCLUDED.price, quoted_at = EXCLUDED.quoted_at,
               fetched_at = EXCLUDED.fetched_at, source = EXCLUDED.source`,
        [holding.id, holding.price],
      );
      await pool.query(
        `INSERT INTO price_quotes (asset_id, date, close, source)
         VALUES ($1, ${SAO_PAULO_TODAY}, $2, 'visual-seed')
         ON CONFLICT (asset_id, date) DO UPDATE SET close = EXCLUDED.close`,
        [holding.id, holding.price],
      );
    }

    // SPEC-018 — one rule per state. 25 ≤ 30 is a buy; 50 ≥ 45 a sell; 20
    // between 10 and 30 is the default hold, which the card leaves out.
    await pool.query(
      `INSERT INTO opportunity_rules (id, user_id, asset_id, lower_bound, lower_state, upper_bound, upper_state, default_state)
       VALUES ($1, $2, $3, '30', 'buy', NULL, NULL, 'hold'),
              ($4, $2, $5, NULL, NULL, '45', 'sell', 'hold'),
              ($6, $2, $7, '10', 'buy', '30', 'sell', 'hold')`,
      [randomUUID(), userId, BUY.id, randomUUID(), SELL.id, randomUUID(), HOLD.id],
    );

    // SPEC-010 — the three stocks sit in a wallet; the CDB in none is the one
    // pending allocation (`no_wallet`).
    const walletId = randomUUID();
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, 'Longo prazo')`, [
      walletId,
      userId,
    ]);
    for (const holding of [BUY, SELL, HOLD]) {
      await pool.query(
        `INSERT INTO wallet_allocations (id, user_id, wallet_id, asset_id, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, walletId, holding.id, holding.quantity],
      );
    }

    // SPEC-020 BR-020-16/19 — held, with neither indexer nor rate, so valued
    // at cost and gated. The issue date is fixed: the value is cost either way.
    await pool.query(
      `INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'cdb')
       ON CONFLICT (id) DO NOTHING`,
      [CDB.id, CDB.code, `CDB ${CDB.code}`],
    );
    await pool.query(
      `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
       VALUES ($1, $2, $3, '1000', '1', '1000', 0)`,
      [randomUUID(), userId, CDB.id],
    );
    await pool.query(
      `INSERT INTO fixed_income_contracts (id, user_id, asset_id, issue_date)
       VALUES ($1, $2, $3, '2026-01-02')`,
      [randomUUID(), userId, CDB.id],
    );

    // SPEC-005 BR-005-26 — a committed Posição batch with one open divergence.
    // Its commit is also the last import, so the staleness note stays away.
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at, reconciliation)
       VALUES ($1, $2, 'b3_posicao', 'committed', now(), now(), $3::jsonb)`,
      [
        randomUUID(),
        userId,
        JSON.stringify({
          asOf: POSICAO_AS_OF,
          status: 'discrepancies_found',
          discrepancies: [
            {
              assetId: SELL.id,
              assetCode: SELL.code,
              institutionId: null,
              computedQuantity: SELL.quantity,
              b3Quantity: '42',
              difference: '2',
              cause: 'undetermined',
              resolved: false,
            },
          ],
        }),
      ],
    );

    // #233 — the month-end close and a provento in each month, so both period
    // changes render. Dated by São Paulo's calendar, as the closes above are.
    // Hand-computed: R$ 6.700,00 against R$ 6.560,00 → +R$ 140,00, +2,13 %;
    // 100 × 0,90 = R$ 90,00 against 100 × 1,00 = R$ 100,00 → −R$ 10,00, −10,00 %.
    const monthEnd = `(date_trunc('month', ${SAO_PAULO_TODAY}) - interval '1 day')::date`;
    await pool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       VALUES ($1, ${monthEnd}, '6560', '6000', '100', '{}'::jsonb)`,
      [userId],
    );
    for (const [payDate, unitPrice] of [
      [SAO_PAULO_TODAY, '0.90'],
      [monthEnd, '1.00'],
    ] as const) {
      await pool.query(
        `INSERT INTO transactions (id, user_id, asset_id, institution_id, type, status,
           trade_date, quantity, unit_price, fees, total_value, ratio, natural_key,
           occurrence, import_batch_id, is_manual, is_user_modified)
         VALUES ($1, $2, $3, NULL, 'dividend', 'active', ${payDate}, 100, $4, 0,
                 100 * $4::numeric, NULL, $5, 1, NULL, true, false)`,
        [randomUUID(), userId, BUY.id, unitPrice, `visual|${unitPrice}`],
      );
    }

    // SPEC-020 BR-020-16/18 — two rows left needing a decision.
    const rowsBatchId = randomUUID();
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at)
       VALUES ($1, $2, 'b3_movimentacao', 'committed', now(), now())`,
      [rowsBatchId, userId],
    );
    for (let index = 0; index < 2; index += 1) {
      await pool.query(
        `INSERT INTO import_rows (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id)
         VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 'unclassified', $4)`,
        [randomUUID(), userId, rowsBatchId, HOLD.id],
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * The shared rows `seedDashboard` wrote. `assets` outlives a tenant (no
 * cascade), so dropping the user alone would leave these codes behind for the
 * next project's run and every later suite.
 */
async function dropSeededAssets(): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(`DELETE FROM latest_quotes WHERE asset_id = ANY($1::uuid[])`, [ASSET_IDS]);
    await pool.query(`DELETE FROM price_quotes WHERE asset_id = ANY($1::uuid[])`, [ASSET_IDS]);
    await pool.query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [ASSET_IDS]);
  } finally {
    await pool.end();
  }
}

/**
 * The seeded tenant, torn down here rather than in `afterEach`: Playwright
 * runs hooks before fixture teardown, so the assets would still be referenced
 * by the tenant's positions. The user is dropped first (the `signedIn`
 * fixture's own drop then finds nothing), then the assets.
 */
const test = signedInTest.extend<{ dashboard: { page: Page } }>({
  dashboard: async ({ signedIn }, use) => {
    try {
      await seedDashboard(signedIn.userId);
      await use({ page: signedIn.page });
    } finally {
      await dropSeededUser(signedIn.userId);
      await dropSeededAssets();
    }
  },
});

test('the populated Dashboard is unchanged', async ({ dashboard }) => {
  const { page } = dashboard;

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dashboard');

  // Every block present before the picture, so a seed that stopped reaching
  // one fails here by name rather than as an unexplained diff.
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('R$ 6.700,00')).toBeVisible();
  await expect(page.getByText('3 itens')).toBeVisible();
  await expect(page.getByText('1 divergência em aberto')).toBeVisible();
  await expect(page.getByRole('link', { name: /^VBUY3/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^VSEL3/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^VHLD3/ })).toHaveCount(0);

  await expect(page.getByText('(+R$ 140,00)')).toBeVisible();
  await expect(page.getByText('R$ 90,00', { exact: true })).toBeVisible();

  // The freshness line — see the header on why it is pinned, not masked.
  await page.locator('[data-slot="page-header"] p').evaluate((line) => {
    line.textContent = (line.textContent ?? '')
      .replace(/\d{2}\/\d{2}\/\d{4}/g, '19/10/2026')
      .replace(/\d{2}:\d{2}/g, '14:30');
  });
  // #233 — the month names and the month-end date, pinned the same way: the
  // frame's own October, so the cards do not reflow from month to month.
  await page
    .locator('[data-slot="stat-card"] dt span, [data-slot="stat-card"] dt')
    .evaluateAll((labels) => {
      for (const label of labels) {
        if (label.children.length > 0) continue;
        label.textContent = (label.textContent ?? '').replace(
          /^Proventos em .+$/,
          'Proventos em outubro',
        );
      }
    });
  await page.locator('[data-slot="month-change"] > span:last-child').evaluateAll((spans) => {
    for (const span of spans) {
      span.textContent = (span.textContent ?? '')
        .replace(/\d{2}\/\d{2}\/\d{4}/, '30/09/2026')
        .replace(/^vs\. [a-zç]+$/, 'vs. setembro');
    }
  });

  await expect(page).toHaveScreenshot('dashboard.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
  });
});
