import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ImportBatchId } from '@/core/shared/ids';
import { positionKeyString } from '@/core/positions/replay';
import { SystemClock } from '@/core/shared/clock';
import { currencyText, formatBusinessDate, formatDateTime, formatQuantity } from '@/i18n/format';
import type { RowRefusal } from '@/core/ingestion/refusal';
import type { CorporateEventOutcome } from '@/core/ingestion/corporate-event-resolution';
import { ratioPrefillFor } from '@/core/ingestion/corporate-event-evidence';
import type { SubscriptionOffer } from '@/core/ingestion/subscription-offer';
import {
  acceptAdjustmentAction,
  cancelBatchAction,
  classifyRowAction,
  commitBatchAction,
  keepSubscriptionClassificationAction,
  resolveSubscriptionOfferAction,
} from '@/app/(app)/import/actions';
import { loadImportBatchDetail } from '@/app/(app)/import/data';
import { ClassifyForm } from '@/app/(app)/settings/import/[batchId]/_components/ClassifyForm';
import { ignoredRow } from '@/app/(app)/settings/import/[batchId]/_components/IgnoredRow';
import { OpenOnHash } from '@/app/(app)/settings/import/[batchId]/_components/OpenOnHash';
import {
  rowIdentityCells,
  rowIdentityColumns,
} from '@/app/(app)/settings/import/[batchId]/_components/RowCells';
import {
  ROW_TABLE_PREFIX,
  rowPage,
  rowTableAddressed,
} from '@/app/(app)/settings/import/[batchId]/_components/row-pages';
import {
  SubscriptionOfferPanel,
  type SubscriptionOfferLabels,
} from '@/app/(app)/settings/import/[batchId]/_components/SubscriptionOfferPanel';
import { corporateEventRefusalKey } from '@/app/(app)/settings/import/[batchId]/_components/corporate-event-refusal';
import { labelFor, resolveAssetLabels } from '@/app/(app)/wallets/data';
import { loadWalletOptions, walletName } from '@/app/(app)/import/wallet-options';
import { IMPORT_HISTORY_PATH } from '@/lib/import-paths';
import {
  BATCH_STATUS_VARIANT,
  typeDetected,
} from '@/app/(app)/settings/import/_components/batch-status';
import { SettingsBackLink, SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { allocateAction } from '@/app/(app)/wallets/actions';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { FormActions } from '@/components/patterns/form-layout';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Money } from '@/app/money';
import { loadHideValues } from '@/app/hide-values';
import { MoneyMask } from '@/components/patterns/money-mask';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/native-select';
import { Text } from '@/components/ui/text';
import { NodeTable, type NodeRow } from '@/components/patterns/node-table';

/**
 * SPEC-005 BR-005-10/11/19/20/22..26 — the preview: accurate counts, the
 * Needs Attention queue with manual classification, commit/cancel, and the
 * reconciliation report with accept-as-adjustment.
 *
 * SPEC-022 BR-022-05/18 (#211) — one batch's page under Configurações ›
 * Importar, reached from Histórico; it was `/import/[batchId]`, which
 * redirects here (BR-022-08). Not a task, so its way back to Histórico sits
 * where the task tabs would (BR-022-16). Its rows render as tables: a row is
 * an asset, a movement and a date, read across, and the decision about it sits
 * at the end of the same line.
 * Each is a server-paged `DataTable` (DS-66, through `NodeTable`): 10, 25 or 50
 * rows a page, kept in the URL under a prefix of its own (`row-pages.ts`), so a
 * file of thousands of mirrored settlements is not one page of thousands of
 * forms. They render **without a card copy** (`cards={false}`): their cells hold
 * the decision about the row — a classify form, an allocation form — and a
 * second, hidden copy of each would repeat its ids and field names (DS-28). On
 * a phone they scroll inside their panel, as the plain tables they replace did.
 * Not sortable: the page holds the batch's rows in file order and there is no
 * query to order them by.
 */
