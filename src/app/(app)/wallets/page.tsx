import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  allocateAction,
  createWalletAction,
  deleteWalletAction,
  setStandingRuleAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, loadWalletsPageData } from '@/app/(app)/wallets/data';
import { tryUserId } from '@/app/(app)/wallets/session';
import { PageShell } from '@/components/patterns/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * SPEC-010 — wallet CRUD, the Unassigned bucket (BR-010-06), the "Needs
 * attention" queue (BR-010-12) and a side-by-side comparison (BR-010-21).
 *
 * Never statically prerendered: this renders one tenant's own holdings and
 * allocations, so a cached copy built once (or with no session at all) would
 * be served to every visitor — the same reasoning as
 * `(settings)/preferences/page.tsx`.
 */
export const dynamic = 'force-dynamic';

export default async function WalletsPage() {
  const t = await getTranslations('wallets');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const { comparison, unassigned, pending, labels } = await loadWalletsPageData(userId);

  const walletOptions = comparison.map((row) => (
    <option key={row.wallet.id} value={row.wallet.id}>
      {row.wallet.name}
    </option>
  ));

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Section title={t('createTitle')}>
        <ActionForm action={createWalletAction}>
          <Cluster gap="md" align="end">
            <Field id="wallet-name" label={t('nameLabel')} width="lg">
              <Input name="name" required placeholder={t('namePlaceholder')} />
            </Field>
            <Field id="wallet-description" label={t('descriptionLabel')} width="lg">
              <Input name="description" />
            </Field>
            <Field id="wallet-goal" label={t('goalLabel')} hint={t('goalHint')} width="lg">
              <Input name="goal" />
            </Field>
            <Field id="wallet-color" label={t('colorLabel')} width="xs">
              <Input name="color" type="color" />
            </Field>
            <Button type="submit">{t('create')}</Button>
          </Cluster>
        </ActionForm>
      </Section>

      <Section title={t('comparisonTitle')} description={t('comparisonDescription')}>
        {comparison.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <Table>
            <TableCaption className="sr-only">{t('comparisonTitle')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('columnWallet')}</TableHead>
                <TableHead scope="col">{t('columnAssetCount')}</TableHead>
                <TableHead scope="col">{t('columnQuantity')}</TableHead>
                <TableHead scope="col">{t('columnCostBasis')}</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">{t('viewDetails')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparison.map((row) => (
                <TableRow key={row.wallet.id}>
                  <TableCell className="py-row font-medium">{row.wallet.name}</TableCell>
                  <TableCell className="py-row tabular-nums">{row.assetCount}</TableCell>
                  <TableCell className="py-row">
                    <Money value={row.totalQuantity} kind="quantity" />
                  </TableCell>
                  <TableCell className="py-row">
                    <Money value={row.totalCostBasis} />
                  </TableCell>
                  <TableCell className="py-row">
                    <Button asChild variant="link" size="sm">
                      <Link href={`/wallets/${row.wallet.id}`}>{t('viewDetails')}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t('unassignedTitle')} description={t('unassignedDescription')}>
        {unassigned.length === 0 ? (
          <EmptyState title={t('unassignedEmpty')} />
        ) : (
          <List gap="sm">
            {unassigned.map((holding) => {
              const label = labelFor(labels, holding.assetId);
              return (
                <ListItem key={holding.assetId} separated>
                  <Cluster justify="between" gap="sm">
                    <span>
                      {label.code} — {label.name}
                    </span>
                    <Money value={holding.quantity} kind="quantity" />
                  </Cluster>
                </ListItem>
              );
            })}
          </List>
        )}
      </Section>

      <Section title={t('needsAttentionTitle')} description={t('needsAttentionDescription')}>
        {pending.length === 0 ? (
          <EmptyState title={t('needsAttentionEmpty')} />
        ) : (
          <List gap="lg">
            {pending.map((item) => {
              const label = labelFor(labels, item.assetId);
              return (
                <ListItem key={item.assetId} separated>
                  <Stack gap="sm">
                    <Cluster justify="between" gap="sm">
                      <span className="font-medium">
                        {label.code} — {label.name}
                      </span>
                      <Money value={item.unassignedQuantity} kind="quantity" />
                    </Cluster>
                    <Text as="span" size="xs" tone="muted">
                      {t(item.reason === 'no_wallet' ? 'reasonNoWallet' : 'reasonAmbiguousSplit')}
                    </Text>
                    <Cluster gap="lg" align="end">
                      <ActionForm action={allocateAction}>
                        <input type="hidden" name="assetId" value={item.assetId} />
                        <Cluster gap="sm" align="end">
                          <Field
                            id={`allocate-wallet-${item.assetId}`}
                            label={t('resolveAssign')}
                            width="md"
                          >
                            <NativeSelect name="walletId" required>
                              <option value="">{t('chooseWallet')}</option>
                              {walletOptions}
                            </NativeSelect>
                          </Field>
                          <Field
                            id={`allocate-quantity-${item.assetId}`}
                            label={t('resolveQuantity')}
                            width="sm"
                          >
                            <Input
                              name="quantity"
                              defaultValue={item.unassignedQuantity.toString()}
                            />
                          </Field>
                          <Button type="submit" size="sm">
                            {t('resolveSubmit')}
                          </Button>
                        </Cluster>
                      </ActionForm>

                      <ActionForm action={setStandingRuleAction}>
                        <input type="hidden" name="assetId" value={item.assetId} />
                        <Cluster gap="sm" align="end">
                          <Field
                            id={`standing-rule-${item.assetId}`}
                            label={t('standingRuleTitle')}
                            width="md"
                          >
                            <NativeSelect name="walletId" required>
                              <option value="">{t('chooseWallet')}</option>
                              {walletOptions}
                            </NativeSelect>
                          </Field>
                          <Button type="submit" size="sm" variant="outline">
                            {t('standingRuleSet')}
                          </Button>
                        </Cluster>
                      </ActionForm>
                    </Cluster>
                  </Stack>
                </ListItem>
              );
            })}
          </List>
        )}
      </Section>

      <Section title={t('yourWallets')}>
        {comparison.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <List gap="sm">
            {comparison.map((row) => (
              <ListItem key={row.wallet.id} separated>
                <Cluster justify="between" gap="sm">
                  <Button asChild variant="link">
                    <Link href={`/wallets/${row.wallet.id}`}>{row.wallet.name}</Link>
                  </Button>
                  <ActionForm action={deleteWalletAction}>
                    <input type="hidden" name="walletId" value={row.wallet.id} />
                    <Button type="submit" variant="destructive" size="sm">
                      {t('delete')}
                    </Button>
                  </ActionForm>
                </Cluster>
              </ListItem>
            ))}
          </List>
        )}
      </Section>
    </PageShell>
  );
}
