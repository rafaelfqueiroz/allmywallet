import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import type { BusinessDate } from '@/core/shared/clock';
import { PARAM } from '@/lib/report-url-state';
import { formatBusinessDate, formatDateTime } from '@/i18n/format';
import { PageShell } from '@/app/page-shell';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { ScopeSelector, type ScopeWallet } from '@/components/patterns/scope-selector';
import { Cluster } from '@/components/layout/cluster';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-02 — **Portfólio**, the current state of everything held.
 * One frame for its four tabs, so they share one header, one scope selector
 * and one tab bar, and differ only in their content.
 *
 * - **No period control, anywhere in it** (BR-022-02, DL-022-02). Every figure
 *   is valued at the latest quote; a period would be a control that changes
 *   nothing on screen. Performance over a period is Relatórios' (BR-022-03).
 * - **The scope is the URL's `wallet` parameter** (BR-022-17), written by the
 *   one `ScopeSelector` in the header and carried by every tab link
 *   (`preserveParams`), so switching tabs keeps the wallet and a reload keeps
 *   it too (BR-011-11). The parameter is Relatórios' own (`PARAM.wallet`);
 *   the application menu carries it between the two
 *   destinations (#209, `navHref`).
 * - **Each tab has its own URL** (BR-022-15). Patrimônio is the destination's
 *   root, matched exactly so it is not also active under its siblings.
 */
export interface Freshness {
  readonly valuationAsOf: BusinessDate;
  readonly quotedAt: Date | null;
  readonly delayMinutes: number;
  readonly lastImportAt: BusinessDate | null;
}

export async function PortfolioFrame({
  wallets,
  freshness,
  actions,
  scoped = true,
  children,
}: {
  readonly wallets: readonly ScopeWallet[];
  /**
   * SPEC-005 BR-005-27 / SPEC-008 BR-008-04 — the dates behind a portfolio
   * value. Passed by every tab that shows one; absent on a tab that shows none
   * (or before there is anything to value).
   */
  readonly freshness?: Freshness | undefined;
  readonly actions?: ReactNode;
  /**
   * `false` for a page the scope does not change (Carteiras › Configurar):
   * the header carries the selector only "where it applies" (BR-022-14).
   */
  readonly scoped?: boolean;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('portfolio');

  return (
    <PageShell
      title={t('title')}
      description={t('description')}
      {...(scoped ? { scope: <ScopeSelector wallets={wallets} /> } : {})}
      {...(actions ? { actions } : {})}
    >
      <RouteTabs
        label={t('tabs.label')}
        preserveParams={[PARAM.wallet]}
        tabs={[
          { href: '/portfolio', label: t('tabs.patrimonio'), exact: true },
          { href: '/portfolio/composition', label: t('tabs.composicao') },
          { href: '/portfolio/wallets', label: t('tabs.carteiras') },
          { href: '/portfolio/goals', label: t('tabs.metas') },
        ]}
      />
      {freshness && <FreshnessLine freshness={freshness} />}
      {children}
    </PageShell>
  );
}

/**
 * The dashboard's four dates, in the dashboard's words (`dashboard.freshness`):
 * the same figure carries the same caveats wherever it is read (BR-022-32).
 * "The product never implies real-time" (BR-008-04).
 */
async function FreshnessLine({ freshness }: { readonly freshness: Freshness }) {
  const t = await getTranslations('dashboard');

  return (
    <Cluster gap="md" align="baseline" data-slot="freshness">
      <Text tone="muted" size="xs">
        {t('freshness.valuation', { date: formatBusinessDate(freshness.valuationAsOf) })}
      </Text>
      <Text tone="muted" size="xs">
        {freshness.quotedAt === null
          ? t('freshness.noQuote')
          : t('freshness.quotedAt', { timestamp: formatDateTime(freshness.quotedAt) })}
      </Text>
      <Text tone="muted" size="xs">
        {t('freshness.delay', { minutes: freshness.delayMinutes })}
      </Text>
      <Text tone="muted" size="xs">
        {freshness.lastImportAt === null
          ? t('freshness.neverImported')
          : t('freshness.lastImport', { date: formatBusinessDate(freshness.lastImportAt) })}
      </Text>
    </Cluster>
  );
}
