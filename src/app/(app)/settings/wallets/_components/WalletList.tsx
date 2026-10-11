import type { WalletListRow } from '@/app/(app)/wallets/data';
import {
  WalletsTable,
  type WalletRow,
} from '@/app/(app)/settings/wallets/_components/WalletsTable';
import { formatDate } from '@/i18n/format';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Minhas carteiras: the table of wallets in its card, with the cells
 * formatted here so the Client Component receives text (`formatDate` is the one
 * place `dd/mm/yyyy` is decided, AR-47). Shared by the list and by "Nova
 * carteira", which is the same list with the form beside it.
 */
export function WalletList({ rows }: { readonly rows: readonly WalletListRow[] }) {
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
    <Card>
      <CardContent>
        <WalletsTable rows={tableRows} />
      </CardContent>
    </Card>
  );
}
