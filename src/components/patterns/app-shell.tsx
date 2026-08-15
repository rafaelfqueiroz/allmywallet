'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Menu, PanelLeft, PanelLeftClose } from 'lucide-react';
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
 */
export function AppShell({ children }: { children: ReactNode }) {
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
        <NavList collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('openMenu')}>
                <Menu />
              </Button>
            </DialogTrigger>
            <DialogContent className="inset-y-0 top-0 left-0 h-dvh max-w-72 translate-x-0 translate-y-0 rounded-none rounded-r-xl">
              <DialogTitle className="sr-only">{t('menu')}</DialogTitle>
              <NavList collapsed={false} onNavigate={() => setDrawerOpen(false)} />
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
