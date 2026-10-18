import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { PageShell } from '@/app/page-shell';
import { IMPORT_SEND_PATH } from '@/app/(app)/import/paths';
import { WATCH_RULES_PATH } from '@/lib/watch-paths';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';

/**
 * SPEC-022 BR-022-05/16 — **Configurações**: setup, and never a portfolio
 * figure. One frame for its sections, so they share the heading and the two
 * rows of tabs and differ only in their content.
 *
 * **Rendered by each page, not by a layout** — like `PortfolioFrame`. The shell
 * reports the masking the page was rendered with (`@/app/page-shell`), and a
 * layout is not re-rendered when the user moves between its children, so a
 * masking change made in another tab or on another device would leave the eye
 * contradicting the page (#229).
 *
 * - **Two rows of tabs** (BR-022-16 as amended, DL-022-18). BR-022-05's three
 *   sections, in its order — Carteiras (#210), Importar (#211) and Observar
 *   preços (#212) — are the main tabs every destination uses; a section's
 *   tasks are the pill row beneath them (`tasks`), one URL each (BR-022-15).
 *   A page that is not one of its section's tasks — a wallet, a batch — puts
 *   its way back on that row instead.
 * - **The section's primary action** ("Nova carteira", "Nova regra") sits at
 *   the end of the pill row (`actions`), as the frames draw it.
 */
export async function SettingsFrame({
  tasks,
  actions,
  children,
}: {
  /** The pill row's start: the section's task tabs, or a page's way back. */
  readonly tasks: ReactNode;
  /** The pill row's end: the section's primary action. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('settings');

  return (
    <PageShell title={t('title')} description={t('description')}>
      <RouteTabs
        label={t('navLabel')}
        tabs={[
          { href: '/settings/wallets', label: t('sections.wallets') },
          { href: IMPORT_SEND_PATH, label: t('sections.import') },
          { href: WATCH_RULES_PATH, label: t('sections.watch') },
        ]}
      />
      <Cluster justify="between" gap="sm" data-slot="settings-tasks">
        {tasks}
        {actions}
      </Cluster>
      {children}
    </PageShell>
  );
}

/**
 * The pill row of a page that is not one of its section's tasks — one wallet,
 * one batch: the way back to the task it was reached from, where the task tabs
 * would be. Its main tab stays current (DS-27), so the reader still knows
 * which section they are in.
 */
export function SettingsBackLink({
  href,
  children,
}: {
  readonly href: string;
  /** Translated text — AR-44. */
  readonly children: ReactNode;
}) {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={href}>
        <ChevronLeft aria-hidden />
        {children}
      </Link>
    </Button>
  );
}
