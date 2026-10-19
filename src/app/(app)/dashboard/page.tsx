import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Upload } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { DashboardFreshness, DashboardPortfolio } from '@/core/dashboard/summary';
import { formatBusinessDate, formatDateTime } from '@/i18n/format';
import { loadDashboard } from '@/app/(app)/dashboard/data';
import { loadOnboardingStatus } from '@/app/(app)/onboarding/data';
import { tryUserId } from '@/lib/session';
import { AttentionQueue } from '@/app/(app)/dashboard/_components/AttentionQueue';
import { ReconciliationStatus } from '@/app/(app)/dashboard/_components/ReconciliationStatus';
import { ValuationMarkers } from '@/app/(app)/dashboard/_components/ValuationMarkers';
import { WatchOpportunities } from '@/app/(app)/dashboard/_components/WatchOpportunities';
import { loadWatchOpportunities } from '@/app/(app)/watch/data';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { StatCard } from '@/components/patterns/stat-card';
import { EstimateMarker } from '@/components/patterns/estimate-marker';
import { Money } from '@/app/money';
import { Note } from '@/components/patterns/note';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { Split } from '@/components/layout/split';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { IMPORT_SEND_PATH } from '@/app/(app)/import/paths';

/**
 * **The authenticated landing screen** (#98).
 *
 * Four rules across four *closed* specs required this page and had nowhere to
 * live until it existed: SPEC-005 BR-005-26 (reconciliation status visible on
 * the dashboard), SPEC-010 BR-010-12 (purchases awaiting allocation, on the
 * dashboard until resolved), SPEC-016 BR-016-02 / FR-8.29 (a 2s p95 budget on a
 * screen that did not exist), and SPEC-001 BR-001-04, whose "routes to
 * onboarding" was met by routing every sign-in to the transaction list instead.
 * The PRD's own first-run journey (§2.1 step 4) ends *"lands on a dashboard
 * with his real portfolio, valued at the current market"*.
 *
 * **Nothing on this page is computed here.** Every figure is read through
 * `core/dashboard/summary.ts`, which folds what the report query, the
 * reconciliation report and the allocation queue already produced — see that
 * module's header for why, and `tests/structural/reports-read-snapshots.test.ts`
 * for the check that keeps it true (SPEC-016 BR-016-07a, blocking).
 *
 * **A summary hub (SPEC-022 BR-022-07, #213).** The Dashboard summarises and
 * links; it owns no detail of its own. Every card names the destination that
 * owns its detail — Portfólio, the import batch, Configurações.
 * `tests/structural/dashboard-reads-the-summary.test.ts` keeps its figures
 * coming from the two loaders above and nothing else.
 *
 * Never statically prerendered: this renders one tenant's own *patrimônio*, so
 * a cached copy built once would be served to every visitor — the same
 * reasoning as `(app)/wallets/page.tsx`.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  const tImport = await getTranslations('import.staleness');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  /**
   * SPEC-020 BR-020-02/BR-001-04 — "first successful sign-in routes to
   * onboarding." `shouldGuide` is `!complete && !dismissed` (BR-020-03,
   * BR-020-12): a returning user who already has a committed import, and a
   * user who dismissed the guide, both fall straight through to the dashboard
   * built below — this redirect fires only for the genuine first run.
   *
   * Checked ahead of `loadDashboard` rather than after: the two loaders read
   * an overlapping but different slice of the same tenant, and a page that
   * built the whole dashboard body before deciding to leave would pay that
   * cost on every first sign-in for nothing rendered.
   */
  const onboarding = await loadOnboardingStatus(userId);
  if (onboarding.shouldGuide) redirect('/onboarding');

  // SPEC-022 BR-022-07 — the watch-state card reads SPEC-018's evaluation over
  // the stored quotes; it requests none (BR-018-11).
  const [{ summary }, opportunities] = await Promise.all([
    loadDashboard(userId),
    loadWatchOpportunities(userId),
  ]);
  const { portfolio, freshness, reconciliation, attention, attentionTotal } = summary;

  /**
   * SPEC-020 BR-020-27 — before the first import there is nothing to reconcile
   * and nothing in the queue, so both sections would render as boxes announcing
   * their own emptiness above an empty state that already says the only thing
   * worth saying. The one action a first-run user has is the one the empty
   * state offers.
   */
  const firstRun = portfolio.kind === 'onboarding';

  return (
    <PageShell
      title={t('title')}
      description={freshnessLine(freshness, t)}
      {...(firstRun
        ? {}
        : {
            actions: (
              <Button asChild variant="outline">
                <Link href={IMPORT_SEND_PATH}>
                  <Upload aria-hidden />
                  {t('staleness.action')}
                </Link>
              </Button>
            ),
          })}
    >
      {/*
        BR-005-28 — non-blocking, and suppressed on the first run because
        `isImportStale` reports "never imported" as stale (correctly: it is the
        strongest case for the prompt, not the weakest) and the onboarding empty
        state below is already that prompt, said better.
      */}
      {freshness.stale && freshness.daysSinceImport !== null && (
        <Note>
          <Stack gap="sm">
            {/* The wording is `/import`'s own (`import.staleness.*`), reused
                rather than restated: two near-identical prompts about the same
                threshold are two things that can drift, and the one a user
                meets second would then contradict the one they met first. The
                action is the header's "Importar extrato". */}
            <Text weight="medium">
              {tImport('staleTitle', { days: freshness.daysSinceImport })}
            </Text>
            <Text size="sm" tone="muted">
              {tImport('body', { threshold: freshness.thresholdDays })}
            </Text>
          </Stack>
        </Note>
      )}

      {portfolio.kind === 'valued' ? (
        <Headline portfolio={portfolio} />
      ) : (
        /*
         * BR-020-27 — "a portfolio displayed as R$ 0,00 is a false claim; an
         * empty state is the truth." Two of them, because "we have nothing" and
         * "you hold nothing" are opposite facts that render identically as a
         * zero (see `DashboardPortfolio`).
         */
        <EmptyState
          title={firstRun ? t('empty.onboarding.title') : t('empty.noHoldings.title')}
          description={
            firstRun ? t('empty.onboarding.description') : t('empty.noHoldings.description')
          }
          action={
            <Button asChild>
              <Link href={firstRun ? IMPORT_SEND_PATH : '/transactions'}>
                {firstRun ? t('empty.onboarding.action') : t('empty.noHoldings.action')}
              </Link>
            </Button>
          }
        />
      )}

      {!firstRun && (
        // The prototype's two columns (DL-022-13): the work queue beside the
        // two status cards, one column on a narrow container.
        <Split side="aside">
          {/* BR-010-12 */}
          <AttentionQueue items={attention} total={attentionTotal} />
          <Stack gap="lg">
            {/* BR-005-26 */}
            <ReconciliationStatus reconciliation={reconciliation} />
            {/* SPEC-022 BR-022-07 / SPEC-018 */}
            <WatchOpportunities opportunities={opportunities} />
          </Stack>
        </Split>
      )}
    </PageShell>
  );
}

