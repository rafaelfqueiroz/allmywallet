import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';

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
 * What is *not* covered here, stated rather than implied: that the control on
 * `/reports` carries the page's own period, scope and grouping into this URL.
 * That needs a fixture with holdings, which this suite does not have.
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
