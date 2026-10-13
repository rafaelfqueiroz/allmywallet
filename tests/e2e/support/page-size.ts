import { expect, type Page } from '@playwright/test';

/**
 * SPEC-022 BR-022-18 — every growing table paginates (10, 25 or 50 a page,
 * opening on 10) and keeps its page size in the URL, so a reload does not lose
 * it.
 *
 * The table is found by its caption, which every `DataTable` carries
 * (`<caption class="sr-only">` in the table, and again as the card list's
 * name). Both renderings are in the DOM at every width and CSS shows one, so
 * the locator goes through the caption element rather than the `table` role —
 * a role query would find nothing below `md`, where the table is hidden. The
 * footer (summary, pager and page size) is shared by both and always visible.
 */
export function dataTableByCaption(page: Page, caption: string) {
  return page.locator('[data-slot="data-table"]').filter({
    has: page.locator('caption', { hasText: caption }),
  });
}

/**
 * The table opens on 10 rows a page with a pager, takes 25, shows that in the
 * URL under its own `paramPrefix`, and still shows 25 after a reload.
 *
 * `rows` is how many the page was seeded with, which must be over 10 so there
 * is a page 2 to see; the summary counts them.
 */
export async function expectPageSizeSurvivesReload(
  page: Page,
  caption: string,
  paramPrefix: string,
  rows: number,
): Promise<void> {
  const table = () => dataTableByCaption(page, caption);

  await expect(table().getByLabel('Itens por página')).toHaveValue('10');
  await expect(table().getByText(new RegExp(`Mostrando 1–10 de ${rows}\\b`))).toBeVisible();
  await expect(table().getByRole('button', { name: 'Página 2' })).toBeVisible();

  await table().getByLabel('Itens por página').selectOption('25');
  await expect(page).toHaveURL(new RegExp(`[?&]${paramPrefix}_size=25(&|#|$)`));
  await expect(table().getByLabel('Itens por página')).toHaveValue('25');

  await page.reload();
  await expect(table().getByLabel('Itens por página')).toHaveValue('25');
  await expect(
    table().getByText(new RegExp(`Mostrando 1–${Math.min(rows, 25)} de ${rows}\\b`)),
  ).toBeVisible();
}
