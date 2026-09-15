import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ImportBatchId } from '@/core/shared/ids';
import { positionKeyString } from '@/core/positions/replay';
import { SystemClock } from '@/core/shared/clock';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { formatBusinessDate, formatDateTime, formatQuantity } from '@/i18n/format';
import type { RowRefusal } from '@/core/ingestion/refusal';
import {
  acceptAdjustmentAction,
  cancelBatchAction,
  classifyRowAction,
  commitBatchAction,
} from '@/app/(app)/import/actions';
import { loadImportBatchDetail } from '@/app/(app)/import/data';
import { labelFor, resolveAssetLabels } from '@/app/(app)/wallets/data';
import { loadWalletOptions, walletName } from '@/app/(app)/import/wallet-options';
import { allocateAction } from '@/app/(app)/wallets/actions';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/components/patterns/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/patterns/money';
import { Badge } from '@/components/ui/badge';
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
 * SPEC-005 BR-005-10/11/19/20/22..26 — the preview: accurate counts, the
 * Needs Attention queue with manual classification, commit/cancel, and the
 * reconciliation report with accept-as-adjustment.
 */
export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId: rawBatchId } = await params;
  const t = await getTranslations('import');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawBatchId)) notFound();
  const batchId = ImportBatchId.of(rawBatchId);
  const detail = await loadImportBatchDetail(userId, batchId);
  if (detail === null) notFound();

  const { batch, rows, needsAttention, ignored, summary, acceptBlockers, refusals } = detail;
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
      default:
        return t(`refusal.${refusal.kind}`);
    }
  };
  const classifyForm = (rowId: string) => (
    <form action={classifyRowAction}>
      <input type="hidden" name="rowId" value={rowId} />
      <Cluster gap="sm" align="end">
        <Field id={`classify-${rowId}`} label={t('classifyLabel')} width="lg">
          <NativeSelect name="type" required>
            {TRANSACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`transactionType.${type}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" size="sm">
          {t('classifySubmit')}
        </Button>
      </Cluster>
    </form>
  );
  const walletOptions = summary === null ? [] : await loadWalletOptions(userId);
  const labels =
    summary === null
      ? new Map()
      : await resolveAssetLabels(summary.assets.map((asset) => asset.assetId));
  const canCommit = batch.status === 'previewed';
  const canCancel = batch.status === 'pending' || batch.status === 'previewed';
  const today = new SystemClock().today();

  return (
    <PageShell
      title={t(`extractType.${batch.source}`)}
      description={t('uploadedAt', { date: formatDateTime(batch.uploadedAt) })}
      actions={
        <Badge variant={batch.status === 'failed' ? 'destructive' : 'secondary'}>
          {t(`status.${batch.status}`)}
        </Badge>
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
              {batch.failureCode && t(`failure.reasons.${batch.failureCode}`)} {t('failure.retry')}
            </>
          }
        />
      )}

      {batch.rowCounts && (
        <Grid cols={4} gap="md">
          <StatCard label={t('countRead')} value={batch.rowCounts.read} />
          <StatCard label={t('countNew')} value={batch.rowCounts.new} />
          <StatCard label={t('countDuplicates')} value={batch.rowCounts.duplicates} />
          <StatCard label={t('countNeedsAttention')} value={batch.rowCounts.needsAttention} />
          {batch.rowCounts.ignored > 0 && (
            <StatCard label={t('countIgnored')} value={batch.rowCounts.ignored} />
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

      {(canCommit || canCancel) && (
        <Cluster gap="sm">
          {canCommit && (
            <form action={commitBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <Cluster gap="sm" align="end">
                {/* SPEC-005 BR-005-22 (amended, #108): B3's Posição states no
                    reference date, so the user confirms the one reconciliation
                    compares against. */}
                {batch.source === 'b3_posicao' && (
                  <Field id="commit-as-of" label={t('asOf.label')} hint={t('asOf.hint')} width="md">
                    <Input type="date" name="asOf" defaultValue={today} max={today} required />
                  </Field>
                )}
                <Button type="submit">{t('commit')}</Button>
              </Cluster>
            </form>
          )}
          {canCancel && (
            <form action={cancelBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <Button type="submit" variant="destructive">
                {t('cancel')}
              </Button>
            </form>
          )}
        </Cluster>
      )}

      {/* SPEC-010 BR-010-15 — auto-allocation is reported, never silent. */}
      {summary !== null && summary.assets.length > 0 && (
        <Section
          title={t('summary.title')}
          description={summary.settled ? t('summary.settled') : t('summary.needsDecisions')}
        >
          <List gap="lg">
            {summary.assets.map((asset) => {
              const label = labelFor(labels, asset.assetId);
              return (
                <ListItem key={asset.assetId} separated>
                  <Stack gap="sm">
                    <Cluster justify="between" gap="sm">
                      <span className="font-medium">
                        {label.code} — {label.name}
                      </span>
                      <Money value={asset.importedQuantity} kind="quantity" />
                    </Cluster>

                    {asset.destinations.length === 0 ? (
                      <Text as="span" size="xs" tone="muted">
                        {t('summary.unassigned')}
                      </Text>
                    ) : (
                      <Text as="span" size="xs" tone="muted">
                        {asset.destinations
                          .map(
                            (destination) =>
                              `${walletName(walletOptions, destination.walletId)}: ${destination.quantity.toString()}`,
                          )
                          .join(' · ')}
                      </Text>
                    )}

                    {/* BR-010-13: resolvable here, in one action, with the
                        quantity pre-filled — the same form the wallets screen
                        offers, because it is the same decision. */}
                    {asset.pending !== null && (
                      <ActionForm action={allocateAction}>
                        <input type="hidden" name="assetId" value={asset.assetId} />
                        <Cluster gap="sm" align="end">
                          <Field
                            id={`summary-wallet-${asset.assetId}`}
                            label={t('summary.assign')}
                            width="md"
                          >
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
                            <Input
                              name="quantity"
                              defaultValue={asset.pending.unassignedQuantity.toString()}
                            />
                          </Field>
                          <Button type="submit" size="sm">
                            {t('summary.resolve')}
                          </Button>
                        </Cluster>
                      </ActionForm>
                    )}
                  </Stack>
                </ListItem>
              );
            })}
          </List>
        </Section>
      )}

      <Section title={t('needsAttentionTitle')}>
        {needsAttention.length === 0 ? (
          <EmptyState title={t('needsAttentionEmpty')} />
        ) : (
          <List gap="md">
            {needsAttention.map((row) => (
              <ListItem key={row.id} separated>
                <Stack gap="sm" align="start">
                  <span className="font-medium">{row.record.assetCode}</span>
                  <Text as="span" size="xs" tone="muted">
                    {row.record.kind === 'transaction'
                      ? `${row.record.b3Type} · ${formatBusinessDate(row.record.tradeDate)}`
                      : ''}
                  </Text>
                  {refusals.has(row.id) && (
                    <Text as="span" size="xs">
                      {refusalText(refusals.get(row.id) as RowRefusal)}
                    </Text>
                  )}
                  {row.classification === 'unclassified' && classifyForm(row.id)}
                </Stack>
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      {/* SPEC-005 BR-005-19 (amended, #110): mirrors of another extract's
          record — visible, collapsed, and still classifiable once committed
          (BR-005-20). */}
      {ignored.length > 0 && (
        <Section title={t('ignored.title')} description={t('ignored.description')}>
          <details>
            <summary className="cursor-pointer text-sm">
              {t('ignored.show', { count: ignored.length })}
            </summary>
            <Stack gap="md">
              {batch.status === 'committed' && (
                <Text size="xs" tone="muted">
                  {t('ignored.classifyHint')}
                </Text>
              )}
              <List gap="md">
                {ignored.map((row) => (
                  <ListItem key={row.id} separated>
                    <Stack gap="sm" align="start">
                      <span className="font-medium">{row.record.assetCode}</span>
                      <Text as="span" size="xs" tone="muted">
                        {row.record.kind === 'transaction'
                          ? `${row.record.b3Type} · ${formatBusinessDate(row.record.tradeDate)}`
                          : ''}
                      </Text>
                      {batch.status === 'committed' && classifyForm(row.id)}
                    </Stack>
                  </ListItem>
                ))}
              </List>
            </Stack>
          </details>
        </Section>
      )}

      {batch.reconciliation && (
        <Section
          title={t('reconciliationTitle')}
          actions={
            <Badge variant="outline">
              {t(`reconciliationStatus.${batch.reconciliation.status}`)}
            </Badge>
          }
        >
          {batch.reconciliation.discrepancies.length > 0 && (
            <Table>
              <TableCaption className="sr-only">{t('reconciliationTitle')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('columnAsset')}</TableHead>
                  <TableHead scope="col">{t('columnComputed')}</TableHead>
                  <TableHead scope="col">{t('columnB3')}</TableHead>
                  <TableHead scope="col">{t('columnDifference')}</TableHead>
                  <TableHead scope="col">{t('columnCause')}</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">{t('acceptAdjustment')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.reconciliation.discrepancies.map((d) => {
                  // BR-005-25 (#110): no button where accepting would be refused.
                  const blocker = acceptBlockers.get(positionKeyString(d));
                  return (
                    <TableRow key={d.assetId}>
                      <TableCell className="py-row font-medium">{d.assetCode}</TableCell>
                      <TableCell className="py-row tabular-nums">{d.computedQuantity}</TableCell>
                      <TableCell className="py-row tabular-nums">{d.b3Quantity}</TableCell>
                      <TableCell className="py-row tabular-nums">{d.difference}</TableCell>
                      <TableCell className="py-row">
                        <Text as="span" size="xs" tone="muted">
                          {t(`discrepancyCause.${d.cause}`)}
                        </Text>
                      </TableCell>
                      <TableCell className="py-row">
                        {d.resolved ? (
                          <Text as="span" size="xs" tone="muted">
                            {t('resolved')}
                          </Text>
                        ) : blocker !== undefined ? (
                          <Text as="span" size="xs" tone="muted">
                            {t(`acceptAdjustmentBlocked.${blocker}`)}
                          </Text>
                        ) : (
                          <form action={acceptAdjustmentAction}>
                            <input type="hidden" name="batchId" value={batch.id} />
                            <input type="hidden" name="assetId" value={d.assetId} />
                            {d.institutionId && (
                              <input type="hidden" name="institutionId" value={d.institutionId} />
                            )}
                            <Button type="submit" size="xs" variant="outline">
                              {t('acceptAdjustment')}
                            </Button>
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      )}

      <Text size="xs" tone="muted">
        {t('rowsCount', { count: rows.length })}
      </Text>
    </PageShell>
  );
}
