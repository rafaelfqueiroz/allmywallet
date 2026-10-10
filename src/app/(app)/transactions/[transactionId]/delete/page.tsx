import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TransactionId } from '@/core/shared/ids';
import { describeDeletionImpact } from '@/core/ledger/delete-transaction';
import { formatBusinessDate } from '@/i18n/format';
import { messageValues } from '@/lib/action-state';
import { deleteTransactionAction } from '@/app/(app)/transactions/actions';
import { withTransactionWriteDeps } from '@/app/(app)/transactions/composition';
import { tryUserId } from '@/lib/session';
import { DeleteConfirm } from '@/app/(app)/transactions/_components/DeleteConfirm';
import {
  DeletionDownstreamImpact,
  type DownstreamImpactRow,
} from '@/app/(app)/transactions/_components/DeletionDownstreamImpact';
import { listInstitutionOptions } from '@/app/(app)/transactions/data';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { Note } from '@/components/patterns/note';
import { Money } from '@/components/patterns/money';
import { CostEstimateMarker } from '@/components/patterns/cost-estimate-marker';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
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
 * SPEC-006 BR-006-13 / DL-006-04 — deletion is permitted **with the
 * recalculation disclosed beforehand**, and this page is that disclosure.
 *
 * A whole route rather than a confirm dialog, deliberately. What has to be
 * shown is the *replayed* position without the row — `describeDeletionImpact`
 * computes it for real rather than estimating — and that is a server read of
 * the ledger, not something a dialog can produce from what the list already
 * has on screen. It also means the disclosure survives a reload and can be
 * linked to, and that the destructive click is never one keystroke away from
 * an ordinary one.
 *
 * The impact call can itself fail, and that failure is the most important
 * thing this page says: deleting the buy a later sale drew on leaves a ledger
 * that cannot be replayed, so the user is told *before* confirming rather than
 * after the row is gone.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly transactionId: string }>;
}

