import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding } from './support/onboarding';
import { dataTableByCaption, expectPageSizeSurvivesReload } from './support/page-size';

/**
 * SPEC-018 — Observar preços, over the real stack: Configurações › Observar
 * preços (SPEC-022 BR-022-05, #212), and the Painel's watch-state card
 * (BR-022-07).
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

/** A rule written straight to the table, as `hide-values.spec.ts` seeds one. */
async function seedRule(
  code: string,
  lowerBound: string,
  lowerState: 'buy' | 'sell',
): Promise<string> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string; user_id: string }>(
      `SELECT a.id, p.user_id FROM assets a JOIN positions p ON p.asset_id = a.id WHERE a.code = $1`,
      [code],
    );
    const held = rows[0];
    if (held === undefined) throw new Error(`no holding for ${code}`);
    await pool.query(
      `INSERT INTO opportunity_rules (id, user_id, asset_id, lower_bound, lower_state, default_state)
       VALUES ($1, $2, $3, $4, $5, 'hold')`,
      [randomUUID(), held.user_id, held.id, lowerBound, lowerState],
    );
    return held.id;
  } finally {
    await pool.end();
  }
}

/** The rows of a table, as the one shown: a table row from md up, a card below. */
function rows(page: Page, caption: string) {
  return dataTableByCaption(page, caption).locator('tr:visible, li:visible');
}

