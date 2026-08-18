import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';

/**
 * SPEC-006 — the transaction ledger view (#9). Before this, `(app)/transactions`
 * did not exist at all: a signed-in user had no way to see their own ledger,
 * only import extracts and read reports derived from it. Every unit test in
 * `core/ledger` passed for a whole milestone while none of this was reachable
 * — see the issue's reopening note — which is exactly the class of defect
 * only a real browser hitting a real route catches.
 *
 * BR-006-08's URL-driven filters are the other reason this is an E2E rather
 * than a component test: `lib/transactions-url-state.ts` is unit-tested in
 * isolation, but "does the browser's own reload actually reproduce the
 * filtered view" is the SPEC-011 lesson (`reports-scope.spec.ts`'s own
 * header) applied to this surface.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

interface SeededLedger {
  readonly petr4: string;
  readonly hglg11: string;
  readonly clear: string;
  readonly batchId: string;
}

/**
 * Two assets, one institution, one committed import batch, and three
 * transactions: an imported PETR4 buy (provenance = batch), a manual HGLG11
 * buy (provenance = manual), and a second PETR4 sell — enough to exercise
 * rows, provenance and a type filter that narrows the list to one row.
 */
async function seedLedger(userId: string): Promise<SeededLedger> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  let petr4: string = randomUUID();
  let hglg11: string = randomUUID();
  let clear: string = randomUUID();
  const batchId = randomUUID();

  try {
    /**
     * `RETURNING id` rather than trusting the generated uuid: `assets` and
     * `institutions` are shared reference data, so a previous run — or the
     * import journey, which creates PETR4 itself — may already hold the row.
     * `ON CONFLICT DO UPDATE` then keeps the **existing** id, and the uuid
     * generated here dangles, which surfaces as an FK violation on the
     * transactions insert rather than as anything about assets.
     */
    petr4 = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, 'PETR4', 'Petróleo Brasileiro PN', 'stock')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [petr4],
      )
    ).rows[0]!.id;
    hglg11 = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, 'HGLG11', 'CSHG Logística FII', 'fii')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [hglg11],
      )
    ).rows[0]!.id;
    clear = (
      await pool.query<{ id: string }>(
        `INSERT INTO institutions (id, name) VALUES ($1, 'Clear')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [clear],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, committed_at)
       VALUES ($1, $2, 'b3_negociacao', 'committed', now())`,
      [batchId, userId],
    );

    const rows: Array<{
      id: string;
      assetId: string;
      type: string;
      date: string;
      qty: string;
      price: string;
      naturalKey: string;
      importBatchId: string | null;
      isManual: boolean;
    }> = [
      {
        id: randomUUID(),
        assetId: petr4,
        type: 'buy',
        date: '2026-01-05',
        qty: '100',
        price: '32.15',
        naturalKey: 'e2e-petr4-buy',
        importBatchId: batchId,
        isManual: false,
      },
      {
        id: randomUUID(),
        assetId: petr4,
        type: 'sell',
        date: '2026-02-10',
        qty: '20',
        price: '35.00',
        naturalKey: 'e2e-petr4-sell',
        importBatchId: batchId,
        isManual: false,
      },
      {
        id: randomUUID(),
        assetId: hglg11,
        type: 'buy',
        date: '2026-03-01',
        qty: '10',
        price: '165.40',
        naturalKey: 'e2e-hglg11-buy',
        importBatchId: null,
        isManual: true,
      },
    ];

    for (const row of rows) {
      await pool.query(
        `INSERT INTO transactions
           (id, user_id, asset_id, institution_id, type, status, trade_date,
            quantity, unit_price, fees, total_value, natural_key, occurrence,
            import_batch_id, is_manual)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, 0, $9, $10, 1, $11, $12)`,
        [
          row.id,
          userId,
          row.assetId,
          clear,
          row.type,
          row.date,
          row.qty,
          row.price,
          (Number(row.qty) * Number(row.price)).toFixed(8),
          row.naturalKey,
          row.importBatchId,
          row.isManual,
        ],
      );
    }
  } finally {
    await pool.end();
  }

  return { petr4, hglg11, clear, batchId };
}

test.describe('transaction ledger', () => {
  test('a signed-in user reaches /transactions and sees their rows', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');

    await expect(page.getByRole('heading', { level: 1, name: 'Transações' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Transações' });
    await expect(table).toBeVisible();

    // BR-006-07: all assets and institutions in one chronological list.
    // Scoped to the table: the asset filter's `<select>` lists every ticker
    // too, so an unscoped text match counts the dropdown option as a row.
    await expect(table.getByText('PETR4')).toHaveCount(2);
    await expect(table.getByText('HGLG11')).toHaveCount(1);

    // BR-006-02: provenance is visible on the row, not merely stored.
    await expect(table.getByText('Importada')).toHaveCount(2);
    await expect(table.getByText('Manual')).toHaveCount(1);
  });

  test('filtering by type narrows the list, and the filter survives a reload', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    const table = page.getByRole('table', { name: 'Transações' });
    await expect(table.getByText('PETR4')).toHaveCount(2);

    // BR-006-08 — a plain GET form, so this is a real navigation.
    await page.getByLabel('Tipo').selectOption('sell');
    await page.getByRole('button', { name: 'Aplicar' }).click();

    await expect(page).toHaveURL(/type=sell/);
    await expect(table.getByText('PETR4')).toHaveCount(1);
    await expect(table.getByText('HGLG11')).toHaveCount(0);

    // The whole point of URL-held state (DL-011-06, applied here): a reload
    // must reproduce the exact filtered view, not fall back to the full list.
    await page.reload();
    await expect(page).toHaveURL(/type=sell/);
    await expect(page.getByLabel('Tipo')).toHaveValue('sell');
    await expect(table.getByText('PETR4')).toHaveCount(1);
    await expect(table.getByText('HGLG11')).toHaveCount(0);
  });

  test('a filter matching nothing explains itself rather than showing a blank table', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    await page.getByLabel('Buscar').fill('zzzz-no-such-asset');
    await page.getByRole('button', { name: 'Aplicar' }).click();

    await expect(page).toHaveURL(/q=zzzz/);
    await expect(page.getByRole('status')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