export default async function DeleteTransactionPage({ params }: PageProps) {
  const t = await getTranslations('transactions.delete');
  const tTable = await getTranslations('transactions.table');
  const tSignedOut = await getTranslations('transactions');
  const tErrors = await getTranslations('errors');
  // SPEC-007 BR-007-06 / DL-007-12 — the position-level marker reuses
  // `reports.markers.costEstimated`, the same catalogue entry every other
  // Custo/preço médio surface reads, rather than a transactions-scoped copy.
  const tReports = await getTranslations('reports');
  const tCommon = await getTranslations('common');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={tSignedOut('signedOut')} />
      </PageShell>
    );
  }

  const { transactionId } = await params;
  const id = TransactionId.of(transactionId);

  // A read, through the write composition root: `describeDeletionImpact`
  // replays the position, so it needs the ledger deps rather than the
  // repository alone. Nothing here writes.
  const { impact, target, conversionGroup, assetCodes } = await withTransactionWriteDeps(
    userId,
    async (deps) => {
      const target = await deps.ledger.transactions.findById(id);
      const impact =
        target?.conversionGroupId === null || target === null
          ? await describeDeletionImpact(deps.ledger, id)
          : null;
      // #144 N3: the downstream positions are named by asset code.
      const downstreamAssets =
        impact === null || !impact.ok ? [] : impact.value.downstream.map((row) => row.assetId);
      return {
        target,
        conversionGroup:
          target?.conversionGroupId === null || target === null
            ? []
            : await deps.ledger.transactions.listByConversionGroup(target.conversionGroupId),
        impact,
        assetCodes: new Map(
          (downstreamAssets.length === 0
            ? []
            : await deps.assign.assetCatalog.findByIds(downstreamAssets)
          ).map((asset) => [asset.id as string, asset.code]),
        ),
      };
    },
  );

  if (target === null) notFound();

  if (target.conversionGroupId !== null) {
    const earliest = conversionGroup.reduce(
      (date, leg) => (leg.tradeDate < date ? leg.tradeDate : date),
      conversionGroup[0]?.tradeDate ?? target.tradeDate,
    );
    return (
      <PageShell title={t('title')} description={t('description')}>
        <Stack gap="lg">
          <Section title={t('impactTitle')}>
            <Stack gap="sm">
              <Text>{t('conversionGroup', { count: conversionGroup.length })}</Text>
              <Text>{t('impactFrom', { date: formatBusinessDate(earliest) })}</Text>
            </Stack>
          </Section>
          <Note>{t('impactAllocations')}</Note>
          <DeleteConfirm action={deleteTransactionAction} transactionId={transactionId} />
        </Stack>
      </PageShell>
    );
  }

  // SPEC-006 BR-006-13 (#144 N3): every other position the delete
  // recalculates, labelled. `institutions` is shared reference data (AR-15).
  const institutionNames =
    impact !== null && impact.ok && impact.value.downstream.some((row) => row.institutionId)
      ? new Map(
          (await listInstitutionOptions()).map((option) => [
            option.institutionId as string,
            option.name,
          ]),
        )
      : new Map<string, string>();
  const downstreamRows: readonly DownstreamImpactRow[] =
    impact === null || !impact.ok
      ? []
      : impact.value.downstream.map((row) => ({
          key: `${row.assetId}|${row.institutionId ?? ''}`,
          assetLabel: assetCodes.get(row.assetId) ?? row.assetId,
          institutionLabel:
            row.institutionId === null
              ? null
              : (institutionNames.get(row.institutionId) ?? row.institutionId),
          currentPosition: row.currentPosition,
          projectedPosition: row.projectedPosition,
          currentCostEstimated: row.currentCostEstimated,
          projectedCostEstimated: row.projectedCostEstimated,
        }));

  return (
    <PageShell title={t('title')} description={t('description')}>
      {impact === null || !impact.ok ? (
        <ErrorState
          title={
            impact === null
              ? tErrors('UNEXPECTED')
              : tErrors(impact.error.code, messageValues(impact.error.context))
          }
        />
      ) : (
        <Stack gap="lg">
          <Section title={t('impactTitle')}>
            <Stack gap="sm">
              {/* DL-006-03: forward from the transaction's own date, not today. */}
              <Text>{t('impactFrom', { date: formatBusinessDate(impact.value.fromDate) })}</Text>
              <Text>
                {t('impactSubsequent', { count: impact.value.subsequentTransactionCount })}
              </Text>
            </Stack>
          </Section>

          {/*
            "Your position will change" without saying what to is the kind of
            disclosure that satisfies a checklist and nobody reading it. Both
            columns are real replays — the current one from the ledger as it
            stands, the projected one from the ledger without this row.
          */}
          <Table>
            <TableCaption className="sr-only">{t('impactPosition')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('impactPosition')}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t('impactCurrent')}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t('impactProjected')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="py-row">{t('impactQuantity')}</TableCell>
                <TableCell className="py-row text-right">
                  <Money value={impact.value.currentPosition.quantity} kind="quantity" />
                </TableCell>
                <TableCell className="py-row text-right">
                  <Money value={impact.value.projectedPosition.quantity} kind="quantity" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="py-row">{t('impactAverageCost')}</TableCell>
                <TableCell className="py-row text-right">
                  <Cluster gap="sm" justify="end" align="baseline">
                    <Money value={impact.value.currentPosition.averageCost} />
                    {/* SPEC-007 BR-007-06 / DL-007-12 — never hidden. */}
                    <CostEstimateMarker
                      shown={impact.value.currentCostEstimated}
                      label={tCommon('estimated')}
                      title={tReports('markers.costEstimated.explanation')}
                    />
                  </Cluster>
                </TableCell>
                <TableCell className="py-row text-right">
                  <Cluster gap="sm" justify="end" align="baseline">
                    <Money value={impact.value.projectedPosition.averageCost} />
                    <CostEstimateMarker
                      shown={impact.value.projectedCostEstimated}
                      label={tCommon('estimated')}
                      title={tReports('markers.costEstimated.explanation')}
                    />
                  </Cluster>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="py-row">{tTable('total')}</TableCell>
                <TableCell className="py-row text-right">
                  <Money value={impact.value.currentPosition.totalCost} />
                </TableCell>
                <TableCell className="py-row text-right">
                  <Money value={impact.value.projectedPosition.totalCost} />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <DeletionDownstreamImpact rows={downstreamRows} />

          {/* SPEC-010 BR-010-05 — the other derived thing that moves. */}
          <Note>{t('impactAllocations')}</Note>

          <DeleteConfirm action={deleteTransactionAction} transactionId={transactionId} />
        </Stack>
      )}
    </PageShell>
  );
}
