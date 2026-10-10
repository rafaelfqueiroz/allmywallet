import { cn } from '@/lib/utils';

/**
 * What every navigation surface — the sidebar, the vertical sub-navigation and
 * the route tabs — agrees on, so "which one is current" and "what does current
 * look like" are answered once (SPEC-022 BR-022-33, DESIGN.md DS-27/DS-48).
 */

/**
 * DS-27 — is `href` the page, or a section the page is inside?
 *
 * Matching is on a path boundary: `/wallets/abc` lights up `/wallets`, but
 * `/importar-outro` does not light up `/import`. `exact` is for a destination
 * that is the *root* of others — the reports overview at `/reports` must not
 * stay lit on `/reports/patrimonio`.
 */
export function isPathActive(pathname: string, href: string, exact = false): boolean {
  if (pathname === href) return true;
  return !exact && pathname.startsWith(`${href}/`);
}

/**
 * The look of one item in a list of destinations (BR-022-33, DS-48).
 *
 * Active is a **fill** (`nav-active`); keyboard focus is a **ring** (`ring`) —
 * different tokens and different shapes, so the current destination and the
 * keyboard position can sit on different items without either being mistaken
 * for the other. Hover is the neutral `accent`, so it cannot pass for active.
 */
export function navItemClassName(active: boolean): string {
  return cn(
    'flex items-center gap-2 rounded-md px-2 py-field text-sm outline-none',
    'focus-visible:ring-3 focus-visible:ring-ring/50',
    active ? 'bg-nav-active font-medium text-nav-active-foreground' : 'hover:bg-accent',
  );
}

/**
 * BR-022-17 / BR-011-11 — `href` carrying over the named query parameters
 * from `current`, so the wallet scope survives a tab switch. Parameters that
 * are not listed are dropped: a tab is a different task with its own defaults,
 * and a leaked page number from the last one would land on page 4 of nothing.
 * A parameter absent from `current` is simply not written.
 */
export function hrefWithParams(
  href: string,
  current: { get(name: string): string | null },
  preserve: readonly string[] | undefined,
): string {
  if (!preserve || preserve.length === 0) return href;

  const carried = new URLSearchParams();
  for (const name of preserve) {
    const value = current.get(name);
    if (value !== null) carried.set(name, value);
  }
  const query = carried.toString();
  if (query === '') return href;
  return `${href}${href.includes('?') ? '&' : '?'}${query}`;
}
