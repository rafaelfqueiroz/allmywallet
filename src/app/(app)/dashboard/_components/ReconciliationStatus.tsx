import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { DashboardReconciliation } from '@/core/dashboard/summary';
import { Section } from '@/components/patterns/section';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

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
 */
export async function ReconciliationStatus({
  reconciliation,
}: {
  readonly reconciliation: DashboardReconciliation;
}) {
  const t = await getTranslations('dashboard.reconciliation');
  const { state, asOf, unresolvedCount, batchId } = reconciliation;

  return (
    <Section title={t('title')}>
      <Stack gap="sm">
        <Cluster gap="sm" align="baseline">
          <Badge
            variant={
              state === 'reconciled'
                ? 'secondary'
                : state === 'discrepancies_found'
                  ? 'destructive'
                  : 'outline'
            }
          >
            {t(`state.${state}`, { count: unresolvedCount })}
          </Badge>
          {asOf !== null && (
            // BR-005-22 — the Posição date the comparison was made against.
            // Without it the badge is a claim with no date attached, which is
            // the same failure BR-005-27 exists to prevent for portfolio value.
            <Text as="span" size="xs" tone="muted">
              {t('asOf', { date: asOf })}
            </Text>
          )}
        </Cluster>

        <Text size="sm" tone="muted">
          {t(`body.${state}`)}
        </Text>

        <div>
          {batchId === null ? (
            <Button asChild variant="link" size="sm">
              <Link href="/import">{t('importPosicao')}</Link>
            </Button>
          ) : (
            // BR-005-23's per-asset table lives on the batch, which is also
            // where BR-005-25's "accept B3's figure" action is. One link, to the
            // one screen that resolves it.
            <Button asChild variant="link" size="sm">
              <Link href={`/import/${batchId}`}>{t('open')}</Link>
            </Button>
          )}
        </div>
      </Stack>
    </Section>
  );
}
