import type { ReactNode } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';

/**
 * SPEC-022 BR-022-05/15/16 — Configurações › **Carteiras**: one section, three
 * tasks, one tab each with its own URL. The header — the section's name, the
 * one primary action, the tab bar — is shared by the three tab pages (and by
 * "Nova carteira", which is a view of the first), so it is written once.
 *
 * "Nova carteira" is a link rather than a button that opens something in
 * place: the form has an address of its own, so it can be bookmarked and
 * Cancelar is simply "back".
 *
 * Nothing in this section shows a portfolio figure (BR-022-05). The wallet
 * detail page (`[walletId]`) is not a tab and has its own header.
 */
export async function WalletsSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('wallets');

  return (
    <Stack gap="lg">
      <Stack gap="md">
        <Cluster justify="between" gap="sm">
          <h2 className="text-lg font-medium">{t('sectionTitle')}</h2>
          <Button asChild>
            <Link href="/settings/wallets/new">
              <Plus aria-hidden />
              {t('newWallet')}
            </Link>
          </Button>
        </Cluster>
        <RouteTabs
          label={t('tabs.label')}
          tabs={[
            {
              href: '/settings/wallets',
              label: t('tabs.mine'),
              exact: true,
              alsoActiveOn: ['/settings/wallets/new'],
            },
            { href: '/settings/wallets/assign', label: t('tabs.assign') },
            { href: '/settings/wallets/parameters', label: t('tabs.parameters') },
          ]}
        />
      </Stack>
      {children}
    </Stack>
  );
}
