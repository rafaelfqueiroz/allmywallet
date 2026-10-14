import { getTranslations } from 'next-intl/server';
import { createWalletAction } from '@/app/(app)/wallets/actions';
import { WalletForm } from '@/app/(app)/settings/wallets/_components/WalletForm';

/**
 * The prototype's "Nova carteira" panel: Nome, Descrição, Objetivo and Cor, with
 * Cancelar (back to the list) and Criar carteira. Creating redirects to the new
 * wallet's page, where its assets are assigned.
 *
 * The panel is the standard form's (SPEC-022 BR-022-37). Beside the list it is
 * a 20rem column, so its grid is one column: the grid breaks on its container.
 */
export async function NewWalletPanel() {
  const t = await getTranslations('wallets');

  return (
    <WalletForm
      action={createWalletAction}
      idPrefix="new-wallet"
      title={t('createTitle')}
      submitLabel={t('create')}
      cancelHref="/settings/wallets"
    />
  );
}
