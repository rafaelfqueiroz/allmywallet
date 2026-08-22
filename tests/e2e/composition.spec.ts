import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings, type SeededHolding } from './support/holdings';

/**
 * SPEC-015 — the Composition report, over the real stack.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SEEDS HOLDINGS, AND WHY THAT IS NOT OPTIONAL
 *
 * The signed-in fixture owns nothing. A report driven against it renders
 * `ReportEmptyState` and every assertion about a table, a share or a flag
 * passes by never reaching the branch it claims to test — which is exactly how
 * the first CSV-export E2E on this suite passed while exercising nothing
 * (`reports-scope.spec.ts` records it). So this seeds two positions and their
 * quotes, and asserts figures that can only appear if the whole path ran.
 *
 * The numbers are chosen so the assertions are unambiguous **and** so one of
 * them lands exactly on BR-015-05's boundary:
 *
 *   PETR4·X  100 un × R$ 40,00 = R$ 4.000,00  → 80 % of the scope
 *   ITSA4·X  100 un × R$ 10,00 = R$ 1.000,00  → 20 % of the scope
 *                                total 5.000,00
 *
 * The default `reports.concentration_threshold_pct` is 20, and BR-015-05 says
 * a holding is flagged when it **exceeds** the threshold. So the first is
 * flagged and the second — sitting on exactly 20,00 % — is not. A `>=` in
 * `concentration.ts` would light both, and only a run with real figures
 * through the real config resolver can tell.
 * ---------------------------------------------------------------------------
 */

const HOLDINGS: readonly SeededHolding[] = [
  { code: 'PETRX', quantity: '100', averageCost: '30', price: '40' },
  { code: 'ITSAX', quantity: '100', averageCost: '10', price: '10' },
];

test('composes a real portfolio: shares, totals, the flag and its boundary', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [big, small] = await seedHoldings(userId, HOLDINGS);

  await page.goto('/reports/composition');
  await expect(page.locator('#__next_error__')).toHaveCount(0);

  /*
   * Asserted as *text*, not through the table role. DL-12 renders the same
   * rows as a table from `md` up and as cards below it, and only one of the
   * two is displayed at a given viewport — so a table-role locator would make
   * this test silently mobile-blind. Every figure below is present in both.
   */
  await expect(visibleText(page, String(big))).toBeVisible();
  await expect(visibleText(page, String(small))).toBeVisible();

  // BR-015-10 — the scope total, through the whole stack.
  await expect(
    page
      .getByText(/R\$\s*5\.000,00/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  // BR-015-07 — shares on market value: 80 % and 20 %, not the 75/25 the cost
  // basis would give (3.000 and 1.000 of 4.000).
  await expect(page.getByText('80,00%').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('20,00%').filter({ visible: true }).first()).toBeVisible();

  // BR-015-08 — 4.000 − 3.000 on the row that moved.
  await expect(
    page
      .getByText(/R\$\s*1\.000,00/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  /**
   * BR-015-05's boundary. The 80 % holding is flagged; the one sitting exactly
   * on the configured 20 % is not, because the rule says *exceeds*.
   */
  await expect(page.getByText('Acima de 20%').filter({ visible: true }).first()).toBeVisible();

  /*
   * `Section` renders a bare `<section>`, which carries no accessible name and
   * therefore no `region` role — so the section is located by the heading it
   * contains rather than by a name it does not have.
   */
  const concentration = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /participações acima do seu limite/i }) });
  await expect(concentration.getByText(String(big), { exact: false })).toBeVisible();
  await expect(concentration.getByText(String(small), { exact: false })).toHaveCount(0);
});

/**
 * SPEC-008 BR-008-04 / SPEC-015 AC-14 — "every screen showing a current value
 * displays the quote timestamp and the delay tier. The product never implies
 * real-time."
 *
 * Worth its own test because it was true of **no screen in the product** until
 * this report: the figure was on `latest_quotes.quoted_at` and reached no page.
 */
