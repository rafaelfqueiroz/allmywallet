import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { WalletId } from '@/core/shared/ids';
import { deleteWalletAction, updateWalletAction } from '@/app/(app)/wallets/actions';
import { labelFor, loadWalletDetail } from '@/app/(app)/wallets/data';
import { tryUserId } from '@/app/(app)/wallets/session';
import { PageShell } from '@/components/patterns/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** SPEC-010 BR-010-01/BR-010-07 — a single wallet's edit form and its allocated assets. */
export const dynamic = 'force-dynamic';

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const { walletId: rawWalletId } = await params;
  const t = await getTranslations('wallets');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="narrow">
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawWalletId)) notFound();
  const walletId = WalletId.of(rawWalletId);
  const detail = await loadWalletDetail(userId, walletId);
  if (detail === null) notFound();

  const { wallet, allocations, labels } = detail;

  return (
    <PageShell
      width="narrow"
      title={wallet.name}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/wallets">{t('walletDetailBack')}</Link>
        </Button>
      }
    >
      <Section title={t('editTitle')}>
        <ActionForm action={updateWalletAction}>
          <input type="hidden" name="walletId" value={wallet.id} />
          <Stack gap="md" align="start">
            <Field id="wallet-name" label={t('nameLabel')} width="lg">
              <Input name="name" defaultValue={wallet.name} />
            </Field>
            <Field id="wallet-description" label={t('descriptionLabel')} width="lg">
              <Input name="description" defaultValue={wallet.description ?? ''} />
            </Field>
            <Field id="wallet-goal" label={t('goalLabel')} width="lg">
              <Input name="goal" defaultValue={wallet.goal ?? ''} />
            </Field>
            <Field id="wallet-color" label={t('colorLabel')} width="xs">
              <Input name="color" type="color" defaultValue={wallet.color ?? '#000000'} />
            </Field>
            <Button type="submit">{t('save')}</Button>
          </Stack>
        </ActionForm>
      </Section>

      <Section title={t('allocationsTitle')}>
        {allocations.length === 0 ? (
          <EmptyState title={t('allocationsEmpty')} />
        ) : (
          <Table>
            <TableCaption className="sr-only">{t('allocationsTitle')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('columnAsset')}</TableHead>
                <TableHead scope="col">{t('columnQuantity')}</TableHead>
                <TableHead scope="col">{t('columnCostBasis')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.map((allocation) => {
                const label = labelFor(labels, allocation.assetId);
                return (
                  <TableRow key={allocation.assetId}>
                    <TableCell className="py-row">
                      {label.code} — {label.name}
                    </TableCell>
                    <TableCell className="py-row">
                      <Money value={allocation.quantity} kind="quantity" />
                    </TableCell>
                    <TableCell className="py-row">
                      {allocation.costBasisAtAllocation === null ? (
                        // An allocation predating cost tracking has no basis to
                        // show. An em dash says "not recorded"; a zero would
                        // say "free", which is a different and wrong claim.
                        <span aria-label={t('costBasisUnknown')}>—</span>
                      ) : (
                        <Money value={allocation.costBasisAtAllocation} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t('delete')}>
        <ActionForm action={deleteWalletAction}>
          <input type="hidden" name="walletId" value={wallet.id} />
          <Button type="submit" variant="destructive">
            {t('delete')}
          </Button>
        </ActionForm>
      </Section>
    </PageShell>
  );
}
