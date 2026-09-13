'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LifeBuoy, Menu, PanelLeft, PanelLeftClose } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { NAV_ITEMS, type NavItem } from '@/components/patterns/nav-items';

/**
 * DL-10/DL-11 — the application frame. One navigation definition, rendered two
 * ways: a collapsible sidebar from `md` up, and a slide-over drawer below it,
 * built on the Dialog already vendored in PR1 rather than a second overlay
 * implementation.
 *
 * Bottom tabs were considered and rejected (DL-11): they are the better phone
 * pattern but a second component to build, test and keep in sync with this one.
 *
 * **`helpAction` (SPEC-020 BR-020-13)** — the guide's help entry point,
 * reachable from either rendering of the shell on every authenticated screen.
 * Taken as a prop rather than imported here: `AppShell` is a design-system
 * pattern (DS-02, "a primitive knows nothing about the domain") and stays
 * testable/reusable without pulling in `(app)/onboarding/actions.ts`.
 * `src/app/authenticated-frame.tsx` is the one place that wires the real
 * action in. A `<form>`, not a `Link` — BR-020-12/13 make reopening a real
 * state change (clearing `users.onboarding_dismissed_at`), which a GET
 * request (prefetch, crawler) must never trigger.
 */
export function AppShell({
  children,
  helpAction,
}: {
  children: ReactNode;
  // `| undefined` explicit (DV-01/`exactOptionalPropertyTypes`): the caller
  // computes this conditionally (signed in or not) and passes the result
  // straight through, rather than being forced into a conditional spread for
  // every render site.
  helpAction?: ((formData: FormData) => Promise<void>) | undefined;
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
        <div className="flex h-14 items-center justify-between px-3">
          {!collapsed && <span className="font-heading font-semibold">{t('appName')}</span>}
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
        <div className="flex min-h-0 flex-1 flex-col justify-between">
          <NavList collapsed={collapsed} />
          {helpAction && <HelpEntry action={helpAction} collapsed={collapsed} />}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('openMenu')}>
                <Menu />
              </Button>
            </DialogTrigger>
            <DialogContent className="inset-y-0 top-0 left-0 flex h-dvh max-w-72 translate-x-0 translate-y-0 flex-col justify-between rounded-none rounded-r-xl">
              <DialogTitle className="sr-only">{t('menu')}</DialogTitle>
              <NavList collapsed={false} onNavigate={() => setDrawerOpen(false)} />
              {helpAction && <HelpEntry action={helpAction} collapsed={false} />}
            </DialogContent>
          </Dialog>
          <span className="font-heading font-semibold">{t('appName')}</span>
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
          active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

/**
 * SPEC-020 BR-020-13 — "the guide can be reopened at any time from a help
 * entry point." Styled like `NavLink` (same padding, same icon treatment,
 * same collapsed-to-icon behaviour) so it reads as part of the navigation
 * rather than as an unrelated button bolted onto the bottom of it — but it is
 * a `<form>` around a submit button, never an `<a>`/`Link`, for the GET/POST
 * reason on `AppShell`'s own doc comment.
 */
function HelpEntry({
  action,
  collapsed,
}: {
  action: (formData: FormData) => Promise<void>;
  collapsed: boolean;
}) {
  const t = useTranslations('nav');

  return (
    <form action={action} className="p-2">
      <button
        type="submit"
        title={collapsed ? t('help') : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-field text-sm outline-none',
          'hover:bg-sidebar-accent/60',
          'focus-visible:ring-3 focus-visible:ring-ring/50',
          collapsed && 'justify-center',
        )}
      >
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        {collapsed ? <span className="sr-only">{t('help')}</span> : t('help')}
      </button>
    </form>
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
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-field text-sm outline-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'hover:bg-sidebar-accent/60',
        collapsed && 'justify-center',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {collapsed ? <span className="sr-only">{label}</span> : label}
    </Link>
  );
}