test('states the quote timestamp and the delay tier next to the figures', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedHoldings(userId, HOLDINGS);

  await page.goto('/reports/composition');

  await expect(page.getByText(/cotação de/i)).toBeVisible();
  await expect(page.getByText(/atraso de cerca de 30 minutos/i)).toBeVisible();
  await expect(page.getByText(/não são valores em tempo real/i)).toBeVisible();
});

/**
 * SPEC-015 AC-4 — sorting, driven through a real browser.
 *
 * The component test proves the comparator; this proves the controls survive
 * as controls after hydration, which no jsdom render can tell you.
 *
 * **Split by viewport, because the affordance genuinely differs** (DL-12).
 * From `md` up the column header is the control; below it there is no table
 * and no header, so the card rendering carries a select and a direction
 * toggle instead. Testing only the first would have left the phone — where a
 * holdings list is most likely to be long enough to need sorting — with no
 * coverage at all, which is how it shipped unsortable in the first place.
 */
const isMobile = (width: number) => width < 768;

test('sorts the holdings by a column header, from md up', async ({ signedIn, viewport }) => {
  test.skip(!viewport || isMobile(viewport.width), 'below md there is no table and no header');
  const { page, userId } = signedIn;
  const [big, small] = await seedHoldings(userId, HOLDINGS);

  await page.goto('/reports/composition');
  const table = page.getByRole('table', { name: /ativos do escopo/i });
  await expect(table).toBeVisible();

  const codes = async () =>
    (await table.locator('tbody tr td:first-child').allInnerTexts()).map(stripBadges);

  // Opens largest-first.
  expect(await codes()).toEqual([big, small]);

  await table.getByRole('button', { name: /ordenar por valor/i }).click();
  expect(await codes()).toEqual([small, big]);
});

test('sorts the holdings from the card control, below md', async ({ signedIn, viewport }) => {
  test.skip(!viewport || !isMobile(viewport.width), 'from md up the header is the control');
  const { page, userId } = signedIn;
  const [big, small] = await seedHoldings(userId, HOLDINGS);

  await page.goto('/reports/composition');

  // The card list carries the same accessible name as the table it replaces —
  // `DataTable` labels it from the same `caption`.
  const cards = page.getByRole('list', { name: /ativos do escopo/i });
  // `.all()` and `innerText` do not auto-wait, so the auto-waiting assertion
  // has to come first: without it the read races hydration and returns an
  // empty array, which reads as "the report is empty" rather than "too early".
  await expect(cards).toBeVisible();

  // The first `dd` of each card is the Ativo column — `DataTable` repeats the
  // column headers as `dt`/`dd` pairs in the order the columns are defined.
  const codes = async () => {
    const items = await cards.locator('li').all();
    return Promise.all(
      items.map(async (item) => stripBadges(await item.locator('dd').first().innerText())),
    );
  };

  expect(await codes()).toEqual([big, small]);

  await page.getByRole('button', { name: /ordem decrescente/i }).click();
  expect(await codes()).toEqual([small, big]);
});

/**
 * Both renderings of every row are in the DOM at once (DL-12) and CSS hides
 * one — so an unfiltered text locator resolves to the *hidden* copy at one of
 * the two viewports and fails `toBeVisible` for a reason that has nothing to
 * do with the report.
 */
function visibleText(page: Page, text: string) {
  return page.getByText(text, { exact: false }).filter({ visible: true }).first();
}

function stripBadges(text: string): string {
  return text
    .replace(/\s*Acima de \d+%\s*/, '')
    .replace(/\s*Estimado\s*/, '')
    .trim();
}

/**
 * BR-011-06 — the fourth report is reachable from the shared report nav, not
 * only by typing its URL. `/reports/composition` existed as a route for a
 * while before it was linked, which is the same "written and referenced by
 * nothing" defect #61 was opened for.
 */
test('is reachable from the report navigation', async ({ signedIn }) => {
  const { page } = signedIn;
  await page.goto('/reports');

  await page
    .getByRole('navigation', { name: 'Relatórios' })
    .getByRole('link', { name: 'Composição' })
    .click();

  await expect(page).toHaveURL(/\/reports\/composition$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Composição' })).toBeVisible();
});
