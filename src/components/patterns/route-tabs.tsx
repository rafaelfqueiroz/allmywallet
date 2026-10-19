'use client';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { hrefWithParams, isTabActive } from '@/components/patterns/nav-link';

/**
 * SPEC-022 BR-022-15 — a destination with more than one task presents them as
 * tabs: **one task per tab, each tab with its own URL**.
 *
 * These are *links*, not a `role="tablist"`. A tab that changes the address is
 * navigation, and the WAI-ARIA tabs pattern is for panels that swap in place
 * (the Radix `Tabs` primitive, which stays for that). Links get the browser's
 * behaviour for free — open in a new tab, copy the URL, Back — and a screen
 * reader announces the current one through `aria-current="page"` (DS-27)
 * instead of a tab role that would promise arrow-key semantics the links do
 * not have.
 *
 * The look is the prototype's underline tabs. Active is foreground text with a
 * `primary` underline; keyboard focus is a ring around the whole link — an
 * outline and a rule, never the same shape, so the current tab and the focused
 * tab can differ without either reading as the other (BR-022-33, DS-48). Hover
 * is the neutral `accent`.
 *
 * **`preserveParams`** names the query parameters carried onto every tab's
 * href, which is how the wallet scope survives a tab switch (BR-022-17,
 * BR-011-11). The default carries nothing: a tab bar whose tasks share no state
 * must not smuggle one task's filters into another, whose defaults differ
 * (the reports' own rule, BR-011-04).
 *
 * **`variant="pill"`** is the second row of a destination whose sections have
 * tasks of their own — Configurações (BR-022-16, DL-022-18): the sections are
 * the main tabs, each section's tasks are pills beneath them. Smaller, on a
 * `muted` track, the current one raised on the `card` fill — so the two
 * rows never read as one strip, and the current pill differs from the focused
 * one the same way (a fill, never a ring). Same links, same `aria-current`, one
 * URL per tab.
 *
 * The strip scrolls inside its own container when the tabs outgrow a narrow
 * screen, so a long label never becomes a horizontal scroll of the page
 * (BR-016-12).
 */
export type RouteTab = {
  readonly href: string;
  /** Translated text — AR-44. */
  readonly label: ReactNode;
  /**
   * Match the path exactly. For a tab that is the root of the others — the
   * first tab at `/reports` beside `/reports/performance` — which would otherwise
   * stay active under every sibling (DS-27's boundary rule matches sections).
   */
  readonly exact?: boolean;
  /**
   * Further paths this tab stays current on, besides its own. For a page that
   * belongs to a tab's task without being one of the tabs: Carteiras' "Nova
   * carteira" form is part of "Minhas carteiras", and with no tab lit the
   * reader would not know where they are (DS-27).
   */
  readonly alsoActiveOn?: readonly string[];
};

export type RouteTabsProps = {
  /** The accessible name of the `<nav>`, distinguishing it from the shell's. */
  readonly label: string;
  readonly tabs: readonly RouteTab[];
  /** Query parameters copied from the current URL onto every tab's href. */
  readonly preserveParams?: readonly string[];
  /** `main` — a destination's tabs; `pill` — a section's tasks beneath them. */
  readonly variant?: 'main' | 'pill';
  readonly className?: string;
};

const STRIP = {
  main: { nav: 'overflow-x-auto border-b', list: 'flex min-w-max gap-1' },
  pill: {
    nav: 'max-w-full overflow-x-auto rounded-lg bg-muted',
    list: 'flex min-w-max gap-1 p-1',
  },
} as const;

const TAB = {
  main: {
    base: 'h-10 rounded-t-md border-b-2 px-3',
    active: 'border-primary font-medium text-foreground',
    inactive: 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  },
  pill: {
    base: 'h-8 rounded-md px-3 font-medium',
    active: 'bg-card text-foreground shadow-xs',
    inactive: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  },
} as const;

export function RouteTabs(props: RouteTabsProps) {
  // `useSearchParams` bails a static page out to client rendering up to the
  // nearest Suspense boundary; this one is the tabs' own so a caller need not
  // add it. The fallback is the same strip without the carried parameters,
  // which are filled in as soon as the client has the URL.
  return (
    <Suspense fallback={<TabStrip {...props} params={NO_PARAMS} />}>
      <ConnectedTabs {...props} />
    </Suspense>
  );
}

const NO_PARAMS = { get: () => null } as const;

function ConnectedTabs(props: RouteTabsProps) {
  return <TabStrip {...props} params={useSearchParams()} />;
}

function TabStrip({
  label,
  tabs,
  preserveParams,
  variant = 'main',
  className,
  params,
}: RouteTabsProps & { readonly params: { get(name: string): string | null } }) {
  const pathname = usePathname();
  const tab = TAB[variant];

  return (
    <nav
      aria-label={label}
      data-slot="route-tabs"
      data-variant={variant}
      className={cn(STRIP[variant].nav, className)}
    >
      <ul className={STRIP[variant].list}>
        {tabs.map((item) => {
          const active = isTabActive(pathname, item);

          return (
            <li key={item.href}>
              <Link
                href={hrefWithParams(item.href, params, preserveParams)}
                {...(active ? { 'aria-current': 'page' as const } : {})}
                className={cn(
                  'inline-flex items-center text-sm whitespace-nowrap outline-none',
                  tab.base,
                  // Inset: the strip scrolls horizontally on a phone, and a
                  // scroll container clips anything drawn outside its box —
                  // an outset ring lost its top edge on every tab. For the same
                  // reason the underline sits on the border rather than over it
                  // (no negative margin to overflow by a pixel).
                  'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                  active ? tab.active : tab.inactive,
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
