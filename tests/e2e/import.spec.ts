import { Pool } from 'pg';
import { buildNegociacaoXlsx, SYNTHETIC_CPF } from '@/adapters/ingestion/xlsx/test-support/builder';
import { expect, test } from './support/authenticated';

/**
 * SPEC-005 — the import journey, end to end, in a real browser against the
 * production build.
 *
 * **This is the journey the product cannot work without.** DL-005-01 chose
 * file import as the only way custody data enters the system: B3's APIs are
 * B2B-only and credential scraping was rejected outright. A user who cannot
 * complete this has an empty product, so it is exactly the kind of break
 * TESTING §6 says earns an E2E test despite their cost.
 *
 * **The extract is generated, never captured** (DV-24, TS-19). A real B3
 * export carries a real CPF and real holdings; `test-support/builder.ts`
 * produces the same file structure with `SYNTHETIC_CPF`, which is what lets
 * the CPF-stripping assertion below be meaningful — we know the exact string
 * that went in, so we can prove it did not come out.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[],
): Promise<T | undefined> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const result = await pool.query<T>(sql, [...params]);
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

/**
 * Two queue round trips (`import.stage`, then `import.commit`), each with a
 * pg-boss poll interval in front of it. The default 30s cap expires inside the
 * first one, which reads as "staging is broken" rather than "the test did not
 * wait".
 */
test.setTimeout(180_000);

test('a signed-in user imports a Negociação extract and sees the transactions land', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;

  // ---- The guide is what a first-run user meets -------------------------
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: /como exportar/i })).toBeVisible();

  // ---- Upload ------------------------------------------------------------
  const file = await buildNegociacaoXlsx([
    { data: '02/01/2026', tipo: 'Compra', codigo: 'PETR4', quantidade: '100', preco: '38,50' },
    { data: '03/02/2026', tipo: 'Compra', codigo: 'PETR4', quantidade: '50', preco: '41,00' },
  ]);

  await page.getByLabel(/arquivo/i).setInputFiles({
    name: 'negociacao.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(file),
  });
  await page.getByRole('button', { name: /^enviar$/i }).click();

  // The action redirects to the batch it created.
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}$/);
  const batchId = page.url().split('/').pop() ?? '';
  expect(batchId).not.toBe('');

  // ---- Staging happens on the queue, so wait for the result, not a timer --
  // Polled against the database rather than against the rendered badge: the
  // badge is a translated string, and a test that waits on wording fails for
  // a copy edit and passes for a broken queue if the wording ever collides.
  await expect
    .poll(
      async () => {
        const row = await queryOne<{ status: string }>(
          'SELECT status FROM import_batches WHERE id = $1',
          [batchId],
        );
        return row?.status ?? 'missing';
      },
      { message: 'the import.stage job should move the batch to previewed', timeout: 90_000 },
    )
    .toBe('previewed');

  // ---- Commit ------------------------------------------------------------
  // BR-005-11: nothing is written to the ledger until the user confirms, so
  // the presence of this control *is* the preview state — asserted as a
  // control rather than as a status badge, because it is the thing the user
  // has to be able to reach.
  await page.reload();
  const confirm = page.getByRole('button', { name: /confirmar importação/i });
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect
    .poll(
      async () => {
        const row = await queryOne<{ count: string }>(
          'SELECT count(*)::text AS count FROM transactions WHERE user_id = $1',
          [userId],
        );
        return Number(row?.count ?? '0');
      },
      { message: 'the import.commit job should write the ledger', timeout: 90_000 },
    )
    .toBe(2);

  // ---- SPEC-004 BR-004-02: the CPF is not anywhere ------------------------
  // The single most expensive rule in the product to get wrong, asserted on
  // the one path that could introduce it. `raw_payload` is the place it would
  // survive if stripping happened after persistence rather than before.
  const leaked = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM import_rows
      WHERE user_id = $1
        AND raw_payload::text LIKE '%' || $2 || '%'`,
    [userId, SYNTHETIC_CPF],
  );
  expect(Number(leaked?.count ?? '0')).toBe(0);

  // ---- SPEC-010 BR-010-15: the import says what it did to the wallets -----
  // The tenant has no wallets, so the 150 PETR4 it just imported are entirely
  // unassigned — which is the case the summary most needs to state, because
  // nothing else on screen would tell the user their new holding is sitting
  // in no purpose at all (BR-010-16: never guessed into one).
  await page.goto(`/import/${batchId}`);
  await expect(page.getByRole('heading', { name: /o que esta importação mudou/i })).toBeVisible();
  await expect(page.getByText('PETR4', { exact: false }).first()).toBeVisible();

  // ---- Every report renders for a signed-in tenant with real holdings -----
  //
  // Not a smoke test padded onto the end. `screens.spec.ts` checks these
  // routes **signed out**, which is how the root layout's tenant-scoped
  // config read reached production returning 500 on every authenticated page:
  // signed out, that read never happens. This is the only place in the suite
  // where a report renders with a session and with data behind it.
  for (const route of ['/reports', '/reports/patrimonio', '/reports/performance'] as const) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }), `${route} should render`).toBeVisible();
    // A Next error boundary renders its own document; this is what tells a
    // 500 apart from a page that legitimately has little to show.
    await expect(page.locator('#__next_error__'), `${route} should not 500`).toHaveCount(0);
  }
});
