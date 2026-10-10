import { expect, test } from '@playwright/test';

/**
 * SPEC-022 BR-022-17/18, DESIGN.md DS-53/DS-54 — a table's URL state and the
 * scope selector share one query string, through Next's real history bridge.
 *
 * The component tests mock `next/navigation`, so they cannot see whether a
 * `history.replaceState` from the table actually reaches `useSearchParams`.
 * It did not, once: the table handed Next's own history state back, Next took
 * the call for one of its own and skipped the sync, and the address bar moved
 * while `useSearchParams` stayed stale. The next navigation — a scope change,
 * built from those stale parameters — then dropped the table's filter. Only a
 * real Next.js page shows that, so this runs against `/primitives`, whose
 * header carries a `ScopeSelector` above a filterable, paginated `DataTable`.
 */
test('a scope change keeps the table filter written a moment before', async ({ page }) => {
  await page.goto('/primitives');
  const table = page.locator('[data-slot="data-table"]');
  const filter = table.getByRole('searchbox');
  await expect(filter).toBeVisible();

  await filter.fill('ATIV1');
  await expect(page).toHaveURL(/[?&]demo_q=ATIV1(&|$)/);

  await page.getByRole('button', { name: /escopo/i }).click();
  await page.getByRole('menuitemradio', { name: 'Aposentadoria' }).click();

  await expect(page).toHaveURL(/[?&]wallet=00000000-0000-4000-8000-000000000001(&|$)/);
  await expect(page).toHaveURL(/[?&]demo_q=ATIV1(&|$)/);
  await expect(filter).toHaveValue('ATIV1');
});

test('sort and page survive a reload', async ({ page }) => {
  await page.goto('/primitives');
  const pagination = page.getByRole('navigation', { name: 'Paginação' });
  await expect(pagination).toBeVisible();

  await pagination.getByRole('button', { name: 'Página 2' }).click();
  await expect(page).toHaveURL(/[?&]demo_page=2(&|$)/);

  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'Paginação' }).getByRole('button', { name: 'Página 2' }),
  ).toHaveAttribute('aria-current', 'page');
});
