import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-022 BR-022-18 / BR-022-24 / DS-67 — the table standard, across every
 * screen that carries a table, in a real browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN E2E
 *
 * Two of the standard's promises are about layout, and a component test has
 * none: jsdom computes no widths. "Hiding the amounts moves no column" and "a
 * table never grows a page without bound" are true or false in a browser, and
 * the second is only true if each table is actually handed enough rows to need
 * a second page — so this seeds a tenant that has them. A table driven against
 * an empty tenant renders its empty state, and every assertion about a column
 * or a page then passes by never reaching the branch it claims to test.
 *
 * Fixtures are generated (TS-19): tickers carry a per-run suffix, amounts are
 * invented, and the extreme one — thirteen digits — exists to overflow a
 * column that was sized by its content.
 * ---------------------------------------------------------------------------
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

/** The largest figure a money column is sized for (DS-67): thirteen digits. */
const THIRTEEN_DIGITS = '12345678901.23';

const HOLDINGS = 12;

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

interface SeededTenant {
  readonly codes: readonly string[];
  /** A custom range covering the seeded daily snapshots, São Paulo's calendar. */
  readonly range: string;
}

/**
 * Twelve holdings (one of them extreme), a provento from each in twelve
 * different months, and forty daily snapshots — so every table below has more
 * than the ten rows of its first page: the holdings, the ledger, the history
 * and its composition, the months, the groups and the assets.
 */
async function seedTenant(userId: string): Promise<SeededTenant> {
  const codes = await seedHoldings(
    userId,
    Array.from({ length: HOLDINGS }, (_, index) =>
      index === HOLDINGS - 1
        ? { code: 'TBLX', quantity: '1', averageCost: THIRTEEN_DIGITS, price: THIRTEEN_DIGITS }
        : {
            code: `TBL${String.fromCharCode(65 + index)}`,
            quantity: '100',
            averageCost: '10',
            price: '12',
          },
    ),
  );

  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    for (const [index, code] of codes.entries()) {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE code = $1`, [
        code,
      ]);
      const assetId = rows[0]?.id;
      if (assetId === undefined) throw new Error(`no asset seeded for ${code}`);

      // 32 days apart is more than any month is long, so every provento lands
      // in a month of its own.
      await pool.query(
        `INSERT INTO transactions
           (id, user_id, asset_id, type, status, trade_date, quantity, unit_price, fees,
            total_value, natural_key, occurrence, is_manual, is_user_modified)
         VALUES ($1, $2, $3, 'dividend', 'active', $4, 100, 0, 0, $5, $6, 1, true, false)`,
        [
          randomUUID(),
          userId,
          assetId,
          daysAgo(32 * (index + 1)),
          index === HOLDINGS - 1 ? THIRTEEN_DIGITS : String(10 + index),
          `e2e-${randomUUID()}`,
        ],
      );
    }

    // Dated by São Paulo's calendar, the app's own; Postgres' CURRENT_DATE is
    // UTC's (see hide-values.spec.ts).
    await pool.query(
      `INSERT INTO daily_valuation_snapshots
         (user_id, date, total_value, net_contributions, earnings_to_date, by_asset_class)
       SELECT $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date - d, 1000 + d * 10, 1000, 0,
              jsonb_build_object('stock', (1000 + d * 10)::text)
         FROM generate_series(1, 40) AS d`,
      [userId],
    );
    const { rows } = await pool.query<{ from: string; to: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - 45, 'YYYY-MM-DD') AS from,
              to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS to`,
    );
    const span = rows[0];
    if (span === undefined) throw new Error('no range');
    return { codes, range: `period=custom&from=${span.from}&to=${span.to}` };
  } finally {
    await pool.end();
  }
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/**
 * A table is a table from `md` up and the same rows as a list below it
 * (DS-28), both named by the same caption.
 */
function tableNamed(page: Page, caption: string): Locator {
  return isMobile(page)
    ? page.getByRole('list', { name: caption })
    : page.getByRole('table', { name: caption });
}

/** The table's whole block: its rows and its footer with the pagination. */
function blockOf(page: Page, caption: string): Locator {
  return page.locator('[data-slot="data-table"]', { has: tableNamed(page, caption) });
}

