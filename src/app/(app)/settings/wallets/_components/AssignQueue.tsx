import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  allocateAction,
  clearStandingRuleAction,
  setStandingRuleAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, type loadWalletsPageData } from '@/app/(app)/wallets/data';
import { AllocateForm } from '@/app/(app)/settings/wallets/_components/AllocateForm';
import { ranksOf, rankKeys } from '@/lib/rank-keys';
import { Money } from '@/app/money';
import { ActionForm } from '@/components/patterns/action-form';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field, FieldAction } from '@/components/patterns/field';
import { NodeTable, type NodeRow } from '@/components/patterns/node-table';
import { QueryLink } from '@/components/patterns/query-link';
import { RowForms } from '@/components/patterns/row-forms';
import { Section } from '@/components/patterns/section';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';

type WalletsPageData = Awaited<ReturnType<typeof loadWalletsPageData>>;

/** The id the "Resolver" links scroll to — the panel the forms sit in. */
export const RESOLVE_ANCHOR = 'resolver';

/**
 * SPEC-010 BR-010-12/13/14 — Configurações › Carteiras › **Atribuir ativos**:
 * the "Precisa de atenção" queue with its resolve forms, and the standing rules
 * with the way to remove each. This is where the Painel's "Distribuir" items
 * land (SPEC-020 BR-020-18).
 *
 * It lists **names, links and allocated quantities** — setup data. The
 * out-of-balance wallets (SPEC-017 BR-017-17) are here as a name and a link to
 * their balancing in Portfólio; the figures that make them out of balance are
 * there, not here (BR-022-05).
 *
 * ---------------------------------------------------------------------------
 * SPEC-022 BR-022-18 — **the queue is a table, and its forms are not in it.**
 *
 * The queue and the rules grow with the portfolio, so each is a paged, sorted,
 * filterable `DataTable`. A resolve form has a select, a quantity and a
 * submit; `DataTable` renders every cell twice (DS-28), which would post every
 * field twice and duplicate every id, so **no form sits in a cell**. A row has
 * a link, "Resolver", to the panel below the queue (`?resolve=<asset>`), which
 * holds the two forms for that one asset — the same forms, with the same
 * pre-filled remainder (BR-010-13). It opens on the first asset in the queue
 * when none is named, so resolving a queue is one asset after another without
 * the extra click. The rules' "Remover regra" buttons name a form outside the
 * table through their `form` attribute.
 * ---------------------------------------------------------------------------
 */
