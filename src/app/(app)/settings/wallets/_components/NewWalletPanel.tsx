import { getTranslations } from 'next-intl/server';
import { createWalletAction } from '@/app/(app)/wallets/actions';
import { WalletForm } from '@/app/(app)/settings/wallets/_components/WalletForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The prototype's "Nova carteira" card: Nome, Descrição, Objetivo and Cor, with
 * Cancelar (back to the list) and Criar carteira. Creating redirects to the new
 * wallet's page, where its assets are assigned.
 */
export async function NewWalletPanel() {
  const t = await getTranslations('wallets');

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle asChild>
          <h3>{t('createTitle')}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <WalletForm
          action={createWalletAction}
          idPrefix="new-wallet"
          submitLabel={t('create')}
          cancelHref="/settings/wallets"
        />
      </CardContent>
    </Card>
  );
}