export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { batchId: rawBatchId } = await params;
  const query = await searchParams;
  const t = await getTranslations('import');
  const tReports = await getTranslations('reports');
  const userId = await tryUserId();

  if (userId === undefined) {
    const ts = await getTranslations('settings');
    return (
      <PageShell title={ts('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawBatchId)) notFound();
  const batchId = ImportBatchId.of(rawBatchId);
  const detail = await loadImportBatchDetail(userId, batchId);
  if (detail === null) notFound();

  const {
    batch,
    rows,
    needsAttention,
    ignored,
    summary,
    acceptBlockers,
    refusals,
    corporateEvents,
    subscriptionOffers,
  } = detail;
  // SPEC-005 #117 BR-005-24: a refused row says why, with the figures behind it.
  const refusalText = (refusal: RowRefusal) => {
    switch (refusal.kind) {
      case 'insufficient_quantity':
        return t('refusal.insufficient_quantity', {
          date: formatBusinessDate(refusal.date),
          held: formatQuantity(refusal.held),
          requested: formatQuantity(refusal.requested),
        });
      case 'conflicts_with_ledger':
        return t('refusal.conflicts_with_ledger', { date: formatBusinessDate(refusal.date) });
      // SPEC-005 BR-005-20a (#135): one leg of a same-position transfer pair.
      case 'unresolved_transfer_pair':
        return t('refusal.unresolved_transfer_pair', { date: formatBusinessDate(refusal.date) });
      // SPEC-007 BR-007-05c (#166): an amortization with no defined principal.
      case 'amortization_not_supported':
        return t('refusal.amortization_not_supported', { date: formatBusinessDate(refusal.date) });
      case 'amortization_outside_schedule':
        return t('refusal.amortization_outside_schedule', {
          date: formatBusinessDate(refusal.date),
          firstPayment: formatBusinessDate(refusal.firstPayment),
          lastPayment: formatBusinessDate(refusal.lastPayment),
        });
      default:
        return t(`refusal.${refusal.kind}`);
    }
  };
  // SPEC-005 BR-005-24: the likely explanation for an insufficient-quantity
  // refusal — missing history, an uncaptured corporate event, or an
  // unclassified row on the same position — read off the current ledger.
  const refusalCauseText = (refusal: RowRefusal) =>
    refusal.kind === 'insufficient_quantity' && refusal.likelyCause !== null
      ? t(`refusal.cause.${refusal.likelyCause}`)
      : null;
  const corporateEventEvidence = (outcome: CorporateEventOutcome) => {
    const refusal =
      outcome.status === 'refused'
        ? outcome.refusal
        : batch.status === 'committed'
          ? 'conflicts_with_ledger'
          : null;

    return (
      <Stack gap="xs">
        {(outcome.movement === 'desdobro' || outcome.movement === 'grupamento') && (
          <>
            <Text as="span" size="xs">
              {t('corporateEvent.figures', {
                basis:
                  outcome.evidence.basis === null
                    ? t('corporateEvent.unavailable')
                    : formatQuantity(outcome.evidence.basis),
                stated: formatQuantity(outcome.evidence.stated),
                derived:
                  outcome.evidence.derivedRatio === null
                    ? t('corporateEvent.unavailable')
                    : formatQuantity(outcome.evidence.derivedRatio),
              })}
            </Text>
            {outcome.evidence.factors.length === 0 ? (
              <Text as="span" size="xs" tone="muted">
                {t('corporateEvent.noFactor')}
              </Text>
            ) : (
              outcome.evidence.factors.map((factor) => (
                <Text
                  as="span"
                  size="xs"
                  tone="muted"
                  key={`${factor.kind}:${factor.lastDatePrior}:${factor.factorPublished}`}
                >
                  {t('corporateEvent.factor', {
                    factor: factor.factorPublished.replace('.', ','),
                    multiplier: formatQuantity(factor.multiplier),
                    date: formatBusinessDate(factor.lastDatePrior),
                  })}
                </Text>
              ))
            )}
          </>
        )}
        {refusal === null ? (
          <Text as="span" size="xs">
            {t('corporateEvent.willResolve')}
          </Text>
        ) : (
          <Text as="span" size="xs">
            {t(`corporateEvent.refusal.${corporateEventRefusalKey(refusal)}`)}
          </Text>
        )}
      </Stack>
    );
  };
  // SPEC-022 BR-022-24/26: the close price sits inside a sentence handed to a
  // Client Component. Masked, the `<price>` tag renders `MoneyMask` — the
  // placeholder with its "Valor oculto" name — and the figure is never
  // formatted into the sentence at all.
  const masked = await loadHideValues();
  const formatClose = currencyText(masked);
  // SPEC-005 BR-005-20d (#157, DL-005-25): the pairing sentence and the
  // stored-close price hint (or the reason it is missing), all pre-translated
  // (AR-44) so `SubscriptionOfferPanel` stays a plain component with no
  // `next-intl` server machinery in its own test.
  const subscriptionOfferLabels = (offer: SubscriptionOffer): SubscriptionOfferLabels => ({
    pairing: t('subscriptionOffer.pairing', {
      quantity: formatQuantity(offer.quantity),
      assetCode: offer.creditAssetCode,
      date: formatBusinessDate(offer.tradeDate),
      type: t(`transactionType.${offer.creditType}`),
    }),
    priceHint:
      offer.close === null
        ? null
        : t.rich('subscriptionOffer.priceHint', {
            closeDate: formatBusinessDate(offer.close.date),
            closeValue: formatClose(offer.close.close),
            price: (chunks) => (masked ? <MoneyMask /> : chunks),
          }),
    closeMissingReason: offer.close === null ? t('subscriptionOffer.closeMissing') : null,
    estimateExplanation: tReports('markers.costEstimated.explanation'),
    resolve: t('subscriptionOffer.resolve'),
    keep: t('subscriptionOffer.keep'),
  });
  const classifyForm = (rowId: string, outcome?: CorporateEventOutcome) => (
    <ClassifyForm
      rowId={rowId}
      action={classifyRowAction}
      defaultRatio={outcome === undefined ? null : ratioPrefillFor(outcome)}
      labels={{
        type: t('classifyLabel'),
        ratio: t('classifyRatioLabel'),
        ratioHint: t('classifyRatioHint'),
        submit: t('classifySubmit'),
        typeName: (type) => t(`transactionType.${type}`),
      }}
    />
  );
  const walletOptions = summary === null ? [] : await loadWalletOptions(userId);
  const labels =
    summary === null
      ? new Map()
      : await resolveAssetLabels(summary.assets.map((asset) => asset.assetId));
  const canCommit = batch.status === 'previewed';
  const canCancel = batch.status === 'pending' || batch.status === 'previewed';
  const today = new SystemClock().today();

  // SPEC-022 BR-022-18 — each table pages on its own prefixed URL parameters.
  const summaryPage = rowPage(summary?.assets ?? [], query, 'summary');
  const attentionPage = rowPage(needsAttention, query, 'attention');
  const ignoredPage = rowPage(ignored, query, 'ignored');
  const identityColumns = rowIdentityColumns({
    asset: t('rows.columnAsset'),
    movement: t('rows.columnMovement'),
    date: t('rows.columnDate'),
  });

  const summaryRows: NodeRow[] = summaryPage.rows.map((asset) => {
    const label = labelFor(labels, asset.assetId);
    return {
      id: asset.assetId,
      cells: {
        asset: (
          <Stack gap="none">
            {/* BR-022-18: each line ends in its own ellipsis in a narrow column. */}
            <span className="truncate font-medium">{label.code}</span>
            <Text as="span" size="xs" tone="muted" className="truncate">
              {label.name}
            </Text>
          </Stack>
        ),
        imported: <Money value={asset.importedQuantity} kind="quantity" />,
        wallets: (
          <Text as="span" size="xs" tone="muted">
            {asset.destinations.length === 0
              ? t('summary.unassigned')
              : asset.destinations
                  .map(
                    (destination) =>
                      `${walletName(walletOptions, destination.walletId)}: ${destination.quantity.toString()}`,
                  )
                  .join(' · ')}
          </Text>
        ),
        // BR-010-13: resolvable here, in one action, with the quantity
        // pre-filled — the same form the wallets screen offers, because it is
        // the same decision.
        assign: asset.pending !== null && (
          <ActionForm action={allocateAction}>
            <input type="hidden" name="assetId" value={asset.assetId} />
            <Cluster gap="sm" align="end">
              <Field id={`summary-wallet-${asset.assetId}`} label={t('summary.assign')} width="lg">
                <NativeSelect name="walletId" required>
                  <option value="">{t('summary.chooseWallet')}</option>
                  {walletOptions.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {wallet.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                id={`summary-quantity-${asset.assetId}`}
                label={t('summary.quantity')}
                width="sm"
              >
                <Input name="quantity" defaultValue={asset.pending.unassignedQuantity.toString()} />
              </Field>
              <Button type="submit" size="sm">
                {t('summary.resolve')}
              </Button>
            </Cluster>
          </ActionForm>
        ),
      },
    };
  });

  const attentionRows: NodeRow[] = attentionPage.rows.map((row) => {
    const corporateEvent = corporateEvents.get(row.id);
    const subscriptionOffer = subscriptionOffers.get(row.id);
    return {
      id: row.id,
      cells: {
        ...rowIdentityCells(row),
        detail: (
          <Stack gap="xs" className="whitespace-normal">
            {refusals.has(row.id) && (
              <Text as="span" size="xs">
                {refusalText(refusals.get(row.id) as RowRefusal)}
              </Text>
            )}
            {refusals.has(row.id) &&
              refusalCauseText(refusals.get(row.id) as RowRefusal) !== null && (
                <Text as="span" size="xs" tone="muted">
                  {refusalCauseText(refusals.get(row.id) as RowRefusal)}
                </Text>
              )}
            {corporateEvent !== undefined && corporateEventEvidence(corporateEvent)}
          </Stack>
        ),
        // SPEC-005 BR-005-20d (#157): an offered exercise never gets the
        // generic classify form — classifying it as any type would count its
        // shares a second time, on top of what its credit already added (#157
        // description).
        action:
          subscriptionOffer !== undefined ? (
            <SubscriptionOfferPanel
              rowId={row.id}
              resolveAction={resolveSubscriptionOfferAction}
              keepAction={keepSubscriptionClassificationAction}
              labels={subscriptionOfferLabels(subscriptionOffer)}
            />
          ) : (
            row.classification === 'unclassified' && classifyForm(row.id, corporateEvent)
          ),
      },
    };
  });

  const ignoredRows: NodeRow[] = ignoredPage.rows.map((row) =>
    ignoredRow({
      row,
      committed: batch.status === 'committed',
      resolvedExerciseLabel: t('ignored.resolvedExercise'),
      classifyForm,
    }),
  );

  // BR-005-25 (#110): no button where accepting would be refused.
  const discrepancyRows: NodeRow[] = (batch.reconciliation?.discrepancies ?? []).map((d) => {
    const blocker = acceptBlockers.get(positionKeyString(d));
    return {
      id: positionKeyString(d),
      cells: {
        asset: <span className="font-medium">{d.assetCode}</span>,
        computed: d.computedQuantity,
        b3: d.b3Quantity,
        difference: d.difference,
        cause: (
          <Text as="span" size="xs" tone="muted">
            {t(`discrepancyCause.${d.cause}`)}
          </Text>
        ),
        action: d.resolved ? (
          <Text as="span" size="xs" tone="muted">
            {t('resolved')}
          </Text>
        ) : blocker !== undefined ? (
          <Text as="span" size="xs" tone="muted" className="whitespace-normal">
            {t(`acceptAdjustmentBlocked.${blocker}`)}
          </Text>
        ) : (
          <ActionForm action={acceptAdjustmentAction}>
            <input type="hidden" name="batchId" value={batch.id} />
            <input type="hidden" name="assetId" value={d.assetId} />
            {d.institutionId && (
              <input type="hidden" name="institutionId" value={d.institutionId} />
            )}
            <Button type="submit" size="xs" variant="outline">
              {t('acceptAdjustment')}
            </Button>
          </ActionForm>
        ),
      },
    };
  });

  return (
    <SettingsFrame
      tasks={<SettingsBackLink href={IMPORT_HISTORY_PATH}>{t('detailBack')}</SettingsBackLink>}
    >
      {/* SPEC-022 BR-022-36 — the batch itself is a panel: its type as the
          title, its status beside it, the counts inside, and commit/cancel in
          the footer. */}
      <Section
        title={typeDetected(batch) ? t(`extractType.${batch.source}`) : t('extractTypeUnknown')}
        description={t('uploadedAt', { date: formatDateTime(batch.uploadedAt) })}
        // BR-022-31 — the same semantic badge as Histórico.
        actions={
          <Badge dot variant={BATCH_STATUS_VARIANT[batch.status]}>
            {t(`status.${batch.status}`)}
          </Badge>
        }
        // SPEC-022 BR-022-37 — the footer's order: cancelling the import is
        // destructive, alone at the left; confirming it is the primary action,
        // at the right. Two forms, so neither posts the other's fields.
        footer={
          canCommit || canCancel ? (
            <FormActions
              destructive={
                canCancel ? (
                  <form action={cancelBatchAction}>
                    <input type="hidden" name="batchId" value={batch.id} />
                    <Button type="submit" variant="destructive">
                      {t('cancel')}
                    </Button>
                  </form>
                ) : undefined
              }
            >
              {canCommit && (
                <form action={commitBatchAction}>
                  <input type="hidden" name="batchId" value={batch.id} />
                  <Cluster gap="sm" align="end">
                    {/* SPEC-005 BR-005-22 (amended, #108): B3's Posição states no
                        reference date, so the user confirms the one reconciliation
                        compares against. */}
                    {batch.source === 'b3_posicao' && (
                      <Field
                        id="commit-as-of"
                        label={t('asOf.label')}
                        hint={t('asOf.hint')}
                        width="md"
                      >
                        <Input type="date" name="asOf" defaultValue={today} max={today} required />
                      </Field>
                    )}
                    <Button type="submit">{t('commit')}</Button>
                  </Cluster>
                </form>
              )}
            </FormActions>
          ) : undefined
        }
      >
        {/* #63 / BR-005-05: a batch that failed to parse names what went wrong
            — AC-005-05's "specific, actionable error", rendered here instead of
            leaving the batch looking merely stalled. Reuses `EmptyState`
            (`role="status"`) rather than inventing a dedicated error pattern. */}
        {batch.status === 'failed' && (
          <EmptyState
            title={t('failure.title')}
            description={
              <>
                {batch.failureCode && t(`failure.reasons.${batch.failureCode}`)}{' '}
                {t('failure.retry')}
              </>
            }
          />
        )}

        {/* BR-022-36 — figures inside a panel are inset, not nested cards. */}
        {batch.rowCounts && (
          <Grid cols={4} gap="md">
            <StatCard inset label={t('countRead')} value={batch.rowCounts.read} />
            <StatCard inset label={t('countNew')} value={batch.rowCounts.new} />
            <StatCard inset label={t('countDuplicates')} value={batch.rowCounts.duplicates} />
            <StatCard
              inset
              label={t('countNeedsAttention')}
              value={batch.rowCounts.needsAttention}
            />
            {batch.rowCounts.ignored > 0 && (
              <StatCard inset label={t('countIgnored')} value={batch.rowCounts.ignored} />
            )}
          </Grid>
        )}
        {/* SPEC-005 BR-005-10 (#117): staging classifies without replaying, so
            the preview says what its counts cannot know yet. */}
        {batch.rowCounts && canCommit && batch.source !== 'b3_posicao' && (
          <Text size="xs" tone="muted">
            {t('preReplayHint')}
          </Text>
        )}
      </Section>

      {/* SPEC-010 BR-010-15 — auto-allocation is reported, never silent. */}
      {summary !== null && summary.assets.length > 0 && (
        <div id="summary">
          <Section
            title={t('summary.title')}
            description={summary.settled ? t('summary.settled') : t('summary.needsDecisions')}
          >
            <NodeTable
              columns={[
                { id: 'asset', header: t('summary.columnAsset'), kind: 'text', width: 20 },
                {
                  id: 'imported',
                  header: t('summary.columnImported'),
                  kind: 'number',
                  width: 22,
                },
                { id: 'wallets', header: t('summary.columnWallets'), kind: 'text', width: 24 },
                {
                  id: 'assign',
                  header: t('summary.columnAssign'),
                  kind: 'control',
                  width: '30rem',
                },
              ]}
              rows={summaryRows}
              caption={t('summary.title')}
              noun={t('summary.noun')}
              paramPrefix={ROW_TABLE_PREFIX.summary}
              server={{ total: summaryPage.total }}
              cards={false}
              linkHash="summary"
            />
          </Section>
        </div>
      )}

      <div id="attention">
        <Section title={t('needsAttentionTitle')}>
          {needsAttention.length === 0 ? (
            <EmptyState title={t('needsAttentionEmpty')} />
          ) : (
            <NodeTable
              columns={[
                ...identityColumns,
                { id: 'detail', header: t('rows.columnDetail'), kind: 'control', width: 40 },
                { id: 'action', header: t('rows.columnAction'), kind: 'control', width: '34rem' },
              ]}
              rows={attentionRows}
              caption={t('needsAttentionTitle')}
              noun={t('rows.noun')}
              paramPrefix={ROW_TABLE_PREFIX.attention}
              server={{ total: attentionPage.total }}
              cards={false}
              linkHash="attention"
            />
          )}
        </Section>
      </div>

      {/* SPEC-005 BR-005-19 (amended, #110): mirrors of another extract's
          record — visible, collapsed, and still classifiable once committed
          (BR-005-20). */}
      {ignored.length > 0 && (
        <div id="ignored">
          <Section title={t('ignored.title')} description={t('ignored.description')}>
            {/* Open when the user has paged into it: a link that lands on a
              closed disclosure would look like it did nothing. */}
            <OpenOnHash
              id="ignored"
              openByDefault={rowTableAddressed(query, 'ignored')}
              summary={t('ignored.show', { count: ignored.length })}
            >
              <Stack gap="md">
                {batch.status === 'committed' && (
                  <Text size="xs" tone="muted">
                    {t('ignored.classifyHint')}
                  </Text>
                )}
                <NodeTable
                  columns={[
                    ...identityColumns,
                    {
                      id: 'action',
                      header: t('rows.columnAction'),
                      kind: 'control',
                      width: '34rem',
                    },
                  ]}
                  rows={ignoredRows}
                  caption={t('ignored.title')}
                  noun={t('rows.noun')}
                  paramPrefix={ROW_TABLE_PREFIX.ignored}
                  server={{ total: ignoredPage.total }}
                  cards={false}
                  linkHash="ignored"
                />
              </Stack>
            </OpenOnHash>
          </Section>
        </div>
      )}

      {batch.reconciliation && (
        <Section
          title={t('reconciliationTitle')}
          actions={
            // SPEC-022 BR-022-31 — an open divergence is a warning, never the
            // loss or destructive colour (DS-05), as on the Dashboard
            // (`ReconciliationStatus.tsx`). Divergences all accepted since are
            // no longer open, so they fall back to neutral.
            <Badge
              dot
              variant={
                batch.reconciliation.status === 'reconciled'
                  ? 'success'
                  : batch.reconciliation.discrepancies.some((d) => !d.resolved)
                    ? 'warning'
                    : 'neutral'
              }
            >
              {t(`reconciliationStatus.${batch.reconciliation.status}`)}
            </Badge>
          }
        >
          {batch.reconciliation.discrepancies.length > 0 && (
            // One row per discrepant position, so it grows with the batch's
            // assets: a paged table, client mode (the rows are all here). The
            // quantities are figures — right-aligned, tabular — and the action
            // is a form, so no card copy.
            <NodeTable
              columns={[
                { id: 'asset', header: t('columnAsset'), kind: 'text', width: 14 },
                { id: 'computed', header: t('columnComputed'), kind: 'number' },
                { id: 'b3', header: t('columnB3'), kind: 'number' },
                { id: 'difference', header: t('columnDifference'), kind: 'number' },
                { id: 'cause', header: t('columnCause'), kind: 'text', width: 28 },
                {
                  id: 'action',
                  header: t('acceptAdjustment'),
                  kind: 'control',
                  width: 24,
                  srOnlyHeader: true,
                },
              ]}
              rows={discrepancyRows}
              caption={t('reconciliationTitle')}
              noun={t('reconciliationNoun')}
              paramPrefix="reconciliacao"
              cards={false}
            />
          )}
        </Section>
      )}

      <Text size="xs" tone="muted">
        {t('rowsCount', { count: rows.length })}
      </Text>
    </SettingsFrame>
  );
}