export async function AssignQueue({
  walletChoices,
  pending,
  standingRules,
  unbalanced,
  labels,
  resolve,
}: {
  readonly walletChoices: readonly { readonly id: string; readonly name: string }[];
  readonly pending: WalletsPageData['pending'];
  readonly standingRules: WalletsPageData['standingRules'];
  readonly unbalanced: WalletsPageData['unbalanced'];
  readonly labels: WalletsPageData['labels'];
  /** The asset the reader asked to resolve (`?resolve=`), when it is still pending. */
  readonly resolve?: string | undefined;
}) {
  const t = await getTranslations('wallets');

  const walletOptions = walletChoices.map((wallet) => ({ value: wallet.id, label: wallet.name }));
  const assetName = (assetId: Parameters<typeof labelFor>[1]) => {
    const label = labelFor(labels, assetId);
    return `${label.code} — ${label.name}`;
  };

  // A named asset that has since been resolved falls back to the first one.
  const resolving = pending.find((item) => item.assetId === resolve) ?? pending[0];

  const unbalancedRows: NodeRow[] = unbalanced.map((balance) => {
    const status = balance.outOfBalance
      ? t('needsAttentionOutOfBalanceStatus')
      : t('needsAttentionNeedsReviewStatus');
    return {
      id: balance.walletId,
      keys: { wallet: balance.walletName, status },
      cells: {
        wallet: <span className="font-medium">{balance.walletName}</span>,
        status,
        actions: (
          <Button asChild variant="link" size="sm">
            <Link href={`/portfolio/wallets?wallet=${balance.walletId}`}>
              {t('needsAttentionBalanceOpen')}
            </Link>
          </Button>
        ),
      },
    };
  });

  const pendingRanks = {
    quantity: ranksOf(pending, (item) => item.unassignedQuantity),
  };
  const pendingRows: NodeRow[] = pending.map((item, index) => {
    const reason = t(item.reason === 'no_wallet' ? 'reasonNoWallet' : 'reasonAmbiguousSplit');
    return {
      id: item.assetId,
      keys: { asset: assetName(item.assetId), reason, ...rankKeys(pendingRanks, index) },
      cells: {
        asset: <span className="font-medium">{assetName(item.assetId)}</span>,
        quantity: <Money value={item.unassignedQuantity} kind="quantity" />,
        reason,
        actions: (
          <Button asChild variant="outline" size="sm">
            {/* Keeps the tables' own sort, page and filter (see `QueryLink`). */}
            <QueryLink
              set={{ resolve: item.assetId }}
              hash={RESOLVE_ANCHOR}
              aria-label={t('resolveOpenFor', { asset: labelFor(labels, item.assetId).code })}
            >
              {t('resolveOpen')}
            </QueryLink>
          </Button>
        ),
      },
    };
  });

  const ruleRows: NodeRow[] = standingRules.map((rule) => {
    const label = labelFor(labels, rule.assetId);
    const wallet = walletChoices.find((choice) => choice.id === rule.walletId);
    // A deleted wallet takes its rules with it (BR-010-07), so this fallback
    // should be unreachable — rendering the id rather than crashing keeps a
    // stale row revocable.
    const walletName = wallet?.name ?? rule.walletId;
    return {
      id: rule.assetId,
      keys: { asset: assetName(rule.assetId), wallet: walletName },
      cells: {
        asset: <span className="font-medium">{assetName(rule.assetId)}</span>,
        wallet: walletName,
        actions: (
          <Button
            type="submit"
            form={`clear-rule-${rule.assetId}`}
            size="sm"
            variant="outline"
            aria-label={t('standingRuleClearFor', { asset: label.code })}
          >
            {t('standingRuleClear')}
          </Button>
        ),
      },
    };
  });

  return (
    <>
      {(pending.length > 0 || unbalanced.length === 0) && (
        <Section title={t('needsAttentionTitle')} description={t('needsAttentionDescription')}>
          {pending.length === 0 ? (
            <EmptyState title={t('needsAttentionEmpty')} />
          ) : (
            <NodeTable
              columns={[
                {
                  id: 'asset',
                  header: t('columnAsset'),
                  kind: 'text',
                  width: 26,
                  sortable: true,
                },
                {
                  id: 'quantity',
                  header: t('columnUnassigned'),
                  kind: 'number',
                  sortable: true,
                },
                {
                  id: 'reason',
                  header: t('columnReason'),
                  kind: 'text',
                  width: 34,
                  sortable: true,
                },
                {
                  id: 'actions',
                  header: t('columnActions'),
                  kind: 'control',
                  width: '8rem',
                  srOnlyHeader: true,
                },
              ]}
              rows={pendingRows}
              caption={t('needsAttentionPendingCaption')}
              noun={t('assetNoun')}
              filterPlaceholder={t('filterAssetPlaceholder')}
              paramPrefix="pending"
              sort={{ id: 'asset', desc: false }}
            />
          )}
        </Section>
      )}

      {/*
        SPEC-017 BR-017-17 / DL-017-08 — out-of-balance wallets land in **this**
        queue rather than a new one. SPEC-010 BR-010-12 already established
        one place to look for "is there anything for me to do?", and a second
        surface splits the answer across two screens. Each links to the
        wallet's balancing in Portfólio. A panel of its own: a table's pager
        closes the panel it is in, so two tables never share one.
      */}
      {unbalanced.length > 0 && (
        <Section title={t('unbalancedTitle')} description={t('unbalancedDescription')}>
          <NodeTable
            columns={[
              {
                id: 'wallet',
                header: t('columnWallet'),
                kind: 'text',
                width: 28,
                sortable: true,
              },
              {
                id: 'status',
                header: t('columnStatus'),
                kind: 'text',
                width: 44,
                sortable: true,
              },
              {
                id: 'actions',
                header: t('columnActions'),
                kind: 'control',
                width: '10rem',
                srOnlyHeader: true,
              },
            ]}
            rows={unbalancedRows}
            caption={t('needsAttentionUnbalancedCaption')}
            noun={t('walletNoun')}
            filterPlaceholder={t('list.search')}
            paramPrefix="unbalanced"
            sort={{ id: 'wallet', desc: false }}
          />
        </Section>
      )}

      {resolving !== undefined && (
        <Section
          id={RESOLVE_ANCHOR}
          title={t('resolveTitle', { asset: assetName(resolving.assetId) })}
          description={t('resolveDescription')}
          className="scroll-mt-20"
        >
          {/* Keyed on the asset: another asset's forms start from their own defaults. */}
          <Stack key={resolving.assetId} gap="sm">
            <Cluster gap="sm" align="baseline">
              <Text as="span" size="sm">
                {t('resolveUnassigned')}:
              </Text>
              <Money value={resolving.unassignedQuantity} kind="quantity" />
              <Text as="span" size="xs" tone="muted">
                {t(resolving.reason === 'no_wallet' ? 'reasonNoWallet' : 'reasonAmbiguousSplit')}
              </Text>
            </Cluster>
            <Cluster gap="lg" align="start">
              {/* BR-010-13: one action, quantity pre-filled with the unassigned remainder. */}
              <AllocateForm
                action={allocateAction}
                idPrefix={`allocate-${resolving.assetId}`}
                fixed={{ name: 'assetId', value: resolving.assetId }}
                choice={{
                  name: 'walletId',
                  label: t('resolveAssign'),
                  placeholder: t('chooseWallet'),
                  options: walletOptions,
                }}
                defaultQuantity={resolving.unassignedQuantity.toString()}
                submitLabel={t('resolveSubmit')}
              />

              {/* BR-010-14: the escape hatch — a standing rule for this asset. */}
              <ActionForm action={setStandingRuleAction}>
                <input type="hidden" name="assetId" value={resolving.assetId} />
                <Cluster gap="sm" align="start">
                  <Field
                    id={`standing-rule-${resolving.assetId}`}
                    label={t('standingRuleTitle')}
                    width="md"
                  >
                    <NativeSelect name="walletId" required>
                      <option value="">{t('chooseWallet')}</option>
                      {walletOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <FieldAction>
                    <Button type="submit" variant="outline">
                      {t('standingRuleSet')}
                    </Button>
                  </FieldAction>
                </Cluster>
              </ActionForm>
            </Cluster>
          </Stack>
        </Section>
      )}

      {/*
        BR-010-14 / #61 — the rules, visible and revocable. Rendered only when
        there is at least one: an empty section explaining a feature nobody has
        used is noise on the screen whose job is the queue above.
      */}
      {standingRules.length > 0 && (
        <Section title={t('standingRuleTitle')} description={t('standingRuleDescription')}>
          <NodeTable
            columns={[
              {
                id: 'asset',
                header: t('columnAsset'),
                kind: 'text',
                width: 28,
                sortable: true,
              },
              {
                id: 'wallet',
                header: t('standingRuleCurrent'),
                kind: 'text',
                width: 28,
                sortable: true,
              },
              {
                id: 'actions',
                header: t('columnActions'),
                kind: 'control',
                width: '10rem',
                srOnlyHeader: true,
              },
            ]}
            rows={ruleRows}
            caption={t('standingRuleTitle')}
            noun={t('ruleNoun')}
            filterPlaceholder={t('filterAssetPlaceholder')}
            paramPrefix="rules"
            sort={{ id: 'asset', desc: false }}
          />
          {/* DS-28 renders each cell twice, so a form never sits in one: each row's
              button names its form here, outside the table, by `form`. */}
          <RowForms>
            {standingRules.map((rule) => (
              <ActionForm
                key={rule.assetId}
                id={`clear-rule-${rule.assetId}`}
                action={clearStandingRuleAction}
              >
                <input type="hidden" name="assetId" value={rule.assetId} />
              </ActionForm>
            ))}
          </RowForms>
        </Section>
      )}
    </>
  );
}
