import type { WalletListRow } from '@/app/(app)/wallets/data';
import {
  WalletsTable,
  type WalletRow,
} from '@/app/(app)/settings/wallets/_components/WalletsTable';
import { getTranslations } from 'next-intl/server';
import { formatDate } from '@/i18n/format';
import { Section } from '@/components/patterns/section';

/**
 * Minhas carteiras: the table of wallets in its panel, titled with the count
 * as the frame draws it ("5 carteiras", SPEC-022 BR-022-36), with the cells
 * formatted here so the Client Component receives text (`formatDate` is the one
 * place `dd/mm/yyyy` is decided, AR-47). Shared by the list and by "Nova
 * carteira", which is the same list with the form beside it.
 */
export async function WalletList({ rows }: { readonly rows: readonly WalletListRow[] }) {
  const t = await getTranslations('wallets.list');
  const tableRows: WalletRow[] = rows.map(({ wallet, assetCount }) => ({
    id: wallet.id,
    name: wallet.name,
    description: wallet.description,
    goal: wallet.goal,
    color: wallet.color,
    assetCount,
    updatedAtText: formatDate(wallet.updatedAt),
    updatedAtMs: wallet.updatedAt.getTime(),
  }));

  return (
    <Section title={t('title', { count: rows.length })}>
      <WalletsTable rows={tableRows} />
    </Section>
  );
}
