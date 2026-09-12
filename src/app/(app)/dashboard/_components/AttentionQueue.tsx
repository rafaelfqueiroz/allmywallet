import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { AttentionItem } from '@/core/dashboard/summary';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { List, ListItem } from '@/components/layout/list';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-010 BR-010-12 — "purchases awaiting allocation appear in the same
 * 'Needs attention' queue used for unclassified imports, and on the
 * post-import summary **and dashboard** until resolved."
 *
 * **One queue, not a second one.** DL-017-08 is explicit that a second surface
 * splits the answer to "is there anything for me to do?" across two screens.
 * `/wallets` renders pending allocations and SPEC-017's out-of-balance wallets,
 * which live with the wallets they are about; outstanding import rows have
 * until now been visible only on `/import/[batchId]`, one batch at a time. This
 * is the first screen on which BR-010-12's "the same queue" is literally one
 * list, and every item links back to the screen that resolves it.
 *
 * **Every item states its consequence.** SPEC-020 BR-020-18's shape, applied
 * here because the two kinds have genuinely opposite consequences and looked
 * identical without it: an unclassified row is *excluded* from the calculation
 * and therefore understates the figure directly above this queue, while a
 * pending allocation is already inside that figure and only lacks a filing
 * decision. Told apart, one is urgent and one is housekeeping; told as a bare
 * count, they are indistinguishable.
 */
export async function AttentionQueue({ items }: { readonly items: readonly AttentionItem[] }) {
  const t = await getTranslations('dashboard.attention');

  return (
    <Section title={t('title')} description={t('description')}>
      {items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <List gap="md">
          {items.map((item) =>
            item.kind === 'import_rows' ? (
              <ListItem key={`rows-${item.batchId}`} separated>
                <Stack gap="xs">
                  <Cluster justify="between" gap="sm" align="baseline">
                    <Text as="span" weight="medium">
                      {t('importRows.label', { count: item.count })}
                    </Text>
                    <Button asChild variant="link" size="sm">
                      <Link href={`/import/${item.batchId}`}>{t('importRows.action')}</Link>
                    </Button>
                  </Cluster>
                  <Text as="span" size="xs" tone="muted">
                    {t('importRows.consequence')}
                  </Text>
                </Stack>
              </ListItem>
            ) : (
              <ListItem key={`pending-${item.assetId}`} separated>
                <Stack gap="xs">
                  <Cluster justify="between" gap="sm" align="baseline">
                    <Cluster gap="sm" align="baseline">
                      <Text as="span" weight="medium">
                        {/* The code when the holding set resolved it; a generic
                            noun when it did not. Dropping the item would hide
                            work the user has to do. */}
                        {item.assetCode ?? t('pending.unknownAsset')}
                      </Text>
                      <Money value={item.quantity} kind="quantity" />
                    </Cluster>
                    <Button asChild variant="link" size="sm">
                      <Link href="/wallets">{t('pending.action')}</Link>
                    </Button>
                  </Cluster>
                  <Text as="span" size="xs" tone="muted">
                    {t(
                      item.reason === 'no_wallet'
                        ? 'pending.reasonNoWallet'
                        : 'pending.reasonAmbiguousSplit',
                    )}{' '}
                    {t('pending.consequence')}
                  </Text>
                </Stack>
              </ListItem>
            ),
          )}
        </List>
      )}
    </Section>
  );
}
