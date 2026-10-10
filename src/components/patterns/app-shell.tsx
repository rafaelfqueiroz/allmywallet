'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu, PanelLeft, PanelLeftClose, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { NAV_ITEMS, type NavItem } from '@/components/patterns/nav-items';
import { isPathActive, navItemClassName } from '@/components/patterns/nav-link';

/**
 * DL-10/DL-11 — the application frame. One navigation definition, rendered two
 * ways: a collapsible sidebar from `md` up, and a slide-over drawer below it,
 * built on the Dialog already vendored in PR1 rather than a second overlay
 * implementation.
 *
 * Bottom tabs were considered and rejected (DL-11): they are the better phone
 * pattern but a second component to build, test and keep in sync with this one.
 *
 * **The top bar (SPEC-022 BR-022-09)** sits above the content at every width.
 * Its right-hand side holds `topBarActions` — the slot the masking toggle
 * (BR-022-24, #206) fills — and `account`, the account menu. Below `md` it
 * also carries the drawer button and the product name.
 *
 * Both are slots rather than imports: `AppShell` is a design-system pattern
 * (DS-02, "a primitive knows nothing about the domain") and stays testable
 * without Auth.js or the registry. `src/app/authenticated-frame.tsx` is the one
 * place the real account menu is wired in, and it passes none to a visitor
 * with no session. The guide's help entry (SPEC-020 BR-020-13) moved from the
 * foot of the sidebar into that menu (BR-022-10).
 */
export function AppShell({
  children,
  account,
  topBarActions,
}: {
  children: ReactNode;
  // `| undefined` explicit (DV-01/`exactOptionalPropertyTypes`): the caller
  // computes these conditionally (signed in or not) and passes the result
  // straight through, rather than being forced into a conditional spread for
  // every render site.
  /** The account menu (BR-022-09). Absent for a visitor with no session. */
  account?: ReactNode | undefined;
  /** Controls beside the account menu — the masking toggle (BR-022-24). */
  topBarActions?: ReactNode | undefined;
}) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div data-slot="app-shell" className="flex min-h-dvh">
      {/*
       * A keyboard user should not have to tab through every nav item on every
       * page to reach the content. Visible only when focused.
       */}
      <a
        href="#conteudo"
        className="sr-only rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        {tCommon('skipToContent')}
      </a>

      <aside
        data-slot="app-sidebar"
        data-collapsed={collapsed}
        className={cn(
          'hidden shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] md:flex md:flex-col',
          collapsed ? 'md:w-16' : 'md:w-60',
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center gap-2 px-3',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {!collapsed && <Brand />}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <PanelLeft /> : <PanelLeftClose />}
          </Button>
        </div>
        <NavList collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-slot="top-bar"
          className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 sm:px-8"
        >
          <div className="flex items-center gap-2 md:hidden">
            <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('openMenu')}>
                  <Menu />
                </Button>
              </DialogTrigger>
              <DialogContent className="inset-y-0 top-0 left-0 flex h-dvh max-w-72 translate-x-0 translate-y-0 flex-col rounded-none rounded-r-xl">
                <DialogTitle className="sr-only">{t('menu')}</DialogTitle>
                <NavList collapsed={false} onNavigate={() => setDrawerOpen(false)} />
              </DialogContent>
            </Dialog>
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {topBarActions}
            {account}
          </div>
        </header>

        <div id="conteudo" className="min-w-0 flex-1">
          {children}
        </div>
      </div>
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav aria-label={t('menu')} className="flex flex-col gap-1 p-2">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          label={t(item.labelKey)}
          // `/wallets/abc` should light up `/wallets`, but `/import` must not
          // light up because `/importar` shares a prefix — hence the boundary.
          active={isPathActive(pathname, item.href)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

/** The product mark: the approved prototype's navy tile and the name. */
function Brand() {
  const t = useTranslations('nav');

  return (
    <span className="flex items-center gap-2 font-heading font-semibold">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
      >
        <Wallet className="size-4" />
      </span>
      {t('appName')}
    </span>
  );
}

function NavLink({
  item,
  label,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  label: string;
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      // `exactOptionalPropertyTypes` (DV-01) treats an explicit `undefined` as
      // different from an absent prop, so the handler is spread in rather than
      // passed as possibly-undefined.
      {...(onNavigate ? { onClick: onNavigate } : {})}
      // AR-44 aside: `aria-current` is what a screen reader announces as "current
      // page". Styling the active item without it makes the state sighted-only.
      {...(active ? { 'aria-current': 'page' as const } : {})}
      {...(collapsed ? { title: label } : {})}
      // SPEC-022 BR-022-33 — the same treatment as the sub-navigation and the
      // route tabs: one class list, so "current" cannot look different here.
      className={cn(navItemClassName(active), collapsed && 'justify-center')}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {collapsed ? <span className="sr-only">{label}</span> : label}
    </Link>
  );
}