/** Twelve holdings, one over a page of ten, with codes that sort in seeding order. */
function manyHoldings(prefix: string) {
  return Array.from({ length: 12 }, (_, index) => ({
    code: `${prefix}${String(index + 1).padStart(2, '0')}`,
    quantity: '10',
    averageCost: '20.00',
    price: '25.00',
  }));
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

    await page.goto('/settings/watch');

    // BR-018-15 — the delay disclosure is on the screen where rules are
    // configured, not buried in a help page. This is its own acceptance
    // criterion, so it is asserted before anything else.
    await expect(page.getByText(/atraso de cerca de/i)).toBeVisible();

    // BR-018-01/02 — an asset with no rule yet offers a rule. SPEC-022 BR-022-18:
    // the available assets are a table, and no form sits in a table's cell, so
    // the row's "Criar regra" opens the one rule editor, and the form is there.
    await page.getByRole('link', { name: `Criar regra de ${stockCode}` }).click();
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Criar regra' }) })
      .first();
    await expect(form).toBeVisible();

    // BR-018-05/06/07 — both bounds, each with the user's own chosen meaning,
    // and a default band between them.
    await form.getByLabel('Limite inferior (R$)').fill('30,00');
    await form.getByLabel('Neste limite ou abaixo dele, o preço significa').selectOption('buy');
    await form.getByLabel('Limite superior (R$)').fill('40,00');
    await form.getByLabel('Neste limite ou acima dele, o preço significa').selectOption('sell');
    await form.getByLabel('Entre os dois limites, o preço significa').selectOption('hold');
    await form.getByRole('button', { name: 'Criar regra' }).click();

    // R$ 32,00 sits between the two bounds, so the default band applies.
    // The rule is a row of the rules table (a table row from md up, a card below).
    const watched = rows(page, 'Regras de observação').filter({ hasText: stockCode });
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
    await page.goto('/portfolio/composition');
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

    await page.goto('/settings/watch');

    const row = rows(page, 'Sem preço de mercado').filter({ hasText: code });
    await expect(row.getByText(/não tem preço de mercado/i)).toBeVisible();

    // The other half of AC-2, and the half worth having: the message is only
    // honest if there is genuinely no way to configure a rule from here.
    await expect(row.getByRole('button', { name: 'Criar regra' })).toHaveCount(0);
    await expect(row.getByLabel('Limite inferior (R$)')).toHaveCount(0);
  });

  test('has no accessibility violations', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    await seedHoldings(userId, [
      { code: 'VALE', quantity: '50', averageCost: '60.00', price: '65.00' },
    ]);
    await page.goto('/settings/watch');
    await expect(page.getByRole('heading', { name: 'Observar preços' })).toBeVisible();

    // TS-27 / SPEC-016 BR-016-15 — and DL-018-06 specifically: the states are
    // colour *and* label, so a contrast or name failure here is the acceptance
    // criterion failing, not a cosmetic nit.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  /**
   * SPEC-022 BR-022-07 — the Painel lists held assets in a buy or sell state,
   * each linking to its rule. Two holdings: one under its buy bound, and one
   * whose rule reads hold, which the card must leave out.
   */
  test('a rule in a buy state is on the Painel, and links to its rule', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const [buyCode, holdCode] = await seedHoldings(userId, [
      { code: 'ITSA', quantity: '100', averageCost: '9.00', price: '10.86' },
      { code: 'WEGE', quantity: '10', averageCost: '40.00', price: '52.17' },
    ]);
    if (buyCode === undefined || holdCode === undefined) {
      throw new Error('seedHoldings returned no code');
    }
    const assetId = await seedRule(buyCode, '11.00', 'buy');
    await seedRule(holdCode, '30.00', 'sell');
    await dismissOnboarding(userId);

    await page.goto('/dashboard');
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Em zona de compra ou venda' }) });
    const line = card.getByRole('listitem').filter({ hasText: buyCode });
    // DL-018-06 — the state is a label, not only a colour.
    await expect(line.locator('[data-slot="state-badge"]')).toHaveText('compra');
    await expect(line).toContainText('seu limite de compra de');
    await expect(card.getByRole('listitem').filter({ hasText: holdCode })).toHaveCount(0);

    await card.getByRole('link', { name: `Ver regra de ${buyCode}` }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/watch#regra-${assetId}$`));
    await expect(page.locator(`[id="regra-${assetId}"]`)).toContainText(buyCode);
    // SPEC-022 BR-022-07 — the rule the link names is marked on arrival, in
    // whichever rendering is shown (the table row, or its card below md).
    await expect(
      page
        .locator(`[id="regra-${assetId}"], [id="regra-${assetId}-card"]`)
        .filter({ visible: true }),
    ).toHaveAttribute('data-linked', 'true');
  });

  /**
   * SPEC-022 BR-018-18 — the rules are a table that pages, with its page size
   * in the URL, and a link to a rule on a later page still lands on it: the
   * Painel's "Ver regra" and an e-mail sent before this table paged carry the
   * anchor alone.
   */
  test('the rules page, and keep the page size through a reload', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const codes = await seedHoldings(userId, manyHoldings('RUL'));
    for (const code of codes) await seedRule(code, '30.00', 'buy');

    await page.goto('/settings/watch');
    await expectPageSizeSurvivesReload(page, 'Regras de observação', 'rules', 12);
  });

  test('a link to a rule on a later page lands on it, marked', async ({ signedIn }) => {
    const { page, userId } = signedIn;
    const codes = await seedHoldings(userId, manyHoldings('LNK'));
    // Rules sort by asset, so the last one seeded is on the second page.
    let lastId = '';
    for (const code of codes) lastId = await seedRule(code, '30.00', 'buy');
    const last = codes[codes.length - 1]!;

    await page.goto(`/settings/watch#regra-${lastId}`);

    const table = dataTableByCaption(page, 'Regras de observação');
    await expect(table.getByText(/Mostrando 11–12 de 12/)).toBeVisible();
    const target = table
      .locator(`[id="regra-${lastId}"], [id="regra-${lastId}-card"]`)
      .filter({ visible: true });
    await expect(target).toContainText(last);
    await expect(target).toHaveAttribute('data-linked', 'true');
    await expect(target).toBeInViewport();
  });

  /**
   * A rule's controls hold no form: Silenciar and Excluir are buttons joined to
   * forms outside the table, and Editar is a link to the editor.
   */
  test('a row’s controls mute, edit and delete without a form in the table', async ({
    signedIn,
  }) => {
    const { page, userId } = signedIn;
    const [code] = await seedHoldings(userId, [
      { code: 'CTRL', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    const assetId = await seedRule(code!, '30.00', 'buy');

    await page.goto('/settings/watch');
    const table = dataTableByCaption(page, 'Regras de observação');
    await expect(table.locator('form')).toHaveCount(0);

    // Silenciar: the badge says so.
    await page.getByRole('button', { name: `Silenciar avisos de ${code}` }).click();
    await expect(
      rows(page, 'Regras de observação').filter({ hasText: code! }).getByText('Silenciado'),
    ).toBeVisible();

    // Editar opens the editor for this rule, and Fechar closes it.
    await page.getByRole('link', { name: `Editar regra de ${code}` }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]rule=${assetId}`));
    await expect(
      page.getByRole('heading', { name: new RegExp(`^Editar regra de ${code}`) }),
    ).toBeVisible();
    await expect(page.getByLabel('Limite inferior (R$)')).toHaveValue(/^30(\.0+)?$/);
    await page.getByRole('link', { name: 'Fechar' }).click();
    await expect(page.getByLabel('Limite inferior (R$)')).toHaveCount(0);

    // Excluir.
    await page.getByRole('button', { name: `Excluir regra de ${code}` }).click();
    await expect(
      page.getByText('Você ainda não configurou nenhuma regra de observação.'),
    ).toBeVisible();
  });

  test('Configurações lists Observar preços in its sub-navigation, and the sidebar no longer does', async ({
    signedIn,
    viewport,
  }) => {
    const { page } = signedIn;
    await page.goto('/settings/watch/parameters');

    // BR-022-13 — the e-mail cooldown is the section's Parâmetros tab.
    await expect(
      page.getByLabel('Intervalo mínimo entre e-mails (horas)', { exact: true }),
    ).toBeVisible();
    const subNav = page.getByRole('navigation', { name: 'Seções de Configurações' });
    await expect(subNav.getByRole('link', { name: 'Observar preços' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    if ((viewport?.width ?? 0) >= 768) {
      const sidebar = page.getByRole('navigation', { name: 'Navegação' });
      await expect(sidebar.getByRole('link', { name: 'Observar preços' })).toHaveCount(0);
    }
  });
});
