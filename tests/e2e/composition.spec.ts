import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings, type SeededHolding } from './support/holdings';
import { dataTableByCaption, expectPageSizeSurvivesReload } from './support/page-size';

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

  await page.goto('/portfolio/composition');
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
  // A table from md up and cards below (SPEC-022 BR-022-18): one rendering shown.
  await expect(
    concentration.getByText(String(big), { exact: false }).filter({ visible: true }),
  ).toHaveCount(1);
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

  await page.goto('/portfolio/composition');

  // Portfólio's freshness line, in the dashboard's words (BR-022-32), with
  // SPEC-005 BR-005-27's import date beside the quote's.
  await expect(page.getByText(/cotação intradiária mais recente/i)).toBeVisible();
  await expect(page.getByText(/atraso de até 30 minutos/i)).toBeVisible();
  await expect(page.getByText(/nunca em tempo real/i)).toBeVisible();
  await expect(page.getByText(/nenhum extrato importado ainda/i)).toBeVisible();
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

  await page.goto('/portfolio/composition');
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

  await page.goto('/portfolio/composition');

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
 * SPEC-022 BR-022-02 — Composição is a Portfólio tab, reachable from the tab
 * bar rather than only by its URL (the "written and referenced by nothing"
 * defect #61 was opened for), and gone from Relatórios' tabs.
 */
test('is reachable from the Portfólio tabs, and no longer from Relatórios', async ({
  signedIn,
}) => {
  const { page } = signedIn;
  await page.goto('/portfolio');

  await page
    .getByRole('navigation', { name: 'Portfólio' })
    .getByRole('link', { name: 'Composição' })
    .click();

  await expect(page).toHaveURL(/\/portfolio\/composition$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Portfólio' })).toBeVisible();

  await page.goto('/reports');
  await expect(
    page.getByRole('navigation', { name: 'Relatórios' }).getByRole('link', { name: 'Composição' }),
  ).toHaveCount(0);
});

/**
 * SPEC-011 BR-011-07 / AC-9 — **"a group row drills down to its constituent
 * assets without leaving the report."**
 *
 * It lived on Relatórios' Visão geral until that tab left (SPEC-022 BR-022-03,
 * #209); the grouped view is Portfólio › Composição's groups table now.
 *
 * The last word is the assertion that matters. `GroupsTable` uses `<details>`
 * precisely so the constituents travel with the group and need no second
 * query, and the failure this guards against is someone replacing it with a
 * link to a filtered view: the user would still see the assets, the criterion
 * would look satisfied, and the drill-down would have become a navigation.
 *
 * Seeded, because a group has to exist to expand. An empty tenant renders the
 * empty state and this test would pass by asserting nothing.
 */
test('expanding a group reveals its assets in place, without leaving the report', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  const [first] = await seedHoldings(userId, [
    { code: 'PETRD', quantity: '100', averageCost: '30', price: '40' },
  ]);
  expect(first).toBeDefined();

  await page.goto('/portfolio/composition');
  const url = page.url();
  // Scoped to the groups table: the holdings table below lists every asset
  // on its own, so the page as a whole always shows the ticker.
  // SPEC-022 BR-022-18: a table from md up, cards below — the group's own
  // `<details>` is the one shown in either.
  const group = dataTableByCaption(page, 'Participação de cada grupo no valor total')
    .locator('details')
    .filter({ visible: true })
    .first();

  // The default grouping at portfolio scope is asset class (BR-011-04), so the
  // seeded stock lands in one group and the ticker is its constituent.
  const constituent = group.getByText(String(first), { exact: false });
  await expect(constituent).toBeHidden();

  await group.locator('summary').click();

  await expect(constituent.first()).toBeVisible();
  // In place: same URL, no navigation, nothing re-fetched.
  expect(page.url()).toBe(url);
});

/**
 * SPEC-022 BR-022-18 — Composição's groups table pages like every list, with the
 * total pinned under it on every page, and keeps its page size through a reload.
 * Grouped by asset there is one group per holding, which is the case where it
 * grows.
 */
test('the groups table pages, keeps its total, and keeps its page size through a reload', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  await seedHoldings(
    userId,
    Array.from({ length: 12 }, (_, index) => ({
      code: `GRP${String(index + 1).padStart(2, '0')}`,
      quantity: '10',
      averageCost: '10',
      price: '10',
    })),
  );

  await page.goto('/portfolio/composition?grouping=asset');
  const groups = dataTableByCaption(page, 'Participação de cada grupo no valor total');

  // The total is the whole portfolio's (12 × 10 × R$ 10,00), not the page's.
  await expect(groups).toContainText('Total');
  await expect(groups).toContainText(/R\$\s*1\.200,00/);

  await expectPageSizeSurvivesReload(
    page,
    'Participação de cada grupo no valor total',
    'groups',
    12,
  );
});
