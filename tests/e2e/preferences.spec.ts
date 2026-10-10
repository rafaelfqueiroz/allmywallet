import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from './support/authenticated';

/**
 * SPEC-002 preferences, reached with a real session (SPEC-001 BR-001-08,
 * AR-12). Until this journey `/preferences` resolved its user through a
 * SPEC-001-era stub that threw unconditionally: every signed-in account saw
 * the signed-out state, and every save threw. `screens.spec.ts` visits the
 * route signed-out, where the stub and the real helper render the same thing,
 * so nothing could tell them apart.
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

const SIGNED_OUT = 'Entre na sua conta para ajustar preferências.';
const CONCENTRATION = 'Limite de concentração (%)';

/**
 * A stored user-level override, inserted directly: the journey proves the
 * page *reads* the account's own row, so the row must exist before the page
 * has had any chance to write one.
 */
async function seedOverride(userId: string, key: string, value: unknown): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO config_overrides (id, key, level, user_id, value)
       VALUES ($1, $2, 'user', $3, $4)`,
      [randomUUID(), key, userId, JSON.stringify(value)],
    );
  } finally {
    await pool.end();
  }
}

test('a signed-in user sees their stored preferences and a saved change survives a reload', async ({
  signedIn,
}) => {
  const { page, userId } = signedIn;
  await seedOverride(userId, 'reports.concentration_threshold_pct', 37);

  await page.goto('/preferences');

  await expect(page.getByText(SIGNED_OUT)).toHaveCount(0);
  const field = page.getByLabel(CONCENTRATION, { exact: true });
  await expect(field).toHaveValue('37');

  await field.fill('42');
  const form = page.locator('form').filter({ has: field });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/preferences',
    ),
    form.getByRole('button', { name: 'Salvar' }).click(),
  ]);

  await page.reload();
  await expect(page.getByLabel(CONCENTRATION, { exact: true })).toHaveValue('42');
});

/**
 * SPEC-022 BR-022-13 / DL-022-10 — Preferências holds personal preferences
 * only; each feature parameter renders on its feature's screen instead, through
 * the same parameter form. The labels are the catalogue's
 * (`parameters.keys.*`), which is what a person reads.
 */
const FEATURE_PARAMETERS = [
  { label: 'Dias sem importar até avisar', screen: '/import' },
  { label: 'Tolerância de desvio (p.p.)', screen: '/wallets' },
  { label: 'Intervalo mínimo entre e-mails (horas)', screen: '/watch' },
] as const;

test('Preferências shows no feature parameter; each renders on its feature screen', async ({
  signedIn,
}) => {
  const { page } = signedIn;

  await page.goto('/preferences');
  await expect(page.getByLabel(CONCENTRATION, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tema', { exact: true })).toBeVisible();
  for (const { label } of FEATURE_PARAMETERS) {
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  }

  for (const { label, screen } of FEATURE_PARAMETERS) {
    await page.goto(screen);
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: 'Parâmetros' }) });
    await expect(section.getByLabel(label, { exact: true })).toBeVisible();
  }
});

test('a feature parameter saved on its screen survives a reload', async ({ signedIn }) => {
  const { page } = signedIn;
  const label = 'Tolerância de desvio (p.p.)';

  await page.goto('/wallets');
  const field = page.getByLabel(label, { exact: true });
  await field.fill('2.5');
  const form = page.locator('form').filter({ has: field });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/wallets',
    ),
    form.getByRole('button', { name: 'Salvar' }).click(),
  ]);

  await page.reload();
  await expect(page.getByLabel(label, { exact: true })).toHaveValue('2.5');
});
