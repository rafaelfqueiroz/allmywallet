import { expect, test, type Page } from '@playwright/test';
import {
  attachSession,
  dropSeededUser,
  seedSession,
  seedSessionFor,
  sessionExists,
} from './support/authenticated';

/**
 * SPEC-022 BR-022-09/10/11/30 — the account menu in the top bar, with a real
 * database session behind it (`support/authenticated.ts` explains why a seeded
 * session is the complete authenticated state, not an approximation).
 *
 * Each journey seeds its own account and drops it afterwards, because several
 * of them end the session they started with.
 */

const BASE = 'http://localhost:3000';

async function sessionUser(page: Page): Promise<unknown> {
  const response = await page.request.get('/api/auth/session');
  const body = (await response.json()) as { user?: unknown } | null;
  return body?.user;
}

const openMenu = async (page: Page) => {
  await page.getByRole('button', { name: /Menu da conta/ }).click();
  return page.getByRole('menu');
};

/**
 * BR-022-11 / BR-001-07 — "Sair works from every authenticated screen.
 * Afterwards, the old session cookie is refused by the server." Two different
 * screens, so a menu wired into one page's layout and not another's fails.
 */
for (const screen of ['/dashboard', '/transactions']) {
  test(`Sair from ${screen} ends the session on the server`, async ({ page, context, baseURL }) => {
    const { userId, sessionToken } = await seedSession();
    try {
      await attachSession(context, sessionToken, baseURL ?? BASE);
      await page.goto(screen);
      expect(await sessionUser(page)).toBeDefined();

      const menu = await openMenu(page);
      await menu.getByRole('menuitem', { name: 'Sair' }).click();

      await expect(page).toHaveURL(/\/signin$/);
      expect(await sessionExists(sessionToken)).toBe(false);

      // Replaying the captured cookie finds nothing to resume.
      await attachSession(context, sessionToken, baseURL ?? BASE);
      expect(await sessionUser(page)).toBeUndefined();
    } finally {
      await dropSeededUser(userId);
    }
  });
}

/**
 * BR-022-11 — "a GET request alone never signs the user out." Auth.js's own
 * `GET /api/auth/signout` renders a confirmation page; and the menu offers no
 * link a prefetch could follow, which the component test asserts.
 */
test('a GET request never signs anyone out', async ({ page, context, baseURL }) => {
  const { userId, sessionToken } = await seedSession();
  try {
    await attachSession(context, sessionToken, baseURL ?? BASE);

    await page.request.get('/api/auth/signout');
    await page.request.get('/api/auth/signout?callbackUrl=%2Fsignin');
    await page.goto('/dashboard');

    expect(await sessionExists(sessionToken)).toBe(true);
    expect(await sessionUser(page)).toBeDefined();
  } finally {
    await dropSeededUser(userId);
  }
});

/**
 * BR-022-09 / BR-001-05 — the Google name, e-mail and picture; and DS-20 —
 * the whole menu is operable from the keyboard.
 */
test('shows the Google profile and operates by keyboard', async ({ page, context, baseURL }) => {
  // A data URI, so the journey never reaches Google.
  const picture =
    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/%3E';
  const { userId, sessionToken } = await seedSession('ana.ribeiro@exemplo.test', {
    name: 'Ana Ribeiro',
    imageUrl: picture,
  });
  try {
    await attachSession(context, sessionToken, baseURL ?? BASE);
    await page.goto('/dashboard');

    const trigger = page.getByRole('button', { name: /Menu da conta/ });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Ana Ribeiro')).toBeVisible();
    await expect(menu.getByText('ana.ribeiro@exemplo.test')).toBeVisible();
    await expect(menu.locator('img')).toHaveAttribute('src', picture);

    await expect(menu.getByRole('menuitem', { name: 'Conta' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Preferências' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // And from the keyboard to a destination: Conta shows the same profile.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Conta' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Conta' })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Ana Ribeiro')).toBeVisible();
    await expect(main.getByText('ana.ribeiro@exemplo.test')).toBeVisible();
    await expect(main.locator('img')).toHaveAttribute('src', picture);
    await expect(page.getByRole('link', { name: 'Ir para Privacidade' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  } finally {
    await dropSeededUser(userId);
  }
});

/**
 * BR-022-30 — "the theme switch takes effect without a reload, and the choice
 * survives a new session." The second half uses a fresh browser context with
 * a new session for the same account: no localStorage from the first, so the
 * only way it can come up dark is the account's stored `ui.theme`.
 */
test('the theme switch applies without a reload and follows the account', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const { userId, sessionToken } = await seedSession();
  try {
    await attachSession(context, sessionToken, baseURL ?? BASE);
    await page.goto('/dashboard');
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });

    const menu = await openMenu(page);
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'),
      menu.getByRole('menuitemradio', { name: 'Escuro' }).click(),
    ]);

    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(menu.getByRole('menuitemradio', { name: 'Escuro' })).toBeChecked();
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);

    const second = await browser.newContext(baseURL ? { baseURL } : {});
    try {
      await attachSession(second, await seedSessionFor(userId), baseURL ?? BASE);
      const elsewhere = await second.newPage();
      await elsewhere.goto('/dashboard');
      await expect(elsewhere.locator('html')).toHaveClass(/\bdark\b/);

      const reopened = await openMenu(elsewhere);
      await expect(reopened.getByRole('menuitemradio', { name: 'Escuro' })).toBeChecked();
    } finally {
      await second.close();
    }
  } finally {
    await dropSeededUser(userId);
  }
});
