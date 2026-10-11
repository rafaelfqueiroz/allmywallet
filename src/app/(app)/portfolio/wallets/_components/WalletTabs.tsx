import { getTranslations } from 'next-intl/server';
import { PARAM } from '@/lib/report-url-state';
import { RouteTabs } from '@/components/patterns/route-tabs';

/**
 * Portfólio › Carteiras' two tasks, one tab each (BR-022-15): **Comparação**,
 * the analysis, and **Configurar**, wallet setup, last. Setup moves to
 * Configurações › Carteiras with #210 (BR-022-05), and this bar goes with it.
 *
 * The scope rides along like on the parent tabs (BR-022-17), so returning from
 * setup lands on the wallet that was selected.
 */
export async function WalletTabs() {
  const tp = await getTranslations('portfolio');

  return (
    <RouteTabs
      label={tp('wallets.tabs.label')}
      preserveParams={[PARAM.wallet]}
      tabs={[
        { href: '/portfolio/wallets', label: tp('wallets.tabs.comparison'), exact: true },
        { href: '/portfolio/wallets/setup', label: tp('wallets.tabs.setup') },
      ]}
    />
  );
}
