import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';

/**
 * SPEC-018 — Observar preços, over the real stack.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MOVES THE QUOTE RATHER THAN THE RULE
 *
 * The journey the spec asks for is "configure a rule, cross a threshold, see
 * the badge and the state change" — and the *crossing* is the part worth
 * driving through a browser, because it is the only one that proves the two
 * halves of BR-018-14 agree: the state on screen is computed from the same
 * stored quote every other screen prices from, so a price that moves in
 * `latest_quotes` moves the badge and nothing else has to be told.
 *
 * Editing the rule's own bounds would produce the same visible change and
 * prove nothing of the sort — it would only show that a form writes what it
 * was given. So the rule is created once through the real form (which is also
 * what exercises BR-018-05..08's validation and `createRule`'s server-side
 * eligibility check), and then the *price* moves, exactly as a quote poll
 * would move it.
 *
 * TS-26: no live provider. `latest_quotes` is written directly, which is
 * precisely what `quotes.poll` does — this asserts the read path, not the
 * fetch path, and the fetch path has no business being reachable from a
 * browser test.
 * ---------------------------------------------------------------------------
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

/** Moves the stored quote, the way a poll would. BR-008-04's two timestamps stay honest. */
async function movePrice(code: string, price: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `UPDATE latest_quotes
          SET price = $2, quoted_at = now() - interval '30 minutes', fetched_at = now()
        WHERE asset_id = (SELECT id FROM assets WHERE code = $1)`,
      [code, price],
    );
  } finally {
    await pool.end();
  }
}

test.describe('SPEC-018 — Observar preços', () => {
  test('a rule the user writes, and a price that crosses it', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    // One watchable holding priced comfortably between the bounds set below,
    // plus a CDB, which BR-018-02 says can never carry a rule.
    const [stockCode] = await seedHoldings(userId, [
      { code: 'PETR', quantity: '100', averageCost: '28.00', price: '32.00' },
    ]);
    if (stockCode === undefined) throw new Error('seedHoldings returned no code');

    await page.goto('/watch');

    // BR-018-15 — the delay disclosure is on the screen where rules are
    // configured, not buried in a help page. This is its own acceptance
    // criterion, so it is asserted before anything else.
    await expect(page.getByText(/atraso de cerca de/i)).toBeVisible();

    // BR-018-01/02 — an asset with no rule yet offers a form.
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Criar regra' }) })
      .first();
    await expect(form).toBeVisible();

    // BR-018-05/06/07 — both bounds, each with the user's own chosen meaning,
    // and a default band between them.
    await form.getByLabel('Limite inferior (R$)').fill('30,00');
    await form.getByLabel('Abaixo deste limite, o preço significa').selectOption('buy');
    await form.getByLabel('Limite superior (R$)').fill('40,00');
    await form.getByLabel('Acima deste limite, o preço significa').selectOption('sell');
    await form.getByLabel('Entre os dois limites, o preço significa').selectOption('hold');
    await form.getByRole('button', { name: 'Criar regra' }).click();

    // R$ 32,00 sits between the two bounds, so the default band applies.
    // The watch screen renders its rules as a list, not a table — one rule is
    // a small block of prose and two bounds, not a row of comparable figures.
    const watched = page.getByRole('listitem').filter({ hasText: stockCode });
    // The badge itself, not merely the word: the edit form's own <option>
    // elements carry the same three labels, and matching those would let this
    // pass against a rule whose state never rendered at all. BR-018-17 also
    // wants the badge asserted to carry *text*, which is what reading its
    // content — rather than its colour or its `data-state` — does.
    const badge = watched.locator('[data-slot="state-badge"]');
    await expect(badge).toHaveText('manutenção');

    // BR-018-12 — the price crosses the lower bound. Exactly on it, which is
    // the boundary the domain treats as reached rather than pending.
    await movePrice(stockCode, '30.00');
    await page.reload();
    await expect(badge).toHaveText('compra');

    // BR-018-19 — the same state, as a badge in the holdings list.
    //
    // Asserted as "the holding is listed, and a badge on this page reads
    // compra" rather than by scoping to the holding's own row: the holdings
    // table renders as a table on desktop and as cards on mobile, and this
    // journey runs in both projects. Scoping to `row` passes on one and finds
    // nothing on the other. The tenant has exactly one watched asset, so the
    // pair of assertions below is unambiguous about which badge this is.
    await page.goto('/reports/composition');
    //
    // `filter({ visible: true })` is load-bearing: the table and the cards are
    // both in the DOM at every width, with CSS deciding which one is shown, so
    // an unfiltered `.first()` picks whichever the *desktop* markup renders
    // first and then fails as hidden on mobile.
    await expect(page.getByText(stockCode).filter({ visible: true }).first()).toBeVisible();
    await expect(
      page
        .locator('[data-slot="state-badge"]')
        .filter({ hasText: 'compra' })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  test('a CDB says it has no market price to watch, and offers no form', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    // BR-018-02 / AC-2. Seeded as a CDB directly: `seedHoldings` writes every
    // asset as a stock, which is the eligible case this needs the opposite of.
    const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
    const code = `CDBE2E${Date.now().toString().slice(-6)}`;
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (id, code, name, class) VALUES (gen_random_uuid(), $1, $2, 'cdb') RETURNING id`,
        [code, `CDB ${code}`],
      );
      const assetId = rows[0]?.id;
      if (assetId === undefined) throw new Error('asset insert returned no id');
      await pool.query(
        `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
         VALUES (gen_random_uuid(), $1, $2, '1', '1000', '1000', 0)`,
        [userId, assetId],
      );
    } finally {
      await pool.end();
    }

    await page.goto('/watch');

    const row = page.getByRole('listitem').filter({ hasText: code });
    await expect(row.getByText(/não tem preço de mercado/i)).toBeVisible();
  });

  test('has no accessibility violations', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedHoldings(userId, [
      { code: 'VALE', quantity: '50', averageCost: '60.00', price: '65.00' },
    ]);
    await page.goto('/watch');
    await expect(page.getByRole('heading', { name: 'Observar preços' })).toBeVisible();

    // TS-27 / SPEC-016 BR-016-15 — and DL-018-06 specifically: the states are
    // colour *and* label, so a contrast or name failure here is the acceptance
    // criterion failing, not a cosmetic nit.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
