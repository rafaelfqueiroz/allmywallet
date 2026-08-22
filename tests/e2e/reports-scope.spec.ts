import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-011 AC-011-05 / BR-011-02 — **choosing a wallet in Escopo actually
 * scopes the report.**
 *
 * This exists because reading the code missed the defect for an entire
 * milestone. `Controls.tsx` submitted a hidden `scope` field derived from the
 * *current* scope rather than from the select beside it, and `parseScope`
 * tested that field before it looked at the wallet id — so the form posted
 * `wallet=<uuid>&scope=`, and the page reloaded showing the whole portfolio.
 * Every unit test passed, because each half was correct on its own terms.
 *
 * Only a browser submitting the real form catches that, which is exactly the
 * "a break here is invisible in unit tests" case TESTING §6 says earns an E2E
 * despite the cost.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

async function seedWallet(userId: string, name: string): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    // `wallets.id` carries no database default — the application generates it
    // (`WalletId.generate()`), so a seed has to supply one too.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [randomUUID(), userId, name],
    );
    return rows[0]?.id ?? '';
  } finally {
    await pool.end();
  }
}

test('selecting a wallet in Escopo scopes the report to it', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  const walletId = await seedWallet(userId, 'Aposentadoria');
  expect(walletId).not.toBe('');

  await page.goto('/reports');

  // The scope control is one `<select>` — "portfolio or which wallet" is one
  // question to a user, even though it was two values in the URL.
  const scope = page.getByLabel(/escopo/i);
  await expect(scope).toBeVisible();
  await scope.selectOption(walletId);

  await page.getByRole('button', { name: /aplicar/i }).click();

  // The whole defect in one assertion: after Aplicar, the URL names the wallet.
  await expect(page).toHaveURL(new RegExp(`wallet=${walletId}`));

  // And the page came back scoped rather than falling back to the portfolio —
  // the select still holds the wallet, which it only can if the server parsed
  // the scope it was sent.
  await expect(page.getByLabel(/escopo/i)).toHaveValue(walletId);

  // A wallet scope is a real screen, not an error page (SPEC-013: the
  // snapshot-derived figures are withheld, everything else still renders).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#__next_error__')).toHaveCount(0);
});

/**
 * SPEC-011 BR-011-12 / AC-011-11 — **the grouped export is reachable over
 * HTTP.**
 *
 * `exportGroupedCsv` was written, unit-tested, and referenced by nothing: no
 * route handler, no control on any page, `reports.export.csv` unused in the
 * catalogue. The criterion was ticked on a function no user could invoke (#61).
 *
 * This asserts the route, not the link. An earlier version drove the page and
 * looked for the button; it passed while exercising nothing, because the
 * signed-in fixture holds no positions and the control is only rendered when
 * there is something to export. Probing it — throwing in the branch it was
 * silently taking — is what exposed that, and a test that can pass without
 * reaching its subject is worse than none.
 *
 * This asserts the *route*. That the control on `/reports` carries the page's
 * own period, scope and grouping into the URL is the other half, and it needed
 * a tenant with holdings — it is the last test in this file.
 */
test('the grouped report exports as CSV over HTTP', async ({ signedIn }) => {
  const { page } = signedIn;

  const response = await page.request.get('/api/reports/export?grouping=institution');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  // BR-011-12's download, not an inline render.
  expect(response.headers()['content-disposition']).toContain('attachment');
  expect(response.headers()['content-disposition']).toContain('.csv');

  // The header row at minimum. A zero-byte body would "download successfully"
  // and say nothing, which a status assertion alone would not catch.
  const body = await response.text();
  expect(body.split('\n')[0]).toContain(',');
});

/**
 * SPEC-011 BR-011-07 / AC-9 — **"a group row drills down to its constituent
 * assets without leaving the report."**
 *
 * The last word is the assertion that matters. `GroupRow` uses `<details>`
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

  await page.goto('/reports');
  const url = page.url();

  // The default grouping at portfolio scope is asset class (BR-011-04), so the
  // seeded stock lands in one group and the ticker is its constituent.
  const constituent = page.getByText(String(first), { exact: false });
  await expect(constituent).toBeHidden();

  await page.locator('details summary').first().click();

  await expect(constituent.first()).toBeVisible();
  // In place: same URL, no navigation, nothing re-fetched.
  expect(page.url()).toBe(url);
});

/**
 * SPEC-011 BR-011-12 / AC-11, the half the CSV test above names as uncovered:
 * **the control carries the page's own period, scope and grouping into the
 * export.**
 *
 * "Exports exactly what is on screen" is the property that makes a grouped
 * export worth having, and it breaks silently — a link built from defaults
 * rather than from the resolved state downloads a file that is a plausible
 * report of the wrong view. It needed a tenant with holdings, which is why it
 * waited for one.
 */
test('the export control carries the view on screen into the download', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedHoldings(userId, [{ code: 'ITSAD', quantity: '100', averageCost: '10', price: '10' }]);

  await page.goto('/reports');

  await page.getByLabel(/agrupar por/i).selectOption('institution');
  await page.getByRole('button', { name: /aplicar/i }).click();
  await expect(page).toHaveURL(/grouping=institution/);

  const href = await page.getByRole('link', { name: 'Exportar CSV' }).getAttribute('href');
  expect(href).toContain('/api/reports/export');
  expect(href).toContain('grouping=institution');
});
