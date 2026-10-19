import { getTranslations } from 'next-intl/server';
import { formatBusinessDate } from '@/i18n/format';
import type { DashboardReconciliation } from '@/core/dashboard/summary';
import { SummaryCard } from '@/components/patterns/summary-card';
import { Stack } from '@/components/layout/stack';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { IMPORT_SEND_PATH, importBatchPath } from '@/lib/import-paths';

/**
 * SPEC-005 BR-005-26 — "portfolio reconciliation status (`reconciled` /
 * `discrepancies found` / `never reconciled`) is visible on the dashboard".
 * The rule closed with SPEC-005 (#8) and had no dashboard to be visible on
 * until #98; this component is where it finally holds.
 *
 * **Each state says what it means, not just what it is.** A badge reading
 * *Nunca conferido* is a status; *nunca comparamos o seu histórico com a
 * posição informada pela B3, e sem essa comparação um extrato faltando não tem
 * como aparecer* is the reason the status matters. SPEC-020 BR-020-18 makes
 * that explicit for onboarding gates — "a gate that cannot say what it blocks
 * is not worth showing" — and it is no less true of the one indicator on this
 * screen that speaks to whether the figure above it can be trusted.
 *
 * **Colour is never the sole carrier (SPEC-016 BR-016-16).** The badge's
 * variant is redundant with its text in all three states, and the count is in
 * the text rather than implied by a colour's intensity.
 *
 * **A Dashboard card (SPEC-022 BR-022-07, #213).** The status sits beside the
 * heading as a semantic status badge (BR-022-31); the card links to the one
 * screen that owns the detail — the batch's per-asset comparison, or the
 * import that would produce one.
 */
export async function ReconciliationStatus({
  reconciliation,
}: {
  readonly reconciliation: DashboardReconciliation;
}) {
  const t = await getTranslations('dashboard.reconciliation');
  const { state, asOf, unresolvedCount, resolvedCount, batchId } = reconciliation;

  /**
   * BR-005-25 — **`reconciled` has two histories behind it and they are not the
   * same assurance.** The comparison found nothing, or it found disagreements
   * the user has since accepted B3's figure on. Telling the second user that
   * "todas as quantidades que calculamos bateram com o que a B3 informou"
   * asserts something that did not happen — the ledger was *corrected* to
   * agree, which is a different and more interesting fact about their data.
   */
  const bodyKey =
    state === 'reconciled' && resolvedCount > 0 ? 'reconciledAfterAdjustments' : state;

  return (
    <SummaryCard
      title={t('title')}
      badge={
        <Badge
          dot
          variant={
            state === 'reconciled'
              ? 'success'
              : state === 'discrepancies_found'
                ? // SPEC-022 BR-022-31 — an open divergence is a warning,
                  // never the loss or destructive-action colour (DS-05).
                  'warning'
                : 'neutral'
          }
        >
          {t(`state.${state}`, { count: unresolvedCount })}
        </Badge>
      }
      link={
        batchId === null
          ? { href: IMPORT_SEND_PATH, label: t('importPosicao') }
          : // BR-005-23's per-asset table lives on the batch, which is also
            // where BR-005-25's "accept B3's figure" action is. One link, to
            // the one screen that resolves it.
            { href: importBatchPath(batchId), label: t('open') }
      }
    >
      <Stack gap="xs">
        {asOf !== null && (
          // BR-005-22 — the Posição date the comparison was made against.
          // Without it the badge is a claim with no date attached, which is
          // the same failure BR-005-27 exists to prevent for portfolio value.
          <Text size="sm">
            {/* AR-47 / BR-016-18 — `dd/mm/yyyy`, through the shared formatter. */}
            {t('asOf', { date: formatBusinessDate(asOf) })}
          </Text>
        )}
        <Text size="sm" tone="muted">
          {t(`body.${bodyKey}`, { count: resolvedCount })}
        </Text>
      </Stack>
    </SummaryCard>
  );
}
