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
  const field = page.getByLabel(CONCENTRATION);
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
  await expect(page.getByLabel(CONCENTRATION)).toHaveValue('42');
});
