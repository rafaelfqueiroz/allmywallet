import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { AttentionItem } from '@/core/dashboard/summary';
import { describeGate, type GateResolution } from '@/core/onboarding/gates';
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
 * **Every item states its consequence and its resolution through `describeGate`
 * (SPEC-020 BR-020-15/18/19).** `core/onboarding/gates.ts` is the one place
 * that maps an `AttentionItem` to what it blocks (`GateConsequence`) and which
 * screen fixes it (`GateResolution`) — this component turns `resolution` into
 * an `href` and `consequence` into copy, and does not re-derive either. That
 * is also why a third `AttentionItem` kind (`fixed_income_rate`, added by
 * #97) only costs a new case in `gateHref` and a new `consequence.*` message,
 * rather than a second queue: BR-020-15 forbids a dedicated onboarding panel,
 * and this queue was always the "is there anything for me to do?" surface a
 * missing fixed-income rate belongs in.
 */
export async function AttentionQueue({
  items,
  total,
}: {
  readonly items: readonly AttentionItem[];
  /** The full count, which may exceed `items.length` — see `ATTENTION_QUEUE_LIMIT`. */
  readonly total: number;
}) {
  const t = await getTranslations('dashboard.attention');
  const hidden = total - items.length;

  return (
    <Section title={t('title')} description={t('description')}>
      {items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <List gap="md">
          {items.map((item) => {
            const gate = describeGate(item);
            const href = gateHref(gate.resolution);
            const consequence = t(`consequence.${gate.consequence}`);

            switch (item.kind) {
              case 'import_rows':
                return (
                  <ListItem key={`rows-${item.batchId}`} separated>
                    <Stack gap="xs">
                      <Cluster justify="between" gap="sm" align="baseline">
                        <Text as="span" weight="medium">
                          {t('importRows.label', { count: item.count })}
                        </Text>
                        <Button asChild variant="link" size="sm">
                          <Link href={href}>{t('importRows.action')}</Link>
                        </Button>
                      </Cluster>
                      <Text as="span" size="xs" tone="muted">
                        {consequence}
                      </Text>
                    </Stack>
                  </ListItem>
                );

              case 'fixed_income_rate':
                return (
                  <ListItem key={`fixed-income-${item.assetId}`} separated>
                    <Stack gap="xs">
                      <Cluster justify="between" gap="sm" align="baseline">
                        <Text as="span" weight="medium">
                          {item.assetCode ?? t('fixedIncomeRate.unknownAsset')}
                        </Text>
                        <Button asChild variant="link" size="sm">
                          <Link href={href}>{t('fixedIncomeRate.action')}</Link>
                        </Button>
                      </Cluster>
                      <Text as="span" size="xs" tone="muted">
                        {consequence}
                      </Text>
                    </Stack>
                  </ListItem>
                );

              case 'pending_allocation':
                return (
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
                          <Link href={href}>{t('pending.action')}</Link>
                        </Button>
                      </Cluster>
                      <Text as="span" size="xs" tone="muted">
                        {t(
                          item.reason === 'no_wallet'
                            ? 'pending.reasonNoWallet'
                            : 'pending.reasonAmbiguousSplit',
                        )}{' '}
                        {consequence}
                      </Text>
                    </Stack>
                  </ListItem>
                );
            }
          })}
        </List>
      )}

      {hidden > 0 && (
        /*
         * Said, not silently truncated. The ordinary first-week state — a full
         * extract imported and no wallet created yet — produces one item per
         * held asset, which at reference scale is a hundred rows that would
         * bury everything else on the screen. `/wallets` is where the work is
         * actually done and shows all of them with the forms to resolve each.
         *
         * Only pending allocations are ever hidden (`attentionQueue` never caps
         * a gate, SPEC-020 BR-020-18), so `/wallets` is the right destination
         * for everything this link counts.
         */
        <Button asChild variant="link" size="sm">
          <Link href="/wallets">{t('more', { count: hidden })}</Link>
        </Button>
      )}
    </Section>
  );
}

/**
 * `core/onboarding/gates.ts` names the screen (`GateResolution`); routes are
 * an `app/` concern (AR-04), so the mapping to a URL lives here rather than in
 * `core/`.
 */
function gateHref(resolution: GateResolution): string {
  switch (resolution.screen) {
    case 'import_batch':
      return `/import/${resolution.batchId}`;
    case 'fixed_income_contract':
      return `/fixed-income/${resolution.assetId}`;
    case 'wallets':
      return '/wallets';
  }
}
