import type { ReactNode } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { WALLETS_SECTION, routeTabs } from '@/components/patterns/destination-tabs';
import { Button } from '@/components/ui/button';

/**
 * SPEC-022 BR-022-05/15/16 — Configurações › **Carteiras**: one section, three
 * tasks, one pill tab each with its own URL, and the one primary action at the
 * end of their row. Shared by the three tab pages (and by "Nova carteira",
 * which is a view of the first), so it is written once.
 *
 * "Nova carteira" is a link rather than a button that opens something in
 * place: the form has an address of its own, so it can be bookmarked and
 * Cancelar is simply "back".
 *
 * Nothing in this section shows a portfolio figure (BR-022-05). The wallet
 * page (`[walletId]`) is not a task; it has its way back on the pill row.
 */
export async function WalletsSection({ children }: { readonly children: ReactNode }) {
  const t = await getTranslations('wallets');
  const tAll = await getTranslations();

  return (
    <SettingsFrame
      tasks={
        <RouteTabs
          variant="pill"
          label={t('tabs.label')}
          tabs={routeTabs(WALLETS_SECTION.tasks, tAll)}
        />
      }
      actions={
        <Button asChild>
          <Link href="/settings/wallets/new">
            <Plus aria-hidden />
            {t('newWallet')}
          </Link>
        </Button>
      }
    >
      {children}
    </SettingsFrame>
  );
}
