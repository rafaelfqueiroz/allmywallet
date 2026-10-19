import { NAV_ITEMS, navHref } from '@/components/patterns/nav-items';
import { DESTINATION_TABS, type SectionDefinition } from '@/components/patterns/destination-tabs';
import { isPathActive, isTabActive } from '@/components/patterns/nav-link';

/**
 * SPEC-022 BR-022-09 (amended, DL-022-27, #254) — where a page sits, as the
 * top bar's breadcrumb names it: the destination, then its tab or
 * Configurações' section, then the section's task, as deep as the page goes.
 *
 * **A function of the path alone.** The top bar belongs to the layout, which
 * knows the path and nothing the page loaded, so a page that is not a task —
 * one wallet, one batch, "Nova carteira" — ends at the task it belongs to
 * (`SectionDefinition.detailsBelongTo`, DS-64's `alsoActiveOn`). Built from
 * `nav-items.ts` and `destination-tabs.ts`, the definitions the sidebar and
 * the tab rows render, so the crumb cannot name a level they do not show.
 *
 * Plain data and no `next/*` import; `AppShell` reads the path and renders.
 */
export type Crumb = {
  /** A full message key (AR-44). */
  readonly labelKey: string;
  readonly href: string;
};

/**
 * The pages that sit under no destination: the account menu's (BR-022-10),
 * the onboarding guide, and the contracted-rate task the Dashboard's attention
 * queue links to. Each is its own one-crumb trail.
 */
export const PAGES_OUTSIDE_DESTINATIONS: readonly Crumb[] = [
  { href: '/account', labelKey: 'accountMenu.account' },
  { href: '/preferences', labelKey: 'accountMenu.preferences' },
  { href: '/privacy', labelKey: 'accountMenu.privacy' },
  { href: '/onboarding', labelKey: 'onboarding.title' },
  { href: '/fixed-income', labelKey: 'fixedIncome.title' },
];

const NO_PARAMS = { get: () => null } as const;

/**
 * The trail for `pathname`, outermost first; empty where the frame has no
 * page to name. `current` is the URL's query: the first crumb links where the
 * sidebar item does, so it carries the wallet scope as that item does
 * (BR-022-17, `navHref`).
 */
export function breadcrumbFor(
  pathname: string,
  current: { get(name: string): string | null } = NO_PARAMS,
): readonly Crumb[] {
  const destination = NAV_ITEMS.find((item) => isPathActive(pathname, item.href));
  if (!destination) {
    const page = PAGES_OUTSIDE_DESTINATIONS.find((item) => isPathActive(pathname, item.href));
    return page ? [page] : [];
  }

  const trail: Crumb[] = [
    { labelKey: `nav.${destination.labelKey}`, href: navHref(destination, pathname, current) },
  ];

  const tab = DESTINATION_TABS[destination.href]?.find((item) => isTabActive(pathname, item));
  if (!tab) return trail;
  trail.push({ labelKey: tab.labelKey, href: tab.href });

  if (!('tasks' in tab)) return trail;
  const section: SectionDefinition = tab;
  const task =
    section.tasks.find((item) => isTabActive(pathname, item)) ??
    section.tasks.find((item) => item.href === section.detailsBelongTo);
  if (task) trail.push({ labelKey: task.labelKey, href: task.href });

  return trail;
}
