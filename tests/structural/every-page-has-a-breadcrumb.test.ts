import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breadcrumbFor, PAGES_OUTSIDE_DESTINATIONS } from '@/components/patterns/breadcrumbs';
import { NAV_ITEMS } from '@/components/patterns/nav-items';
import { isPathActive } from '@/components/patterns/nav-link';

/**
 * SPEC-022 BR-022-09 (amended, DL-022-27, #254) — every authenticated page
 * shows a breadcrumb, and its first crumb is the sidebar item that is current
 * there.
 *
 * Enumerated from the route tree rather than listed: a page added under
 * `(app)` or `(settings)` — the two groups `AuthenticatedFrame` wraps — is in
 * this test the day it exists, so a new destination tab or section task
 * cannot ship with a top bar that names nothing.
 */

const APP = join(process.cwd(), 'src', 'app');
const AUTHENTICATED_GROUPS = ['(app)', '(settings)'];

function* files(dir: string, match: (name: string) => boolean): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, match);
    else if (match(entry.name)) yield path;
  }
}

const pages = (dir: string) => files(dir, (name) => name === 'page.tsx');

/** `src/app/(app)/settings/wallets/[walletId]/page.tsx` → `/settings/wallets/sample`. */
function routeOf(file: string): string {
  const segments = relative(APP, file)
    .split(sep)
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith('_'))
    .map((segment) => (/^\[.*\]$/.test(segment) ? 'sample' : segment));
  return `/${segments.join('/')}`;
}

const ROUTES = AUTHENTICATED_GROUPS.flatMap((group) => [...pages(join(APP, group))]).map(routeOf);

describe('every authenticated page has a breadcrumb (SPEC-022 BR-022-09)', () => {
  it('finds the route tree', () => {
    expect(ROUTES).toContain('/dashboard');
    expect(ROUTES).toContain('/settings/wallets/sample');
  });

  it.each(ROUTES)('%s resolves to a trail', (route) => {
    expect(breadcrumbFor(route).length).toBeGreaterThan(0);
  });

  it.each(ROUTES)('%s starts at the sidebar item current there, or at itself', (route) => {
    const [first] = breadcrumbFor(route);
    const current = NAV_ITEMS.find((item) => isPathActive(route, item.href));

    if (current) {
      expect(first?.labelKey).toBe(`nav.${current.labelKey}`);
    } else {
      // Under no destination: the page is one of the account menu's, the
      // guide, or the contracted-rate task — named, never left blank.
      expect(PAGES_OUTSIDE_DESTINATIONS).toContainEqual(first);
    }
  });
});

/**
 * DS-69 — the crumb names a tab from `destination-tabs.ts`, so a frame's tab
 * row must render the same definitions. A tab written inline in a frame would
 * be lit on the page and missing from the crumb.
 */
describe('every tab row renders destination-tabs.ts (DS-69)', () => {
  const frames = AUTHENTICATED_GROUPS.flatMap((group) => [
    ...files(join(APP, group), (name) => name.endsWith('.tsx')),
  ])
    .map((file) => [relative(process.cwd(), file), readFileSync(file, 'utf8')] as const)
    .filter(([, source]) => source.includes('<RouteTabs'));

  it('finds the frames', () => {
    expect(frames.length).toBeGreaterThanOrEqual(6);
  });

  it.each(frames)('%s', (_file, source) => {
    const rows = source.match(/<RouteTabs[\s\S]*?\/>/g) ?? [];
    for (const row of rows) expect(row).toMatch(/tabs=\{routeTabs\(/);
  });
});
