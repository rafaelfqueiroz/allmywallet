'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isPathActive, navItemClassName } from '@/components/patterns/nav-link';

/**
 * SPEC-022 BR-022-16 — Configurações' sections as a **vertical sub-navigation**.
 *
 * It is a second level of navigation inside a destination, so it looks like the
 * first: the same class list as the sidebar's items (`navItemClassName`), which
 * is what BR-022-33 asks — the current item looks the same wherever it is, and
 * differs from the keyboard ring. Active is the `nav-active` fill with
 * `aria-current="page"` (DS-27); hover is the neutral `accent`; focus is the
 * ring (DS-48).
 *
 * Links, one URL per section, like the route tabs: a section a user can bookmark
 * and open in a new tab. A section with more than one task uses `RouteTabs`
 * inside it (BR-022-16), not another level of this.
 */
export type SubNavItem = {
  readonly href: string;
  /** Translated text — AR-44. */
  readonly label: ReactNode;
  /**
   * A rendered icon element (`<Upload />`), not the component: Configurações'
   * layout is a Server Component, and a component is a function, which cannot
   * cross into this Client Component as a prop. Hidden from assistive
   * technology here — the label already names the item.
   */
  readonly icon?: ReactNode;
  /** Match the path exactly; see `RouteTab.exact`. */
  readonly exact?: boolean;
};

export type SubNavProps = {
  /** The accessible name of the `<nav>`, distinguishing it from the shell's. */
  readonly label: string;
  readonly items: readonly SubNavItem[];
  readonly className?: string;
};

export function SubNav({ label, items, className }: SubNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} data-slot="sub-nav" className={className}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = isPathActive(pathname, item.href, item.exact);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                {...(active ? { 'aria-current': 'page' as const } : {})}
                className={cn(navItemClassName(active))}
              >
                {item.icon && (
                  <span aria-hidden="true" className="flex shrink-0 [&>svg]:size-4">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
