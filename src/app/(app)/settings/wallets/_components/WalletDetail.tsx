import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import {
  allocateAction,
  clearStandingRuleAction,
  deleteWalletAction,
  setStandingRuleAction,
  updateWalletAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, type WalletDetailData } from '@/app/(app)/wallets/data';
import { AllocateForm } from '@/app/(app)/settings/wallets/_components/AllocateForm';
import { WalletForm } from '@/app/(app)/settings/wallets/_components/WalletForm';
import { Money } from '@/app/money';
import { ActionForm } from '@/components/patterns/action-form';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field, FieldAction } from '@/components/patterns/field';
import { Section } from '@/components/patterns/section';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import { NodeTable, type NodeRow } from '@/components/patterns/node-table';
import { ranksOf, rankKeys } from '@/app/(app)/portfolio/_components/ranks';
import { formatQuantity } from '@/i18n/format';

/**
 * SPEC-022 BR-022-05 / SPEC-010 — one wallet's setup, on its own page: its
 * data, the assets assigned to it, assigning another, the standing rules that
 * point at it, and deleting it.
 *
 * **No portfolio figure.** The assigned assets show the quantity allocated —
 * setup data, stored by quantity (BR-010-04) — and not the cost, which lives
 * in Portfólio. The two links in the header are the way there: the wallet's
 * balancing and its goals.
 *
 * Not a tab of Carteiras (BR-022-15): it is one wallet, one task per section,
 * reached from the list and left through "Voltar às carteiras".
 */
