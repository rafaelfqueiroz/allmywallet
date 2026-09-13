import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/authenticated';
import { seedHoldings } from './support/holdings';
import { dismissOnboarding, seedCommittedImportBatch } from './support/onboarding';
import { seedHeldFixedIncomeWithMissingRate } from './support/fixed-income';

/**
 * #98 — the authenticated landing screen, over the real stack.
 *
 * TESTING §6's first journey is "sign in … → empty dashboard", and it could not
 * be written until there was a dashboard: `/` is the marketing page and sign-in
 * routed everyone to `/transactions`. The two halves asserted here are the ones
 * that would silently regress — that the landing is the dashboard (SPEC-001
 * BR-001-04), and that a first-run user meets an explanation rather than
 * R$ 0,00 (SPEC-020 BR-020-27).
 *
 * TS-25: user-visible outcomes only. The read model's own branches are
 * `src/core/dashboard/summary.test.ts` and `tests/integration/dashboard.test.ts`.
 *
 * **SPEC-020 BR-020-02 changed who reaches this page at all.** A signed-in
 * fresh tenant now redirects to `/onboarding` before this file's dashboard
 * ever renders — `tests/e2e/onboarding.spec.ts` is where that redirect and
 * the guided flow it leads to are asserted. Every test below is about the
 * dashboard itself, not about onboarding, so each one seeds whichever of the
 * two facts that stop the redirect (`dismissOnboarding` or
 * `seedCommittedImportBatch`, `support/onboarding.ts`) actually matches its
 * own intent — a committed import for "a returning user", a dismissal for
 * everything that is testing the dashboard's *own* empty state or its
 * populated rendering, per BR-020-14: "a dismissed guide with no import still
 * shows the dashboard empty state."
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

async function seedCommittedPosicaoBatch(
  userId: string,
  discrepancies: readonly unknown[],
): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status, uploaded_at, committed_at, reconciliation)
       VALUES ($1, $2, 'b3_posicao', 'committed', now(), now(), $3::jsonb)`,
      [
        randomUUID(),
        userId,
        JSON.stringify({
          asOf: new Date().toISOString().slice(0, 10),
          status: discrepancies.length === 0 ? 'reconciled' : 'discrepancies_found',
          discrepancies,
        }),
      ],
    );
  } finally {
    await pool.end();
  }
}

test.describe('the dashboard', () => {
  /**
   * SPEC-001 BR-001-04 — the landing. Asserted through the redirect a signed-in
   * visitor to `/` actually gets (`src/middleware.ts`), because that is the same
   * destination `signIn()` is configured with and the only half of the OAuth
   * flow this suite can drive (TS-26, and `support/authenticated.ts`'s header on
   * why the handshake itself cannot be tested here).
   *
   * A *returning* user (SPEC-020 BR-020-03: a committed import), so the claim
   * under test — "not the ledger" — is not confounded with BR-020-02's
   * separate first-run redirect to `/onboarding`, which
   * `onboarding.spec.ts`'s own root-redirect test covers.
   */
  test('a signed-in visitor to the root lands on the dashboard, not the ledger', async ({
    signedIn,
  }) => {
    await seedCommittedImportBatch(signedIn.userId);
    await signedIn.page.goto('/');

    await expect(signedIn.page).toHaveURL(/\/dashboard$/);
    await expect(signedIn.page.getByRole('heading', { level: 1, name: 'Painel' })).toBeVisible();
  });

  /**
   * SPEC-020 BR-020-27 — "a portfolio displayed as R$ 0,00 is a false claim; an
   * empty state is the truth." The assertion is deliberately on the **absence**
   * of a figure as well as the presence of the explanation: a page that rendered
   * both would pass a presence-only check.
   *
   * It counts `Money` elements rather than searching for the string "R$ 0,00",
   * which is both stronger and the only version that can pass — the empty
   * state's own copy explains *why* no zero is shown and therefore contains the
   * words. `[data-slot="money"]` is every monetary figure on the page, so zero
   * of them is the real claim: nothing on this screen states an amount.
   */
  test('a first-run user meets an explanation, and no figure at all', async ({ signedIn }) => {
    // BR-020-14 — a dismissed guide with no import still shows this exact
    // empty state; a fresh, non-dismissed visit is BR-020-02's onboarding
    // redirect instead, asserted in `onboarding.spec.ts`.
    await dismissOnboarding(signedIn.userId);
    await signedIn.page.goto('/dashboard');

    await expect(signedIn.page.getByRole('status').first()).toBeVisible();
    await expect(signedIn.page.locator('[data-slot="money"]')).toHaveCount(0);
    await expect(
      signedIn.page.getByRole('link', { name: 'Importar meu primeiro extrato' }),
    ).toBeVisible();
  });

  /**
   * BR-005-27 / BR-008-04 — "every screen showing portfolio value displays the
   * valuation as-of date and the date of the most recent custody import", and
   * "the product never implies real-time".
   */
  test('shows the value with its dates and delay tier', async ({ signedIn }) => {
    // 10 × R$ 25,00 = R$ 250,00, hand-computed so the assertion is on a figure
    // rather than on "some money appeared".
    await seedHoldings(signedIn.userId, [
      { code: 'DASH', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    // BR-020-02 — this tenant never imported (the holding was seeded directly
    // into the position cache), so without a dismissal it would redirect to
    // `/onboarding` before any of this screen rendered.
    await dismissOnboarding(signedIn.userId);

    await signedIn.page.goto('/dashboard');

    await expect(signedIn.page.getByText('R$ 250,00')).toBeVisible();
    await expect(signedIn.page.getByText(/nunca em tempo real/)).toBeVisible();

    /*
     * BR-016-18 — `dd/mm/yyyy`, never the ISO string the date is stored as.
     * Asserted as a pattern rather than a fixed date because the page renders
     * *today*; the shape is the rule, and a `BusinessDate` interpolated raw
     * into an ICU message renders `2026-09-12`, which this rejects.
     */
    await expect(signedIn.page.getByText(/Valores de \d{2}\/\d{2}\/\d{4}/)).toBeVisible();
    await expect(signedIn.page.getByText(/Valores de \d{4}-\d{2}-\d{2}/)).toHaveCount(0);
  });

  /**
   * SPEC-010 BR-010-12 — a purchase awaiting allocation appears on the dashboard
   * until resolved. The seeded holding belongs to no wallet, which is exactly
   * the `no_wallet` case.
   */
  test('surfaces a holding awaiting allocation in the needs-attention queue', async ({
    signedIn,
  }) => {
    const [code] = await seedHoldings(signedIn.userId, [
      { code: 'PEND', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await dismissOnboarding(signedIn.userId);

    await signedIn.page.goto('/dashboard');

    await expect(
      signedIn.page.getByRole('heading', { name: 'Precisa da sua atenção' }),
    ).toBeVisible();
    await expect(signedIn.page.getByText(code!)).toBeVisible();
    await expect(signedIn.page.getByText('Nenhuma carteira reivindicou este ativo.')).toBeVisible();
  });

  /**
   * SPEC-020 BR-020-16/18/19 — the third "Needs attention" kind #97 added: a
   * held fixed-income contract whose rate could not be read. Every gate has
   * to state its cause, its consequence, and a link to the one screen that
   * resolves it (`describeGate`) — asserted here against the rendered queue,
   * not only in `core/onboarding/gates.test.ts`, because the mapping from
   * `GateResolution` to a route lives in `AttentionQueue.tsx` itself
   * (`core/` never names routes) and has no other test that can see it.
   */
  test('shows the fixed-income rate gate with its consequence and a link to the rate form', async ({
    signedIn,
  }) => {
    const { assetId, code } = await seedHeldFixedIncomeWithMissingRate(signedIn.userId, 'CDBQ');
    await dismissOnboarding(signedIn.userId);

    await signedIn.page.goto('/dashboard');

    await expect(
      signedIn.page.getByRole('heading', { name: 'Precisa da sua atenção' }),
    ).toBeVisible();
    // The cause: which asset.
    await expect(signedIn.page.getByText(code)).toBeVisible();
    // BR-020-19 — the consequence, stated plainly.
    await expect(
      signedIn.page.getByText(/patrimônio acima está subestimado até você informá-la/),
    ).toBeVisible();
    // The resolution: one link, to the one screen that fixes it.
    const link = signedIn.page.getByRole('link', { name: 'Informar taxa' });
    await expect(link).toHaveAttribute('href', `/fixed-income/${assetId}`);

    await link.click();
    await expect(signedIn.page).toHaveURL(`/fixed-income/${assetId}`);
    await expect(signedIn.page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  /**
   * SPEC-005 BR-005-26 — the three states, and the one that only exists on this
   * screen. `never_reconciled` is not a value any import writes; it is the
   * absence of one, and the rule names it because "we have never checked" and
   * "we checked and it agreed" are opposite assurances.
   */
  test('states the reconciliation status in words, not by colour alone', async ({ signedIn }) => {
    await seedHoldings(signedIn.userId, [
      { code: 'RECO', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    // Not yet a committed batch at this point (that happens below), so a
    // dismissal is what keeps this first `goto` off the onboarding redirect.
    await dismissOnboarding(signedIn.userId);

    await signedIn.page.goto('/dashboard');
    await expect(signedIn.page.getByText('Nunca conferido')).toBeVisible();

    await seedCommittedPosicaoBatch(signedIn.userId, []);
    await signedIn.page.reload();

    // BR-016-16: the badge's meaning is carried by its text, so this assertion
    // is the same one a screen-reader user would make.
    await expect(signedIn.page.getByText('Confere com a B3')).toBeVisible();
    // BR-016-18 again, on the Posição date beside the badge.
    await expect(signedIn.page.getByText(/Posição de \d{2}\/\d{2}\/\d{4}/)).toBeVisible();
  });

  /** TS-27 / BR-016-15 — axe on the populated page, in a real browser. */
  test('has no accessibility violations when populated', async ({ signedIn }) => {
    await seedHoldings(signedIn.userId, [
      { code: 'AXE', quantity: '10', averageCost: '20.00', price: '25.00' },
    ]);
    await seedCommittedPosicaoBatch(signedIn.userId, []);

    await signedIn.page.goto('/dashboard');

    const results = await new AxeBuilder({ page: signedIn.page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  /**
   * BR-016-15's keyboard-only pass. The skip link is the first stop, and the
   * dashboard's own first action has to be reachable from it without a mouse —
   * on the screen a user lands on, that is the whole product's front door.
   */
  test('is navigable by keyboard alone', async ({ signedIn }) => {
    // BR-020-02 — otherwise a fresh, non-dismissed visit redirects to
    // `/onboarding` before this screen renders at all; that keyboard pass is
    // `onboarding.spec.ts`'s own.
    await dismissOnboarding(signedIn.userId);
    await signedIn.page.goto('/dashboard');

    await signedIn.page.keyboard.press('Tab');
    await expect(signedIn.page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();

    const action = signedIn.page.getByRole('link', { name: 'Importar meu primeiro extrato' });
    await action.focus();
    await expect(action).toBeFocused();
    await signedIn.page.keyboard.press('Enter');
    await expect(signedIn.page).toHaveURL(/\/import$/);
  });
});
