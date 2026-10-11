import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { PARAM } from '@/lib/report-url-state';
import { PageShell } from '@/app/page-shell';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { ScopeSelector, type ScopeWallet } from '@/components/patterns/scope-selector';

/**
 * SPEC-022 BR-022-03 — **Relatórios**, performance over a period. One frame
 * for its three tabs, so they share one header, one scope selector and one
 * tab bar, and differ only in their content.
 *
 * - **Every tab takes a period** (BR-022-03, BR-011-01): each renders the
 *   shared `Controls` bar, whose first field is Período. Current state —
 *   Visão geral and Composição — left for Portfólio (#208, DL-022-02).
 * - **The scope is the header's `ScopeSelector`** (BR-022-17, DL-022-09), the
 *   same control and the same `wallet` parameter as Portfólio's, which is
 *   what lets the application menu carry it between the two destinations
 *   (`nav-items.ts`). It replaces each report's own Escopo field.
 * - **Switching tabs keeps the view** (BR-011-11): the period, the scope and
 *   the grouping are carried onto every tab link. BR-011-04's default
 *   grouping depends on the scope alone, never on the report, so a grouping
 *   carried across means the same thing on the other side. Report-specific
 *   state — Rentabilidade's `earnings` — stays behind.
 * - **Each tab has its own URL** (BR-022-15). Evolução patrimonial is the
 *   destination's root, matched exactly so it is not also active under its
 *   siblings — the pattern Portfólio set with Patrimônio.
 *
 * `description` is the tab's own: the header is shared, but what a tab
 * answers is not.
 */
export async function ReportsFrame({
  wallets,
  description,
  children,
}: {
  readonly wallets: readonly ScopeWallet[];
  readonly description: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('reports');

  return (
    <PageShell
      title={t('title')}
      description={description}
      scope={<ScopeSelector wallets={wallets} />}
    >
      <RouteTabs
        label={t('links.label')}
        preserveParams={[PARAM.wallet, PARAM.period, PARAM.from, PARAM.to, PARAM.grouping]}
        tabs={[
          { href: '/reports', label: t('links.patrimonio'), exact: true },
          { href: '/reports/performance', label: t('links.performance') },
          { href: '/reports/earnings', label: t('links.proventos') },
        ]}
      />
      {children}
    </PageShell>
  );
}