/** The records of a table on the current page — header and total excluded. */
function recordsOf(page: Page, caption: string): Locator {
  return isMobile(page)
    ? tableNamed(page, caption).getByRole('listitem')
    : tableNamed(page, caption).locator('tbody').getByRole('row');
}

// ---------------------------------------------------------------------------
// BR-022-18 / BR-022-24 — a width per column, never changed by hiding values.
// ---------------------------------------------------------------------------

/**
 * Every column header of every table on screen, by table, in pixels. A table is
 * keyed by its caption, which is how it is named to everyone else.
 */
async function columnWidths(page: Page): Promise<Record<string, number[]>> {
  const widths: Record<string, number[]> = {};
  const tables = page.locator('table[data-slot="table"]:visible');
  for (let index = 0, count = await tables.count(); index < count; index += 1) {
    const table = tables.nth(index);
    const name = ((await table.locator('caption').textContent()) ?? '') || `table ${index}`;
    const headers = table.locator('thead th');
    const row: number[] = [];
    for (let column = 0, n = await headers.count(); column < n; column += 1) {
      const box = await headers.nth(column).boundingBox();
      row.push(Math.round(box?.width ?? 0));
    }
    widths[name] = row;
  }
  return widths;
}

/** The eye, which the server applies: the page comes back re-rendered. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  const eye = page.getByRole('button', { name: 'Ocultar valores', exact: true });
  await expect(eye).toHaveAttribute('aria-pressed', String(!hidden));
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', String(hidden));
  const placeholder = page.getByText('R$ ••••••');
  // The card list carries the placeholder too, hidden at this width.
  if (hidden) await expect(placeholder.filter({ visible: true }).first()).toBeVisible();
  else await expect(placeholder).toHaveCount(0);
}

test.describe('the table standard: a width per column', () => {
  test.beforeEach(({ page }) => {
    test.skip(isMobile(page), 'the table rendering, and so its column widths, is desktop-only');
  });

  /**
   * [path, the fewest tables that must be measured there]. The floor is what
   * makes the check mean something: a page that rendered its empty state would
   * "pass" with nothing measured.
   */
  const SCREENS = [
    ['/portfolio/composition', 1],
    ['/portfolio', 1],
    ['REPORTS', 3],
    ['/reports/earnings?period=24m', 3],
    ['/reports/performance?period=24m', 2],
    ['/transactions', 1],
  ] as const;

  test('hiding the amounts, and showing them again, moves no column on any screen', async ({
    signedIn,
  }) => {
    test.setTimeout(180_000);
    const { page, userId } = signedIn;
    const { range } = await seedTenant(userId);

    for (const [screen, atLeast] of SCREENS) {
      const path = screen === 'REPORTS' ? `/reports?${range}` : screen;
      await page.goto(path);
      const shown = await columnWidths(page);
      expect(Object.keys(shown).length, `${path}: tables measured`).toBeGreaterThanOrEqual(atLeast);
      for (const [name, widths] of Object.entries(shown)) {
        expect(widths.length, `${path}: ${name} has columns`).toBeGreaterThan(0);
        expect(
          widths.every((width) => width > 0),
          `${path}: ${name} has no zero-width column`,
        ).toBe(true);
      }

      await setHidden(page, true);
      expect(await columnWidths(page), `${path}: hidden`).toEqual(shown);

      await setHidden(page, false);
      expect(await columnWidths(page), `${path}: shown again`).toEqual(shown);
    }
  });

  test('every screen holds at 360px with no horizontal page scroll', async ({ signedIn }) => {
    test.setTimeout(120_000);
    const { page, userId } = signedIn;
    const { range } = await seedTenant(userId);
    await page.setViewportSize({ width: 360, height: 800 });

    for (const [screen] of SCREENS) {
      const path = screen === 'REPORTS' ? `/reports?${range}` : screen;
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `no horizontal page scroll at 360px on ${path}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// BR-022-18 — a table whose rows grow paginates, and remembers its page size.
// ---------------------------------------------------------------------------

interface PagedTable {
  /** `REPORTS` stands for the Evolução patrimonial URL with the seeded range. */
  readonly path: string;
  readonly caption: string;
  /** The table's own URL parameters — `history_size`, `history_page`. */
  readonly prefix: string;
}

const PAGED: readonly PagedTable[] = [
  { path: 'REPORTS', caption: 'Valores do gráfico', prefix: 'history' },
  {
    path: 'REPORTS',
    caption: 'Composição do patrimônio por classe de ativo, por data',
    prefix: 'stacked',
  },
  {
    path: '/reports/earnings?period=24m',
    caption: 'Proventos por mês, com média móvel de 12 meses',
    prefix: 'monthly',
  },
  {
    // By asset, so the groups are as many as the holdings.
    path: '/reports/earnings?period=24m&grouping=asset',
    caption: 'Proventos por grupo',
    prefix: 'breakdown',
  },
  {
    path: '/reports/earnings?period=24m',
    caption: 'Proventos por ativo, com os dois indicadores de rendimento',
    prefix: 'asset',
  },
  {
    path: '/reports/performance?period=24m&grouping=asset',
    caption: 'De onde veio a rentabilidade',
    prefix: 'contribution',
  },
];

test.describe('the table standard: pages', () => {
  for (const { path, caption, prefix } of PAGED) {
    test(`${caption}: pages ten at a time, and keeps its page size across a reload`, async ({
      signedIn,
    }) => {
      test.setTimeout(120_000);
      const { page, userId } = signedIn;
      const { range } = await seedTenant(userId);

      await page.goto(path === 'REPORTS' ? `/reports?${range}` : path);
      const block = blockOf(page, caption);
      const records = recordsOf(page, caption);

      // Ten to a page by default, and more than ten to show: there is a page 2.
      await expect(records).toHaveCount(10);
      const summary = await block.getByText(/^Mostrando 1–10 de \d+/).textContent();
      const total = Number(/ de (\d+)/.exec(summary ?? '')?.[1]);
      expect(total).toBeGreaterThan(10);

      const pagination = block.getByRole('navigation', { name: 'Paginação' });
      await pagination.getByRole('button', { name: 'Página 2' }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]${prefix}_page=2(&|$)`));
      await expect(records).toHaveCount(Math.min(10, total - 10));

      // 25 a page: back to the first page, the choice in the URL.
      await block.getByLabel('Itens por página').selectOption('25');
      await expect(page).toHaveURL(new RegExp(`[?&]${prefix}_size=25(&|$)`));
      await expect(page).not.toHaveURL(new RegExp(`[?&]${prefix}_page=`));
      const shown = Math.min(25, total);
      await expect(records).toHaveCount(shown);

      // The URL is the state: a reload reproduces it, and the control says 25.
      const url = page.url();
      await page.reload();
      expect(page.url()).toBe(url);
      await expect(block.getByLabel('Itens por página')).toHaveValue('25');
      await expect(records).toHaveCount(shown);
    });
  }

  /**
   * SPEC-016 BR-016-16 — the history is the chart's table, and a sorted one: it
   * opens on the newest date, which is what a reader opens it for.
   */
  test('the history opens newest first', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    test.skip(isMobile(page), 'below md there is no column header to read the order from');
    const { range } = await seedTenant(userId);

    await page.goto(`/reports?${range}`);
    await expect(
      tableNamed(page, 'Valores do gráfico').getByRole('columnheader', { name: /Data/ }),
    ).toHaveAttribute('aria-sort', 'descending');
  });

  /**
   * The CSV is built from the report's query, not from the table: whatever page
   * the history is on, it exports the whole period.
   */
  test('the CSV export is not narrowed by the history table’s page', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const { range } = await seedTenant(userId);

    await page.goto(`/reports?${range}&history_size=25&history_page=2`);
    const href = await page.getByRole('link', { name: 'Exportar CSV' }).getAttribute('href');
    expect(href).not.toBeNull();
    expect(href).not.toContain('history_');

    const response = await page.request.get(href ?? '');
    expect(response.status()).toBe(200);
    // The one extreme holding is in the file, whatever page the table is on.
    expect(await response.text()).toContain('12345678901');
  });
});