/**
 * SPEC-005 BR-005-27 / SPEC-008 BR-008-04 / SPEC-013 BR-013-13 — the four
 * dates a figure on this screen has to answer for: what it is valued at, how
 * fresh the quotes behind it are, how far behind the market that tier is, and
 * how old the custody data underneath it is. "The product never implies
 * real-time."
 *
 * The page header's description, as in the prototype, so it reads as a fact
 * about the whole page. The quote instant is the **freshest** behind the
 * figures ("Cotação mais recente"); the Patrimônio card's "Preço mais antigo"
 * marker is the other end of the same range, and its explanation says so
 * (#213 — the two used to read as a contradiction).
 *
 * AR-47 / BR-016-18 — `dd/mm/yyyy` through the shared formatter. A
 * `BusinessDate` interpolated straight into an ICU message renders as the ISO
 * string it is stored as.
 */
function freshnessLine(
  freshness: DashboardFreshness,
  t: Awaited<ReturnType<typeof getTranslations<'dashboard'>>>,
): string {
  return [
    t('freshness.valuation', { date: formatBusinessDate(freshness.valuationAsOf) }),
    freshness.quotedAt === null
      ? t('freshness.noQuote')
      : t('freshness.quotedAt', { timestamp: formatDateTime(freshness.quotedAt) }),
    t('freshness.delay', { minutes: freshness.delayMinutes }),
    freshness.lastImportAt === null
      ? t('freshness.neverImported')
      : t('freshness.lastImport', { date: formatBusinessDate(freshness.lastImportAt) }),
  ].join(' · ');
}

/**
 * The headline figures (BR-022-07), each linking to the destination that owns
 * its detail. The same three Portfólio › Patrimônio leads with, in its words
 * (`portfolio.patrimonio.*`, BR-022-32) — and the same report totals, so the
 * two screens cannot disagree (BR-013-12).
 */
async function Headline({
  portfolio,
}: {
  readonly portfolio: Extract<DashboardPortfolio, { kind: 'valued' }>;
}) {
  const t = await getTranslations('dashboard');
  const tp = await getTranslations('portfolio.patrimonio');
  const tReports = await getTranslations('reports');
  const { result, ratio } = portfolio.result;

  return (
    // The frame draws four panels (#243); the fourth, Proventos do mês, is
    // #233's, which turns this row to four columns when it lands.
    <Grid cols={3} gap="md">
      <StatCard
        label={t('value.label')}
        value={<Money value={portfolio.value} />}
        /* SPEC-009 AC-3/9/11 — *how* this was priced, where the figure is read
           rather than in a footnote read once. Three separate facts: see
           `ValuationMarkers` on why one badge covering all of them told some
           users a false reason for a true warning. */
        hint={<ValuationMarkers markers={portfolio.markers} />}
        link={{ href: '/portfolio', label: t('value.link'), ariaLabel: t('value.linkLabel') }}
      />
      <StatCard
        label={tp('cost')}
        value={
          <Cluster gap="sm" align="baseline">
            <Money value={portfolio.costBasis} />
            {portfolio.costEstimated && (
              <EstimateMarker
                kind="cost"
                explanation={tReports('markers.costEstimated.explanation')}
              />
            )}
          </Cluster>
        }
        hint={tp('costHint')}
        info={{ id: 'applied-value-info', text: tp('costExplanation') }}
        // #243 — the frame's "Ver no Portfólio": Patrimônio leads with this
        // same figure (BR-022-39), so its detail is there, not in the ledger.
        link={{ href: '/portfolio', label: t('cost.link'), ariaLabel: t('cost.linkLabel') }}
      />
      <StatCard
        label={tp('result')}
        value={<Money value={result} signed />}
        hint={
          ratio === null ? (
            tp('resultNoRatio')
          ) : (
            <Cluster gap="xs" align="baseline">
              <Money value={ratio} kind="percent" signed />
              <span>{tp('resultOnCost')}</span>
            </Cluster>
          )
        }
        // BR-015-08 — the result per asset is Composição's table.
        link={{ href: '/portfolio/composition', label: t('result.link') }}
      />
    </Grid>
  );
}
