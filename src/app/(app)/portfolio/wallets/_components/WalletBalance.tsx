import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { UserId, WalletId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { TARGET_MODES } from '@/core/wallets/targets';
import { DriftUnavailableReason } from '@/core/wallets/drift';
import { setWalletTargetsAction } from '@/app/(app)/wallets/actions';
import { TARGET_FIELD_PREFIX } from '@/app/(app)/wallets/target-fields';
import { labelFor, resolveAssetLabels } from '@/app/(app)/wallets/data';
import { loadWalletBalance } from '@/app/(app)/wallets/balance-data';
import { ActionForm } from '@/components/patterns/action-form';
import { FormActions, FormGrid } from '@/components/patterns/form-layout';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/app/money';
import { formatPercentPoints } from '@/i18n/format';
import { Note } from '@/components/patterns/note';
import { CellLabel } from '@/components/patterns/cell-label';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { ranksOf, rankKeys } from '@/lib/rank-keys';

/**
 * SPEC-017 — one wallet's targets, the drift against them, and the distance in
 * R$ and in cotas.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS NOT ALLOWED TO SAY.
 *
 * BR-017-19 / AC-12: no string here may recommend buying, selling, trimming or
 * rebalancing. Every figure is labelled as a **distance from the user's own
 * target** — the gap column is "Distância", its count "cotas", never "cotas a
 * comprar" — and `noAdviceNote` states that plainly at the foot of the table
 * rather than leaving the reader to infer it. The wording is reviewed by a
 * human and recorded in the PR (AC-12); no test can decide whether a sentence
 * reads as advice.
 *
 * **There is no chart, and that is the SPEC-016 BR-016-16 answer.** Every
 * figure is text in a table, as SPEC-012's Performance report is, so there is
 * no visual-only information to provide an alternative for. A drift chart
 * would also need drift *history*, which DL-017-06 excludes precisely so that
 * nothing on this screen can be restated later (BR-017-25).
 * ---------------------------------------------------------------------------
 *
 * SPEC-022 BR-022-02 / #208 — rendered as Portfólio › Carteiras when the scope
 * selector names a wallet. It was `/wallets/[id]/balance`, which redirects
 * here (BR-022-08).
 */
export async function WalletBalance({
  userId,
  walletId,
}: {
  readonly userId: UserId;
  readonly walletId: WalletId;
}) {
  const t = await getTranslations('balanceamento');
  const tp = await getTranslations('portfolio');
  const balance = await loadWalletBalance(userId, walletId);
  // A wallet deleted since the link was made: the tab says so (BR-011-16).
  if (balance === null) return null;

  const labels = await resolveAssetLabels([
    ...balance.rows.map((row) => row.assetId),
    ...balance.untargeted.map((row) => row.assetId),
  ]);
  const nameOf = (assetId: (typeof balance.rows)[number]['assetId']) =>
    `${labelFor(labels, assetId).code} — ${labelFor(labels, assetId).name}`;

  /*
   * SPEC-022 BR-022-18 — both tables page, filter and sort. Cells are rendered
   * here, on the server, through `Money` (masking, BR-022-24; no money crosses
   * as a number); every figure column sorts by its **rank**, from exact
   * `comparedTo` (`ranksOf`), and an unavailable figure has none, so it sorts
   * last in both directions rather than passing for zero (BR-017-21).
   */
  const unavailable = <Unavailable label={t('unavailable')} />;
  const balanceRanks = {
    value: ranksOf(balance.rows, (row) => row.value),
    target: ranksOf(balance.rows, (row) => row.targetPct),
    current: ranksOf(balance.rows, (row) => row.currentPct),
    drift: ranksOf(balance.rows, (row) => row.driftPp),
    gapValue: ranksOf(balance.rows, (row) => row.gap?.gapValue ?? null),
  };
  /*
   * SPEC-022 BR-022-41 — six columns, so the table fits the panel at 1280 px
   * (#245): the quantity sits under the value, and the count of cotas under
   * the distance in R$ it converts. Neither sorts any more; the value and the
   * distance they sit under still do.
   */
  const balanceColumns: NodeColumn[] = [
    { id: 'asset', header: t('columnAsset'), kind: 'text', width: 22, sortable: true },
    { id: 'value', header: t('columnValue'), kind: 'money', sortable: true },
    // Three percentages of at most `+100,00%` under one-word headers (Meta, Hoje,
    // Desvio): 10ch holds them, where the default's 12 is sized for "Participação".
    { id: 'target', header: t('columnTarget'), kind: 'percent', width: 10, sortable: true },
    { id: 'current', header: t('columnCurrent'), kind: 'percent', width: 10, sortable: true },
    { id: 'drift', header: t('columnDrift'), kind: 'percent', width: 10, sortable: true },
    { id: 'gapValue', header: t('columnGapValue'), kind: 'money', sortable: true },
  ];
  const balanceRows: NodeRow[] = balance.rows.map((row, index) => {
    const tradable = row.gap?.tradableShares ?? null;
    return {
      id: row.assetId,
      keys: { asset: nameOf(row.assetId), ...rankKeys(balanceRanks, index) },
      cells: {
        asset: (
          <CellLabel
            layout="stacked"
            detail={labelFor(labels, row.assetId).name}
            badge={
              row.outOfTolerance && (
                // SPEC-022 BR-022-31 — drift is a warning (DS-05).
                <Badge variant="warning">{t('outOfTolerance')}</Badge>
              )
            }
          >
            {labelFor(labels, row.assetId).code}
          </CellLabel>
        ),
        value: (
          <Stack gap="xs" align="end">
            <Money value={row.value} />
            <Text as="span" size="xs" tone="muted">
              {t.rich('quantityOf', {
                quantity: () => <Money value={row.quantity} kind="quantity" />,
              })}
            </Text>
          </Stack>
        ),
        target: <Money value={row.targetPct} kind="percentPoints" />,
        current:
          row.currentPct === null ? (
            unavailable
          ) : (
            <Money value={row.currentPct} kind="percentPoints" />
          ),
        drift:
          row.driftPp === null ? (
            unavailable
          ) : (
            <Money value={row.driftPp} kind="percentPoints" signed />
          ),
        gapValue:
          row.gap === null ? (
            unavailable
          ) : (
            <Stack gap="xs" align="end">
              <Money value={row.gap.gapValue} signed />
              {tradable === null ? (
                // No unit price (a zero quantity): no count exists to convert to.
                unavailable
              ) : (
                // BR-017-20: the count is arithmetic over a delayed quote, and
                // says so next to itself rather than in a footnote the reader has
                // to go and find.
                <Text as="span" size="xs" tone="muted" title={t('approximateHint')}>
                  {t.rich('gapShares', {
                    shares: () => <Money value={tradable} kind="quantity" signed />,
                  })}
                </Text>
              )}
            </Stack>
          ),
      },
    };
  });

  const untargetedRanks = {
    quantity: ranksOf(balance.untargeted, (row) => row.quantity),
    value: ranksOf(balance.untargeted, (row) => row.value),
  };
  const untargetedColumns: NodeColumn[] = [
    { id: 'asset', header: t('columnAsset'), kind: 'text', width: 30, sortable: true },
    { id: 'quantity', header: t('columnQuantity'), kind: 'number', sortable: true },
    { id: 'value', header: t('columnValue'), kind: 'money', sortable: true },
  ];
  const untargetedRows: NodeRow[] = balance.untargeted.map((row, index) => ({
    id: row.assetId,
    keys: { asset: nameOf(row.assetId), ...rankKeys(untargetedRanks, index) },
    cells: {
      asset: nameOf(row.assetId),
      quantity: <Money value={row.quantity} kind="quantity" />,
      value: <Money value={row.value} />,
    },
  }));

  return (
    <Stack gap="lg">
      {/* SPEC-022 BR-022-36 — a heading over the panels below, so plain. */}
      <Section
        variant="plain"
        title={tp('wallets.balanceTitle', { wallet: balance.walletName })}
        description={t('description')}
        actions={
          // Setup is the wallet's page in Configurações › Carteiras (#210,
          // BR-022-05); balancing is read here (BR-022-02).
          <Button asChild variant="link" size="sm">
            <Link href={`/settings/wallets/${balance.walletId}`}>{t('back')}</Link>
          </Button>
        }
      />

      {/*
        BR-017-11 / AC-7 — a wallet with nothing targetable in it gets an
        explanation, never an empty form. The explanation is the *reason*
        (a CDB before maturity cannot be sold, so its drift is uncorrectable),
        because "no targets here" without it reads as a missing feature.
      */}
      {!balance.hasTargetableAssets ? (
        <Section title={t('modeTitle')}>
          <EmptyState title={balance.untargeted.length === 0 ? t('empty') : t('onlyFixedIncome')} />
        </Section>
      ) : (
        <>
          <Section
            title={t('tableTitle')}
            description={t('toleranceHint', {
              tolerance: formatPct(balance.tolerancePp),
            })}
          >
            {/* SPEC-022 BR-022-36 — the notes qualify this table, so they sit in
                  its panel. BR-017-10 / AC-6 — what the targets actually cover, stated. */}
            <Note>
              {balance.targetedSharePct === null
                ? t('coverageUnknown')
                : balance.untargeted.length === 0
                  ? t('coverageAll')
                  : // AR-09: both percentages go through the single formatter, so
                    // "60,00%" beside "40,00%" cannot disagree about precision the
                    // way a hand-written one would.
                    t('coverage', {
                      covered: formatPercentPoints(balance.targetedSharePct),
                      rest: formatPercentPoints(
                        Quantity.fromString('100').minus(balance.targetedSharePct),
                      ),
                    })}
            </Note>

            {/* BR-017-07: the wallet is asking for a decision, and says which. */}
            {balance.needsReview && (
              <Note>
                {t('needsReview', {
                  total: formatPercentPoints(
                    balance.rows.reduce((sum, row) => sum.plus(row.targetPct), Quantity.zero()),
                  ),
                })}
              </Note>
            )}

            {/* BR-017-21 / AC-13 — an absence, stated, rather than a computed figure. */}
            {balance.unavailableReason !== null && (
              <Note>
                {balance.unavailableReason === DriftUnavailableReason.PRICE_UNUSABLE
                  ? t('unavailablePrice', {
                      assets: balance.unpricedAssetIds.map(nameOf).join(', '),
                    })
                  : t('unavailableNoValue')}
              </Note>
            )}
            {/* BR-017-19 — stated, not implied. Above the table, which closes its panel. */}
            <Note>{t('noAdviceNote')}</Note>
            <NodeTable
              columns={balanceColumns}
              rows={balanceRows}
              caption={t('tableCaption')}
              noun={t('noun')}
              filterPlaceholder={t('filterPlaceholder')}
              paramPrefix="balance"
              sort={{ id: 'asset', desc: false }}
              // A wallet whose target mode is `none` has targetable assets but
              // no rows (`balance.rows` is empty): say so rather than showing
              // headers over nothing and "Mostrando 0–0 de 0" (BR-022-18).
              empty={
                <EmptyState title={t('balanceEmptyTitle')} description={t('balanceEmptyBody')} />
              }
            />
          </Section>

          {/* SPEC-022 BR-022-37 — the standard form: the mode and one short
              field per asset, two to a row, the discard confirmation across
              both columns, and Cancelar then Salvar at the footer's right. */}
          <ActionForm
            action={setWalletTargetsAction}
            panel={{
              title: t('targetsTitle'),
              description: t('modeHint'),
              footer: (
                <FormActions
                  cancel={
                    <Button type="reset" variant="outline">
                      {t('cancel')}
                    </Button>
                  }
                >
                  <Button type="submit">{t('save')}</Button>
                </FormActions>
              ),
            }}
          >
            <input type="hidden" name="walletId" value={balance.walletId} />
            <FormGrid>
              <Field id="target-mode" label={t('modeLabel')}>
                <NativeSelect name="mode" defaultValue={balance.mode}>
                  {TARGET_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(
                        mode === 'none'
                          ? 'modeNone'
                          : mode === 'equal_weight'
                            ? 'modeEqualWeight'
                            : 'modeManual',
                      )}
                    </option>
                  ))}
                </NativeSelect>
              </Field>

              {/*
                Every targetable holding gets a field, always — including in
                equal-weight mode, where the values are what `100 / n`
                currently derives. Switching the select to Manual then starts
                from what is on screen rather than from an empty form, and
                BR-017-05's "stores nothing" is unaffected: these are only
                read when the submitted mode is manual.
              */}
              {balance.rows.map((row) => (
                <Field
                  key={row.assetId}
                  id={`${TARGET_FIELD_PREFIX}${row.assetId}`}
                  label={t('targetPctLabel', { asset: labelFor(labels, row.assetId).code })}
                >
                  <Input
                    name={`${TARGET_FIELD_PREFIX}${row.assetId}`}
                    inputMode="decimal"
                    defaultValue={formatPct(row.targetPct)}
                  />
                </Field>
              ))}

              {/* BR-017-08 / AC-5 — named, and only then discarded. */}
              {balance.mode === 'manual' && (
                <Cluster gap="sm" align="center" className="col-span-full">
                  <Checkbox id="confirm-discard" name="confirmDiscard" />
                  <Label htmlFor="confirm-discard">{t('discardConfirm')}</Label>
                  <Text as="span" size="xs" tone="muted">
                    {t('discardWarning', { count: balance.rows.length })}
                  </Text>
                </Cluster>
              )}
            </FormGrid>
          </ActionForm>
        </>
      )}

      {/* BR-017-09/10 — the part of the wallet the targets never cover. */}
      <Section title={t('untargetedTitle')} description={t('untargetedDescription')}>
        {balance.untargeted.length === 0 ? (
          <EmptyState title={t('untargetedEmpty')} />
        ) : (
          <NodeTable
            columns={untargetedColumns}
            rows={untargetedRows}
            caption={t('untargetedTitle')}
            noun={t('noun')}
            filterPlaceholder={t('filterPlaceholder')}
            paramPrefix="untargeted"
            sort={{ id: 'asset', desc: false }}
          />
        )}
      </Section>
    </Stack>
  );
}

/** An em dash reads as "nothing here"; this has to read as "we will not say" (BR-017-21). */
function Unavailable({ label }: { label: string }) {
  return (
    <Text as="span" size="xs" tone="muted">
      {label}
    </Text>
  );
}

/**
 * The target editor's fields are text inputs, so their default values have to
 * be strings — the one place a percentage is written by hand rather than by
 * `Money`. Two decimal places, matching what the formatter renders beside it.
 */
function formatPct(value: Quantity): string {
  return value.toDecimal().toFixed(2);
}
