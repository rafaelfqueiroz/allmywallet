import { NAV_ITEMS } from '@/components/patterns/nav-items';
import { expect, test } from './support/authenticated';
import { dismissOnboarding } from './support/onboarding';

/**
 * SPEC-022 BR-022-14 and BR-022-33, measured on the rendered pages rather than
 * read from the source: the 2026-10-09 walkthrough found Relatórios starting
 * about 426px from the edge and Dashboard about 574px, and an active menu item
 * that was a blue outline on one page and a grey fill on another. Both were
 * invisible to every test that asserted *what* a page shows.
 */

const ACCOUNT_PAGES = ['/account', '/preferences', '/privacy'];
const DESTINATIONS = [...NAV_ITEMS.map((item) => item.href), ...ACCOUNT_PAGES];

/** The properties that make up "how the active item looks". */
const ACTIVE_LOOK = [
  'background-color',
  'color',
  'font-weight',
  'border-radius',
  'padding-left',
  'outline-style',
  'box-shadow',
] as const;

test.describe('the application frame', () => {
  /**
   * SPEC-022 BR-022-01 (amended, DL-022-16, #243) — exactly five destinations,
   * in this order, and the landing one is "Dashboard", no longer "Painel".
   */
  test('the sidebar lists Dashboard, Portfólio, Relatórios, Transações, Configurações', async ({
    signedIn,
    viewport,
  }) => {
    test.skip(!viewport || viewport.width < 768, 'the sidebar is the desktop rendering');
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    await page.goto('/dashboard');

    const menu = page
      .locator('[data-slot="app-sidebar"]')
      .getByRole('navigation', { name: 'Navegação' });
    await expect(menu.getByRole('link')).toHaveText([
      'Dashboard',
      'Portfólio',
      'Relatórios',
      'Transações',
      'Configurações',
    ]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  });

  test('every destination starts at the same left edge with the same width', async ({
    signedIn,
    viewport,
  }) => {
    const { page, userId } = signedIn;
    await dismissOnboarding(userId);
    // Wide enough for the maximum width to bind, which is where pages used
    // to diverge; on a phone, the viewport's own width.
    if (viewport && viewport.width >= 768)
      await page.setViewportSize({ width: 1920, height: 1080 });

    const edges = new Map<string, string>();
    for (const href of DESTINATIONS) {
      await page.goto(href);
      const box = await page.locator('[data-slot="page-shell"]').boundingBox();
      expect(box, `${href} renders PageShell`).not.toBeNull();
      edges.set(href, `${Math.round(box?.x ?? -1)}:${Math.round(box?.width ?? -1)}`);
    }

    expect(new Set(edges.values()), JSON.stringify(Object.fromEntries(edges))).toHaveProperty(
      'size',
      1,
    );
  });

  test('the active item looks the same on every destination, focused or not', async ({
    signedIn,
    viewport,
  }) => {
    test.skip(!viewport || viewport.width < 768, 'the sidebar is the desktop rendering');
    const { page, userId } = signedIn;
    // A fresh account's Dashboard redirects to the guide (SPEC-020), which is not
    // a destination and lights no item.
    await dismissOnboarding(userId);
    const sidebar = page.locator('[data-slot="app-sidebar"]');

    const look = () =>
      sidebar
        .locator('[aria-current="page"]')
        .evaluate(
          (element, properties) =>
            properties.map((name) => getComputedStyle(element).getPropertyValue(name)).join(' | '),
          [...ACTIVE_LOOK],
        );

    // Arrived by URL: nothing focused.
    const byUrl = new Map<string, string>();
    for (const item of NAV_ITEMS) {
      await page.goto(item.href);
      byUrl.set(item.href, await look());
    }
    expect(new Set(byUrl.values()), JSON.stringify(Object.fromEntries(byUrl))).toHaveProperty(
      'size',
      1,
    );
    const [resting] = byUrl.values();

    // Arrived by clicking the item: the link keeps focus after a mouse click,
    // which must not turn into a ring or a different fill.
    for (const item of NAV_ITEMS) {
      await sidebar.locator(`a[href="${item.href}"]`).click();
      // Configurações has no page of its own: its item lands on its first section.
      await expect(page).toHaveURL(new RegExp(`${item.href}(/.*)?$`));
      expect(await look(), `${item.href} after a click`).toBe(resting);
    }

    // Keyboard focus adds the ring (DS-48) and changes nothing else: the fill
    // and the text stay those of the active state.
    await page.goto(NAV_ITEMS[0]?.href ?? '/dashboard');
    await page.getByRole('button', { name: 'Recolher menu lateral' }).focus();
    await page.keyboard.press('Tab');
    const active = sidebar.locator('[aria-current="page"]');
    await expect(active).toBeFocused();
    const focused = await look();
    const [fill, text] = focused.split(' | ');
    const [restingFill, restingText, , , , , restingShadow] = (resting ?? '').split(' | ');
    expect([fill, text]).toEqual([restingFill, restingText]);
    expect(focused.split(' | ')[6], 'keyboard focus shows a ring').not.toBe(restingShadow);
  });
});