export async function WalletDetail({ detail }: { readonly detail: WalletDetailData }) {
  const t = await getTranslations('wallets');
  const { wallet, allocations, unassigned, standingRules, rulesElsewhere, held, labels } = detail;

  const assetName = (assetId: Parameters<typeof labelFor>[1]) => {
    const label = labelFor(labels, assetId);
    return `${label.code} — ${label.name}`;
  };

  const ruled = new Set(standingRules.map((rule) => rule.assetId));
  const ruleCandidates = held.filter((assetId) => !ruled.has(assetId));
  const ruleElsewhere = new Map(rulesElsewhere.map((rule) => [rule.assetId, rule.walletName]));

  /*
   * SPEC-022 BR-022-18 — the two lists grow with the portfolio, so they are
   * tables: paged, filtered by asset, sorted. Cells are rendered here, on the
   * server (`Money`, masking), and the quantity sorts by its exact rank.
   */
  const allocationRanks = { quantity: ranksOf(allocations, (allocation) => allocation.quantity) };
  const allocationRows: NodeRow[] = allocations.map((allocation, index) => ({
    id: allocation.assetId,
    keys: { asset: assetName(allocation.assetId), ...rankKeys(allocationRanks, index) },
    cells: {
      asset: assetName(allocation.assetId),
      quantity: <Money value={allocation.quantity} kind="quantity" />,
    },
  }));
  const ruleRows: NodeRow[] = standingRules.map((rule) => ({
    id: rule.assetId,
    keys: { asset: assetName(rule.assetId) },
    cells: {
      asset: <span className="font-medium">{assetName(rule.assetId)}</span>,
      actions: (
        <Button
          type="submit"
          form={`clear-rule-${rule.assetId}`}
          size="sm"
          variant="outline"
          aria-label={t('standingRuleClearFor', { asset: labelFor(labels, rule.assetId).code })}
        >
          {t('standingRuleClear')}
        </Button>
      ),
    },
  }));

  return (
    <Stack gap="lg">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings/wallets">
            <ArrowLeft aria-hidden />
            {t('walletDetailBack')}
          </Link>
        </Button>
      </div>

      {/* SPEC-022 BR-022-36 — the wallet's name heads the panels below it,
          so it is a plain section with the links as its actions. */}
      <Section
        variant="plain"
        title={wallet.name}
        actions={
          <Cluster gap="sm">
            {/* SPEC-017 — the wallet's targets and the drift against them. */}
            <Button asChild variant="outline" size="sm">
              <Link href={`/portfolio/wallets?wallet=${wallet.id}`}>{t('balanceLink')}</Link>
            </Button>
            {/* SPEC-019 — the wallet's growth and earnings goals. */}
            <Button asChild variant="outline" size="sm">
              <Link href={`/portfolio/goals?wallet=${wallet.id}`}>{t('goalsLink')}</Link>
            </Button>
          </Cluster>
        }
      />

      <Section title={t('dataTitle')}>
        <div className="max-w-prose">
          <WalletForm
            action={updateWalletAction}
            idPrefix="wallet"
            submitLabel={t('save')}
            walletId={wallet.id}
            values={{
              name: wallet.name,
              description: wallet.description ?? '',
              goal: wallet.goal ?? '',
              color: wallet.color,
            }}
          />
        </div>
      </Section>

      <Section title={t('allocationsTitle')}>
        {allocations.length === 0 ? (
          <EmptyState title={t('allocationsEmpty')} />
        ) : (
          <NodeTable
            columns={[
              {
                id: 'asset',
                header: t('columnAsset'),
                kind: 'text',
                width: 40,
                sortable: true,
              },
              { id: 'quantity', header: t('columnQuantity'), kind: 'number', sortable: true },
            ]}
            rows={allocationRows}
            caption={t('allocationsTitle')}
            noun={t('assetNoun')}
            filterPlaceholder={t('filterAssetPlaceholder')}
            paramPrefix="allocations"
            sort={{ id: 'asset', desc: false }}
          />
        )}
      </Section>

      {/* BR-010-09 — the wallet screen is one of the places an asset is assigned. */}
      <Section title={t('assignTitle')} description={t('assignDescription')}>
        {unassigned.length === 0 ? (
          <EmptyState title={t('assignNothing')} description={t('assignNothingBody')} />
        ) : (
          <AllocateForm
            action={allocateAction}
            idPrefix="assign"
            fixed={{ name: 'walletId', value: wallet.id }}
            choice={{
              name: 'assetId',
              label: t('assignAsset'),
              placeholder: t('assignChooseAsset'),
              options: unassigned.map((holding) => ({
                value: holding.assetId,
                label: t('assignOption', {
                  asset: assetName(holding.assetId),
                  quantity: formatQuantity(holding.quantity),
                }),
              })),
            }}
            quantityHint={t('assignQuantityHint')}
            submitLabel={t('assignSubmit')}
          />
        )}
      </Section>

      {/* BR-010-14 — rules that route this asset's future purchases here. */}
      <Section title={t('rulesTitle')} description={t('standingRuleDescription')}>
        <Stack gap="md">
          {standingRules.length === 0 ? (
            <EmptyState title={t('rulesEmpty')} />
          ) : (
            <>
              <NodeTable
                columns={[
                  {
                    id: 'asset',
                    header: t('columnAsset'),
                    kind: 'text',
                    width: 40,
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
                caption={t('rulesTitle')}
                noun={t('ruleNoun')}
                filterPlaceholder={t('filterAssetPlaceholder')}
                paramPrefix="rules"
                sort={{ id: 'asset', desc: false }}
              />
              {/* DS-28 renders each cell twice, so a form never sits in one: the row's
                  button names its form here, outside the table, by `form`. */}
              {standingRules.map((rule) => (
                <ActionForm
                  key={rule.assetId}
                  id={`clear-rule-${rule.assetId}`}
                  action={clearStandingRuleAction}
                >
                  <input type="hidden" name="assetId" value={rule.assetId} />
                </ActionForm>
              ))}
            </>
          )}

          {ruleCandidates.length === 0 ? (
            <Text as="p" size="sm" tone="muted">
              {t('rulesNothing')}
            </Text>
          ) : (
            <ActionForm action={setStandingRuleAction}>
              <input type="hidden" name="walletId" value={wallet.id} />
              <Cluster gap="sm" align="start">
                <Field id="rule-asset" label={t('rulesAsset')} width="lg">
                  <NativeSelect name="assetId" required>
                    <option value="">{t('rulesChooseAsset')}</option>
                    {ruleCandidates.map((assetId) => (
                      <option key={assetId} value={assetId}>
                        {ruleElsewhere.has(assetId)
                          ? t('rulesOptionMoves', {
                              asset: assetName(assetId),
                              wallet: ruleElsewhere.get(assetId) ?? '',
                            })
                          : assetName(assetId)}
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
          )}
        </Stack>
      </Section>

      {/* BR-010-07 — said before it is done: nothing about the ledger changes. */}
      <Section title={t('deleteTitle')} description={t('deleteDescription')}>
        <ActionForm action={deleteWalletAction}>
          <input type="hidden" name="walletId" value={wallet.id} />
          <div>
            <Button type="submit" variant="destructive">
              {t('delete')}
            </Button>
          </div>
        </ActionForm>
      </Section>
    </Stack>
  );
}
