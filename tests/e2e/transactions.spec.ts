import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Page } from '@playwright/test';
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

/**
 * SPEC-022 BR-022-18 / DS-28 — the ledger is a `DataTable`: a table from `md`
 * up, the same rows as cards below it. The suite runs at both widths, so a
 * journey reads whichever rendering is on screen; the cards are a list named
 * by the same caption.
 */
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

function ledger(page: Page) {
  return isMobile(page)
    ? page.getByRole('list', { name: 'Transações' })
    : page.getByRole('table', { name: 'Transações' });
}

/** One transaction — a table row, or its card. */
function ledgerRow(page: Page, text: string) {
  return ledger(page)
    .getByRole(isMobile(page) ? 'listitem' : 'row')
    .filter({ hasText: text });
}

/** A row's "⋯" button (SPEC-022 BR-022-40), named after the row it acts on. */
function rowMenu(page: Page, text: string) {
  return ledgerRow(page, text).getByRole('button', { name: /^Ações da transação de / });
}

/** Picks one of a row's actions from its "⋯" menu. */
async function rowAction(page: Page, text: string, action: string): Promise<void> {
  await rowMenu(page, text).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

/** Every transaction on the current page of the ledger, header excluded. */
function ledgerRows(page: Page) {
  return isMobile(page)
    ? ledger(page).getByRole('listitem')
    : ledger(page).locator('tbody').getByRole('row');
}

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

/**
 * A wallet's allocations: a table from md up, cards below it — the visible one
 * of the two (DS-28).
 */
function allocations(page: Page) {
  return page
    .getByRole('table', { name: 'Ativos atribuídos' })
    .or(page.getByRole('list', { name: 'Ativos atribuídos' }))
    .filter({ visible: true });
}

test.describe('transaction management', () => {
  test('a CDB that no B3 extract carries can be entered by hand', async ({ signedIn }) => {
    const { page } = signedIn;

    await page.goto('/transactions/new');

    // AC: "A CDB absent from every B3 extract can be added manually." The
    // catalogue holds only what an import or a quote sync put there, so the
    // instrument is named here rather than picked.
    await page.getByLabel('Ou informe um código novo', { exact: true }).fill('CDB-BANCO-X-2030');
    await page.getByLabel('Nome do ativo').fill('CDB Banco X 2030');
    await page.getByLabel('Classe').selectOption('cdb');
    await page.getByLabel('Tipo').selectOption('buy');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('1');
    // pt-BR decimal comma, which is what the keyboard actually produces.
    await page.getByLabel('Preço unitário', { exact: true }).fill('5.000,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    const table = ledger(page);
    // BR-022-40: a CDB leads with its name — B3's code for one is opaque.
    await expect(table.getByText('CDB Banco X 2030')).toHaveCount(1);
    await expect(table.getByText('Manual')).toHaveCount(1);
  });

  test('editing a quantity updates the row and flags the correction', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    // The manual HGLG11 buy: 10 quotas. Only that row's Editar is wanted.
    await rowAction(page, 'HGLG11', 'Editar');

    // The ledger has a "Quantidade" column of its own; read the form once it is there.
    await expect(page).toHaveURL(/\/edit$/);
    await expect(page.getByLabel('Quantidade')).toHaveValue('10');
    await page.getByLabel('Quantidade').fill('25');
    await page.getByRole('button', { name: 'Salvar alterações' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    const updated = ledgerRow(page, 'HGLG11');
    await expect(updated).toContainText('25');
    // BR-006-16: a human decided this value, and a re-import must not revert it.
    // Shown whole, on a line of its own — not cut by the column (BR-022-40).
    const modified = updated.getByText('Editada', { exact: true });
    await expect(modified).toBeVisible();
    expect(await modified.evaluate((line) => line.scrollWidth <= line.clientWidth)).toBe(true);
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
    await page.getByLabel('Preço unitário', { exact: true }).fill('170,00');
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
    await rowAction(page, 'HGLG11', 'Excluir');

    await expect(page.getByRole('heading', { name: 'Excluir transação' })).toBeVisible();
    const impact = page.getByRole('table');
    await expect(impact).toContainText('Quantidade');
    // 10 held now, 0 once the only buy for this position is gone.
    await expect(impact).toContainText('10');

    await page.getByRole('button', { name: 'Confirmar exclusão' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    await expect(ledger(page).getByText('HGLG11')).toHaveCount(0);
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
    await page.getByLabel('Ou informe um código novo', { exact: true }).fill('ITSA4');
    await page.getByLabel('Nome do ativo').fill('Itaúsa PN');
    await page.getByLabel('Tipo').selectOption('buy');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('100');
    await page.getByLabel('Preço unitário', { exact: true }).fill('10,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await expect(page).toHaveURL(/\/transactions$/);
    // BR-010-11 refuses to guess a wallet, so the shares arrive unallocated —
    // which is exactly the state this operation exists to resolve, in bulk.
    await ledgerRow(page, 'ITSA4').getByRole('checkbox').check();
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

    await page.goto(`/settings/wallets/${walletId}`);
    await expect(allocations(page)).toContainText('ITSA4');
    await expect(allocations(page)).toContainText('100');
  });

  /**
   * SPEC-010 AC-010-15 — "a sale with a specified wallet reduces only that
   * wallet".
   *
   * The unit tests for this branch existed before anything could reach it
   * (#61), so the end-to-end path is the assertion that matters: a control on
   * the form, a value that survives the server action, and two wallets whose
   * quantities disagree afterwards in exactly the way the user asked for.
   *
   * A 60/40 split is the only shape that can tell the two behaviours apart —
   * under BR-010-17's proportional default the same sale would take 12 from
   * Aposentadoria, and this test would fail on the last assertion rather than
   * pass by coincidence.
   */
  test('a sale can name the wallet it came out of', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const retirement = await seedWallet(userId, 'Aposentadoria');
    const trading = await seedWallet(userId, 'Trading');

    await page.goto('/transactions/new');
    await page.getByLabel('Ou informe um código novo', { exact: true }).fill('ITSA4');
    await page.getByLabel('Nome do ativo').fill('Itaúsa PN');
    await page.getByLabel('Tipo').selectOption('buy');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('100');
    await page.getByLabel('Preço unitário', { exact: true }).fill('10,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();
    await expect(page).toHaveURL(/\/transactions$/);

    /*
      BR-010-04's deliberate split, made through the UI that makes it — the
      "Needs attention" queue, where the buy lands because BR-010-11 refuses to
      guess a wallet. The row stays in the queue after the first assignment
      because 40 are still unallocated, which is what lets the second run of
      this loop find it.
    */
    for (const [walletName, quantity] of [
      ['Aposentadoria', '60'],
      ['Trading', '40'],
    ] as const) {
      await page.goto('/settings/wallets/assign');
      // The queue's Resolver panel opens on the first pending asset (#237);
      // exact, because the queue's table is labelled by a caption too.
      await page.getByLabel('Quantidade', { exact: true }).first().fill(quantity);
      await page
        .getByLabel('Atribuir a', { exact: true })
        .first()
        .selectOption({ label: walletName });
      await page.getByRole('button', { name: 'Atribuir', exact: true }).first().click();
      await expect(page.locator('[data-slot="error-state"]')).toHaveCount(0);
    }

    await page.goto('/transactions/new');
    // The full label: "Ativo" alone also matches "Nome do ativo". The option
    // text is "<code> — <name>", so that has to be exact too.
    await page
      .getByLabel('Escolha um ativo já registrado')
      .selectOption({ label: 'ITSA4 — Itaúsa PN' });
    await page.getByLabel('Tipo').selectOption('sell');
    await page.getByLabel('Data da operação').fill('2026-04-10');
    await page.getByLabel('Quantidade').fill('20');
    await page.getByLabel('Preço unitário', { exact: true }).fill('12,00');
    await page
      .getByLabel('Vendeu de qual carteira?', { exact: true })
      .selectOption({ label: 'Trading' });
    await page.getByRole('button', { name: 'Registrar transação' }).click();
    await expect(page).toHaveURL(/\/transactions$/);

    await page.goto(`/settings/wallets/${trading}`);
    await expect(allocations(page)).toContainText('20');

    // The assertion the proportional default would fail: untouched at 60.
    await page.goto(`/settings/wallets/${retirement}`);
    await expect(allocations(page)).toContainText('60');
  });

  test('bulk delete removes a whole selection at once', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');
    const table = ledger(page);
    await expect(table.getByText('PETR4')).toHaveCount(2);

    for (const row of await ledgerRow(page, 'PETR4').all()) {
      await row.getByRole('checkbox').check();
    }
    await page.getByRole('button', { name: 'Excluir selecionadas' }).click();

    // Both rows in one operation — the buy and the sale that drew on it, which
    // is legal together and illegal one at a time.
    await expect(page.getByRole('status')).toContainText('2');
    await expect(ledger(page).getByText('PETR4')).toHaveCount(0);
    await expect(ledger(page).getByText('HGLG11')).toHaveCount(1);
  });
});

test.describe('transaction ledger', () => {
  test('a signed-in user reaches /transactions and sees their rows', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions');

    await expect(page.getByRole('heading', { level: 1, name: 'Transações' })).toBeVisible();
    const table = ledger(page);
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
    const table = ledger(page);
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
    await page.getByLabel('Ou informe um código novo', { exact: true }).fill('ITSA4');
    await page.getByLabel('Nome do ativo').fill('Itaúsa PN');
    await page.getByLabel('Data da operação').fill('2026-04-01');
    await page.getByLabel('Quantidade').fill('100');
    await page.getByLabel('Preço unitário', { exact: true }).fill('10,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    await page.goto('/transactions/new');
    await page.getByLabel('Ou informe um código novo', { exact: true }).fill('WEGE3');
    await page.getByLabel('Nome do ativo').fill('WEG ON');
    await page.getByLabel('Data da operação').fill('2026-04-02');
    await page.getByLabel('Quantidade').fill('50');
    await page.getByLabel('Preço unitário', { exact: true }).fill('40,00');
    await page.getByRole('button', { name: 'Registrar transação' }).click();

    const table = ledger(page);
    await expect(table.getByText('ITSA4')).toHaveCount(1);
    await expect(table.getByText('WEGE3')).toHaveCount(1);

    // Only ITSA4 goes into the wallet.
    await ledgerRow(page, 'ITSA4').getByRole('checkbox').check();
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

    // The filter bar stays, and the way back is one link (SPEC-022 BR-022-18).
    await expect(page.getByLabel('Buscar')).toHaveValue('zzzz-no-such-asset');
    await page.getByRole('link', { name: 'Limpar filtros' }).first().click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(ledger(page).getByText('HGLG11')).toHaveCount(1);
  });
});

/**
 * Thirty BBAS3 buys of one share each, priced R$ 10, R$ 20 … R$ 300 on
 * consecutive days, so every row's total is distinct and the list spans two
 * pages of 25. Rows only: nothing here needs a position.
 */
async function seedThirty(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const bbas3 = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, 'BBAS3', 'Banco do Brasil ON', 'stock')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID()],
      )
    ).rows[0]!.id;
    for (let i = 1; i <= 30; i++) {
      const price = (i * 10).toFixed(2);
      await pool.query(
        `INSERT INTO transactions
           (id, user_id, asset_id, institution_id, type, status, trade_date,
            quantity, unit_price, fees, total_value, natural_key, occurrence,
            import_batch_id, is_manual)
         VALUES ($1, $2, $3, NULL, 'buy', 'active', $4::date, 1, $5, 0, $5, $6, 1, NULL, true)`,
        [
          randomUUID(),
          userId,
          bbas3,
          `2025-01-${String(i).padStart(2, '0')}`,
          price,
          `e2e-bbas3-${i}`,
        ],
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * A broker name too long for its column, and the largest figures the ledger's
 * columns are sized for (BR-022-40, #242 Decision log): a unit price of
 * R$ 999.999,99 and a total of R$ 99.999.999,00.
 */
const LONG_BROKER = 'INTER DISTRIBUIDORA DE TÍTULOS E VALORES MOBILIÁRIOS LTDA';
const WIDEST_PRICE = '999999.99';
const WIDEST_TOTAL = '99999999.00';
const WIDEST_QUANTITY = '1234.12345678';

async function seedExtremes(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const asset = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, 'EXTR3', 'Extremos ON', 'stock')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID()],
      )
    ).rows[0]!.id;
    const institution = (
      await pool.query<{ id: string }>(
        `INSERT INTO institutions (id, name) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID(), LONG_BROKER],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, institution_id, type, status, trade_date,
          quantity, unit_price, fees, total_value, natural_key, occurrence,
          import_batch_id, is_manual, is_user_modified, cost_is_estimate, estimate_close_date)
       VALUES ($1, $2, $3, $4, 'subscription', 'unclassified', '2026-03-02', 100, $5, 0, $6,
               'e2e-extremes', 1, NULL, true, true, true, '2026-03-02')`,
      // Every cell at its widest: the longest status, an origin with "Editada",
      // and "Custo estimado" under the price.
      [randomUUID(), userId, asset, institution, WIDEST_PRICE, WIDEST_TOTAL],
    );
    // The widest quantity `formatQuantity` writes: eight decimal places (#255 review).
    const fractional = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES ($1, 'EXTQ3', 'Extremos fração', 'stock')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [randomUUID()],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, institution_id, type, status, trade_date,
          quantity, unit_price, fees, total_value, natural_key, occurrence,
          import_batch_id, is_manual)
       VALUES ($1, $2, $3, $4, 'buy', 'active', '2026-03-01', $5, 1, 0, $5,
               'e2e-extremes-fraction', 1, NULL, true)`,
      [randomUUID(), userId, fractional, institution, WIDEST_QUANTITY],
    );
  } finally {
    await pool.end();
  }
}

/**
 * SPEC-022 BR-022-18 over SPEC-006 BR-006-07/08 — the ledger is sorted and
 * paged by its query, so every one of these is a server round trip whose state
 * has to be in the URL: a reload, a bookmark or a shared link must reproduce
 * the same page of the same order under the same filters.
 */
test.describe('the ledger table', () => {
  test('sorts, paginates and filters, with its state in the URL', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedThirty(userId);
    await seedLedger(userId);

    await page.goto('/transactions');
    // BR-006-07: newest first — the HGLG11 buy of 2026-03-01 leads.
    await expect(ledgerRows(page).first()).toContainText('HGLG11');
    await expect(ledgerRows(page)).toHaveCount(33);

    // A selectable page size (BR-022-18). One control first: while the table
    // re-suspends (`useSearchParams`), React shows DataTable's fallback — the
    // same table, at its default state — beside the hidden live one, and a
    // select on the fallback changes nothing.
    await expect(page.getByLabel('Itens por página')).toHaveCount(1);
    await page.getByLabel('Itens por página').selectOption('25');
    await expect(page).toHaveURL(/[?&]size=25(&|$)/);
    await expect(ledgerRows(page)).toHaveCount(25);
    await expect(page.getByText('Mostrando 1–25 de 33 transações')).toBeVisible();

    // Paging is a link to the next page of the query, not a slice of this one.
    await page
      .getByRole('navigation', { name: 'Paginação' })
      .getByRole('link', { name: 'Página 2' })
      .click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(ledgerRows(page)).toHaveCount(8);
    // The oldest BBAS3 buy, 2025-01-01 at R$ 10, is last of all.
    await expect(ledgerRows(page).last()).toContainText(/R\$\s10,00/);

    // Sorting re-queries the whole ledger and starts again from page 1.
    if (isMobile(page)) {
      // By role, which skips the hidden table's header links of the same name.
      await page.getByRole('combobox', { name: /^Ordenar por/ }).selectOption({ label: 'Total' });
      await expect(page).toHaveURL(/[?&]sort=totalValue%3Adesc(&|$)/);
      // The PETR4 buy, 100 × R$ 32,15, is the largest total of all.
      await expect(ledgerRows(page).first()).toContainText('PETR4');
    } else {
      await ledger(page).getByRole('link', { name: 'Ordenar por Total' }).click();
      await expect(page).toHaveURL(/[?&]sort=totalValue%3Aasc(&|$)/);
      await expect(ledgerRows(page).first()).toContainText(/R\$\s10,00/);
      await expect(
        ledger(page).getByRole('columnheader', { name: 'Ordenar por Total' }),
      ).toHaveAttribute('aria-sort', 'ascending');
    }
    await expect(page).not.toHaveURL(/[?&]page=/);

    // A filter keeps the table's sort and page size, and drops the page.
    await page.getByLabel('Buscar').fill('BBAS3');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page).toHaveURL(/[?&]q=BBAS3(&|$)/);
    await expect(page).toHaveURL(/[?&]size=25(&|$)/);
    await expect(page).toHaveURL(/[?&]sort=totalValue/);
    await expect(ledgerRows(page)).toHaveCount(25);
    await expect(page.getByText('Mostrando 1–25 de 30 transações')).toBeVisible();
    await expect(ledger(page).getByText('HGLG11')).toHaveCount(0);

    // The URL is the whole state: a reload reproduces it.
    const url = page.url();
    await page.reload();
    expect(page.url()).toBe(url);
    await expect(ledgerRows(page)).toHaveCount(25);
    await expect(page.getByLabel('Buscar')).toHaveValue('BBAS3');
    await expect(page.getByLabel('Itens por página')).toHaveValue('25');
  });

  /**
   * SPEC-022 BR-022-18 / BR-022-26 — a width per column, set by the table and
   * never by its content. A browser is the only thing that can say so: the
   * component tests have no layout.
   */
  test('sizes its columns by definition: the largest amount fits, text truncates, and hiding values moves nothing', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    test.skip(isMobile(page), 'the table rendering is desktop-only');
    await seedExtremes(userId);

    await page.goto('/transactions');
    const row = ledgerRow(page, 'EXTR3');
    const headerWidths = () =>
      ledger(page)
        .locator('thead th')
        .evaluateAll((cells) =>
          cells.map((cell) => Math.round(cell.getBoundingClientRect().width)),
        );
    const before = await headerWidths();

    // The widest figures fit their columns, on one line: not clipped, not wrapped.
    for (const [code, figure] of [
      ['EXTR3', 'R$ 999.999,99'],
      ['EXTR3', 'R$ 99.999.999,00'],
      ['EXTQ3', '1.234,12345678'],
    ] as const) {
      const cell = ledgerRow(page, code).getByRole('cell').filter({ hasText: figure });
      await expect(cell).toBeVisible();
      expect(await cell.evaluate((td) => td.scrollWidth <= td.clientWidth), figure).toBe(true);
      expect(
        await cell.evaluate((td) => td.querySelector('span')?.getClientRects().length),
        figure,
      ).toBe(1);
    }

    // BR-022-40: a broker name too long for its column ends in an ellipsis under
    // the asset, and the cell's full text opens on keyboard focus and on hover.
    const asset = row.locator('[data-slot="table-cell-text"]', { hasText: LONG_BROKER });
    const broker = asset.getByText(LONG_BROKER);
    expect(await broker.evaluate((line) => line.scrollWidth > line.clientWidth)).toBe(true);
    expect(await broker.evaluate((line) => getComputedStyle(line).textOverflow)).toBe('ellipsis');
    const tip = page.locator('[data-slot="popover-content"]');
    await asset.focus();
    await expect(tip).toHaveText(`EXTR3 ${LONG_BROKER}`);
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await asset.hover();
    await expect(tip).toHaveText(`EXTR3 ${LONG_BROKER}`);
    await page.mouse.move(0, 0);

    // BR-022-24: hiding the amounts changes no column's width.
    await page.getByRole('button', { name: 'Ocultar valores', exact: true }).click();
    await expect(page.getByText('R$ ••••••').first()).toBeVisible();
    expect(await headerWidths()).toEqual(before);

    // The columns add up to more than a narrow container: the table scrolls
    // inside its own wrapper, and the page never does (360px, and just above
    // the table breakpoint).
    for (const width of [768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `no horizontal page scroll at ${width}px`,
      ).toBe(true);
    }
  });

  /**
   * SPEC-022 BR-022-40 — Transações fits the page at 1280 px: eight columns and
   * the row menu, every cell at its widest, shown and hidden (BR-022-24). Also
   * 15 px narrower: headless Chromium hides its scrollbars, and a desktop
   * browser with classic scrollbars gives the page 1265 px at 1280.
   */
  test('fits the page at 1280 px without scrolling sideways, classic scrollbars included', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    test.skip(isMobile(page), 'the table rendering is desktop-only');
    await seedLedger(userId);
    await seedExtremes(userId);
    await page.setViewportSize({ width: 1265, height: 800 });

    await page.goto('/transactions');
    await expect(ledger(page).getByRole('columnheader')).toHaveText([
      'Selecionar transação',
      /Data/,
      /Ativo/,
      'Tipo',
      /Quantidade/,
      /Preço unitário/,
      /Total/,
      'Status',
      'Ações',
    ]);
    for (const hidden of [false, true]) {
      if (hidden) {
        await page.getByRole('button', { name: 'Ocultar valores', exact: true }).click();
        await expect(page.getByText('R$ ••••••').first()).toBeVisible();
      }
      const container = page.locator('[data-slot="table-container"]').filter({ visible: true });
      expect(
        await container.evaluate((element) => element.scrollWidth - element.clientWidth),
        `the ledger scrolls sideways${hidden ? ' (hidden)' : ''}`,
      ).toBeLessThanOrEqual(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  });

  /**
   * BR-022-40 — a row's actions are a "⋯" menu that works by keyboard; an
   * imported row links back to its batch (BR-006-02), and Excluir still goes
   * through the deletion's disclosure (BR-006-13).
   */
  test("a row's actions open from its menu by keyboard", async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const { batchId } = await seedLedger(userId);

    await page.goto('/transactions');
    // The manual row offers no import to go back to.
    await rowMenu(page, 'HGLG11').focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Editar', 'Excluir']);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(rowMenu(page, 'HGLG11')).toBeFocused();

    // An imported row does, in the frame's order.
    await rowMenu(page, 'PETR4').first().focus();
    await page.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Editar',
      'Ver importação de origem',
      'Excluir',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Ver importação de origem' })).toHaveAttribute(
      'href',
      new RegExp(batchId),
    );
    await page.keyboard.press('Escape');

    // Excluir, reached with the arrow keys, opens the disclosure and deletes nothing.
    await rowMenu(page, 'HGLG11').focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Excluir' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Excluir transação' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar exclusão' })).toBeVisible();
  });

  /**
   * #255 review — the institution sort has no column since BR-022-40, and the
   * query still orders by it. Its page links keep it, so the second page
   * continues the order the first one showed.
   */
  test('keeps a sort by institution from page to page', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedThirty(userId);
    await seedLedger(userId);

    await page.goto('/transactions?sort=institution%3Aasc&size=10');
    await expect(ledgerRows(page)).toHaveCount(10);
    await page
      .getByRole('navigation', { name: 'Paginação' })
      .getByRole('link', { name: 'Página 2' })
      .click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(page).toHaveURL(/[?&]sort=institution%3Aasc(&|$)/);
  });

  /**
   * #214 review F1 — a sort or a page keeps the ledger mounted. A tick belongs
   * to its transaction, so it must not reappear on whichever row now sits in
   * the same place: "Excluir selecionadas" deletes without asking again.
   */
  test('a ticked row does not follow its position to the next page', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedThirty(userId);

    await page.goto('/transactions?size=25');
    await ledgerRows(page).nth(2).getByRole('checkbox').check();
    await page
      .getByRole('navigation', { name: 'Paginação' })
      .getByRole('link', { name: 'Página 2' })
      .click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(ledgerRows(page)).toHaveCount(5);
    await expect(page.locator('input[name="selected"]:checked')).toHaveCount(0);
  });

  /**
   * PR #234 review P1 — the table and the cards each carry a row's checkbox.
   * A tick made at one width is the tick shown at the other, and a row
   * unticked on its card does not post from the hidden table.
   */
  test('a selection is the same in the table and the cards', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    test.skip(isMobile(page), 'starts at desktop width and narrows');
    await seedLedger(userId);

    await page.goto('/transactions');
    await ledgerRow(page, 'HGLG11').getByRole('checkbox').check();
    await page.setViewportSize({ width: 390, height: 844 });
    const card = ledgerRow(page, 'HGLG11');
    await expect(card.getByRole('checkbox')).toBeChecked();

    await card.getByRole('checkbox').uncheck();
    const posted = await page.evaluate(() =>
      new FormData(document.getElementById('transactions-bulk') as HTMLFormElement).getAll(
        'selected',
      ),
    );
    expect(posted).toEqual([]);
  });

  /**
   * PR #234 review P2 — "Limpar filtros" is a client navigation, and a
   * mounted uncontrolled select ignores a new default: Tipo kept showing the
   * cleared filter, and Aplicar re-applied it.
   */
  test('clearing filters resets the filter bar too', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedLedger(userId);

    await page.goto('/transactions?type=sell');
    await expect(page.getByLabel('Tipo')).toHaveValue('sell');
    await page.getByRole('link', { name: 'Limpar filtros' }).first().click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByLabel('Tipo')).toHaveValue('');

    await page.getByRole('button', { name: 'Aplicar' }).click();
    // A GET form posts its blank fields too (`type=`); what must not come back is the value.
    await expect(page).toHaveURL(/[?&]type=(&|$)/);
    await expect(ledger(page).getByText('HGLG11')).toHaveCount(1);
  });

  test('a page past the end of the ledger shows its last page', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedThirty(userId);

    await page.goto('/transactions?size=25&page=9');
    await expect(ledgerRows(page)).toHaveCount(5);
    await expect(
      page.getByRole('navigation', { name: 'Paginação' }).getByRole('link', { name: 'Página 2' }),
    ).toHaveAttribute('aria-current', 'page');
  });
});

// SPEC-022 frame 14: filter controls precede selection actions and ledger rows.
test('filters precede bulk actions inside the ledger panel', async ({ signedIn }) => {
  const { page, userId } = signedIn;
  await seedLedger(userId);
  await page.goto('/transactions');
  const panel = page.locator('[data-variant="panel"]');
  const filter = panel.locator('form[method="get"]');
  const bulk = panel.locator('form[id]');
  await expect(filter).toHaveCount(1);
  await expect(bulk).toHaveCount(1);
  const filterBox = await filter.boundingBox();
  const bulkBox = await bulk.boundingBox();
  expect(filterBox!.y + filterBox!.height).toBeLessThanOrEqual(bulkBox!.y);
});
