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

/**
 * SPEC-006 BR-006-11..17 — the management surface. Every one of these
 * journeys covers a rule that held in `core/ledger`'s unit tests for a whole
 * milestone while no route reached it (see the header above).
 */
/**
 * BR-006-17's assignment target. Inserted directly rather than driven through
 * `/wallets`: what this suite is proving is the *transactions* surface, and a
 * wallet is a precondition of it, not part of the journey.
 */
async function seedWallet(userId: string, name: string): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  const walletId = randomUUID();
  try {
    await pool.query(`INSERT INTO wallets (id, user_id, name) VALUES ($1, $2, $3)`, [
      walletId,
      userId,
      name,
    ]);
  } finally {
    await pool.end();
  }
  return walletId;
}

test.describe('transaction management', () => {
  test('a CDB that no B3 extract carries can be entered by hand', async ({ signedIn }) => {
    const { page } = signedIn;

    await page.goto('/transactions/new');

    // AC: "A CDB absent from every B3 extract can be added manually." The
    // catalogue holds only what an import or a quote sync put there, so the
    // instrument is named here rather than picked.
    await page.getByLabel('Ou informe um código novo').fill('CDB-BANCO-X-2030');
    await page.getByLabel('Nome do ativo').fill('CDB Banco X 2030');
    await page.getByLabel('Classe').selectOption('cdb');
    await page.getByLabel('Tipo').selectOption('buy');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('1');
    // pt-BR decimal comma, which is what the keyboard actually produces.
    await page.getByLabel('Preço unitário').fill('5.000,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    const table = page.getByRole('table', { name: 'Transações' });
    await expect(table.getByText('CDB-BANCO-X-2030')).toHaveCount(1);
    await expect(table.getByText('Manual')).toHaveCount(1);
  });

  test('editing a quantity updates the row and flags the correction', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    // The manual HGLG11 buy: 10 quotas. Only that row's Editar is wanted.
    const row = page.getByRole('row').filter({ hasText: 'HGLG11' });
    await row.getByRole('link', { name: 'Editar' }).click();

    await expect(page.getByLabel('Quantidade')).toHaveValue('10');
    await page.getByLabel('Quantidade').fill('25');
    await page.getByRole('button', { name: 'Salvar alterações' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    const updated = page.getByRole('row').filter({ hasText: 'HGLG11' });
    await expect(updated).toContainText('25');
    // BR-006-16: a human decided this value, and a re-import must not revert it.
    await expect(updated.getByText('Editada')).toBeVisible();
  });

  /**
   * AC: "Attempting to sell more than held at that date is refused with an
   * explanation naming the held quantity." The refusal, not the success, is
   * the acceptance criterion — a form that silently redisplays itself is
   * exactly what BR-006-15 forbids.
   */
  test('selling more than was held is refused, and the message names the held quantity', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions/new');
    await page
      .getByLabel('Escolha um ativo já registrado')
      .selectOption({ label: 'HGLG11 — CSHG Logística FII' });
    // BR-007-08: positions are per (asset, institution), and no institution is
    // a *distinct bucket* rather than a wildcard — leaving this unset asks to
    // sell from a bucket holding nothing, which the domain correctly refuses
    // with "you had 0" and which would prove nothing about the held quantity.
    await page.getByLabel('Escolha uma instituição').selectOption({ label: 'Clear' });
    await page.getByLabel('Tipo').selectOption('sell');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('999');
    await page.getByLabel('Preço unitário').fill('170,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    // Not `getByRole('alert')`: Next renders its own empty route announcer
    // with that role on every page, so the bare role is ambiguous.
    const alert = page.locator('[data-slot="error-state"]');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    // 10 quotas held on that date — the number the user needs in order to act.
    await expect(alert).toContainText('10');
    await expect(alert).toContainText('999');
    // Still on the form, with the entry recoverable rather than thrown away.
    await expect(page.getByRole('button', { name: 'Registrar transação' })).toBeVisible();
  });

  /**
   * AC: "Deleting a transaction shows what will be recalculated before
   * confirming." DL-006-04's whole point — the consequence is visible, and
   * the projected position is a real replay rather than an estimate.
   */
  test('deleting discloses the recalculation before it happens', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    const row = page.getByRole('row').filter({ hasText: 'HGLG11' });
    await row.getByRole('link', { name: 'Excluir' }).click();

    await expect(page.getByRole('heading', { name: 'Excluir transação' })).toBeVisible();
    const impact = page.getByRole('table');
    await expect(impact).toContainText('Quantidade');
    // 10 held now, 0 once the only buy for this position is gone.
    await expect(impact).toContainText('10');

    await page.getByRole('button', { name: 'Confirmar exclusão' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByRole('table', { name: 'Transações' }).getByText('HGLG11')).toHaveCount(
      0,
    );
  });

  /**
   * AC: "Bulk delete and bulk wallet assignment operate on a multi-selection."
   * The pair here is deliberate: BR-006-17 groups by position and replays with
   * the *whole* selection removed, so a buy and its later sale delete together
   * even though the buy alone would be refused.
   */
  /**
   * The assignment half of the same AC. Driven through the entry form rather
   * than the seed on purpose: an allocation is bounded by the *position*
   * (BR-010-05), and only the write path recalculates it — seeding rows
   * straight into `transactions` leaves the position cache empty, so the
   * assignment would correctly find nothing unassigned and this test would
   * pass while proving nothing.
   */
  test('a multi-selection can be assigned to a wallet', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const walletId = await seedWallet(userId, 'Aposentadoria');

    await page.goto('/transactions/new');
    await page.getByLabel('Ou informe um código novo').fill('ITSA4');
    await page.getByLabel('Nome do ativo').fill('Itaúsa PN');
    await page.getByLabel('Tipo').selectOption('buy');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('100');
    await page.getByLabel('Preço unitário').fill('10,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    // BR-010-11 refuses to guess a wallet, so the shares arrive unallocated —
    // which is exactly the state this operation exists to resolve, in bulk.
    await page.getByRole('row').filter({ hasText: 'ITSA4' }).getByRole('checkbox').check();
    // "Carteira de destino", not "Carteira": the filter bar has a wallet
    // control of its own now, and the two ask different questions.
    await page.getByLabel('Carteira de destino').selectOption({ label: 'Aposentadoria' });
    await page.getByRole('button', { name: 'Atribuir à carteira' }).click();

    /**
     * Waiting on the outcome, not on the URL. The bulk form posts to the page
     * it already lives on, so `toHaveURL(/transactions$/)` is true *before*
     * the click as well as after — an assertion that cannot fail also cannot
     * wait, and navigating away on the strength of it cancels the request
     * mid-flight. This is what the summary note exists for.
     */
    await expect(page.getByRole('status')).toContainText('1');
    await expect(page.locator('[data-slot="error-state"]')).toHaveCount(0);

    await page.goto(`/wallets/${walletId}`);
    await expect(page.getByRole('table')).toContainText('ITSA4');
    await expect(page.getByRole('table')).toContainText('100');
  });

  test('bulk delete removes a whole selection at once', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    const table = page.getByRole('table', { name: 'Transações' });
    await expect(table.getByText('PETR4')).toHaveCount(2);

    for (const row of await page.getByRole('row').filter({ hasText: 'PETR4' }).all()) {
      await row.getByRole('checkbox').check();
    }
    await page.getByRole('button', { name: 'Excluir selecionadas' }).click();

    // Both rows in one operation — the buy and the sale that drew on it, which
    // is legal together and illegal one at a time.
    await expect(page.getByRole('status')).toContainText('2');
    await expect(page.getByRole('table', { name: 'Transações' }).getByText('PETR4')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Transações' }).getByText('HGLG11')).toHaveCount(
      1,
    );
  });
});

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

  /**
   * BR-006-08's wallet dimension, driven through the browser for the reason
   * this whole file exists: the SQL is integration-tested, and what that
   * cannot show is whether the control on the page reaches it. SPEC-011's
   * scope selector was inert for a milestone with its query layer working
   * perfectly.
   */
  test("filtering by wallet narrows the list to that wallet's assets", async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const walletId = await seedWallet(userId, 'Aposentadoria');

    // Entered through the form so the position exists to be allocated against
    // — the same reason the bulk-assign journey does it this way.
    await page.goto('/transactions/new');
    await page.getByLabel('Ou informe um código novo').fill('ITSA4');
    await page.getByLabel('Nome do ativo').fill('Itaúsa PN');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('100');
    await page.getByLabel('Preço unitário').fill('10,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await page.goto('/transactions/new');
    await page.getByLabel('Ou informe um código novo').fill('WEGE3');
    await page.getByLabel('Nome do ativo').fill('WEG ON');
    await page.getByLabel('Data da operação').fill('2026-04-02');
    await page.getByLabel('Quantidade').fill('50');
    await page.getByLabel('Preço unitário').fill('40,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    const table = page.getByRole('table', { name: 'Transações' });
    await expect(table.getByText('ITSA4')).toHaveCount(1);
    await expect(table.getByText('WEGE3')).toHaveCount(1);

    // Only ITSA4 goes into the wallet.
    await page.getByRole('row').filter({ hasText: 'ITSA4' }).getByRole('checkbox').check();
    await page.getByLabel('Carteira de destino').selectOption({ label: 'Aposentadoria' });
    await page.getByRole('button', { name: 'Atribuir à carteira' }).click();
    await expect(page.getByRole('status')).toContainText('1');

    // The filter bar's own wallet control — a different question from the bulk
    // bar's destination, which is why they no longer share a label.
    await page.getByLabel('Carteira', { exact: true }).selectOption({ label: 'Aposentadoria' });
    await page.getByRole('button', { name: 'Aplicar' }).click();

    await expect(page).toHaveURL(new RegExp(`wallet=${walletId}`));
    await expect(table.getByText('ITSA4')).toHaveCount(1);
    await expect(table.getByText('WEGE3')).toHaveCount(0);

    // BR-006-11's URL contract: the filtered view survives a reload.
    await page.reload();
    await expect(table.getByText('ITSA4')).toHaveCount(1);
    await expect(table.getByText('WEGE3')).toHaveCount(0);
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
