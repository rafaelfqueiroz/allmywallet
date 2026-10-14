import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { GROWTH_BASES, EARNINGS_PERIODS } from '@/core/goals/goal';
import { loadGoalsView } from '@/app/(app)/wallets/goals-data';
import { createGoalAction } from '@/app/(app)/wallets/goal-actions';
import { tryUserId } from '@/lib/session';
import { fromSearchParams, PARAM } from '@/lib/report-url-state';
import { loadScopeWallets } from '@/app/(app)/portfolio/data';
import { PortfolioFrame } from '@/app/(app)/portfolio/_components/PortfolioFrame';
import { ErrorState } from '@/components/patterns/error-state';
import { NodeTable, type NodeRow } from '@/components/patterns/node-table';
import { GrowthGoalCard } from '@/app/(app)/portfolio/goals/_components/GrowthGoalCard';
import { EarningsGoalCard } from '@/app/(app)/portfolio/goals/_components/EarningsGoalCard';
import { PageShell } from '@/app/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field } from '@/components/patterns/field';
import { FormActions, FormGrid } from '@/components/patterns/form-layout';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-019 — Metas: a wallet's growth and earnings goals, each charted
 * separately (AC-1).
 *
 * Rendered inside Portfólio's frame, with the wallet as the frame's scope
 * (BR-022-17) — the same frame and vocabulary as Carteiras' balancing.
 *
 * ---------------------------------------------------------------------------
 * THE YEAR PARAMETER GOVERNS THE EARNINGS CHART ONLY (BR-019-13/22, AC-5/7).
 *
 * `year` is a URL search param, so choosing one re-renders this whole Server
 * Component with a different `loadGoalsView` call — but the growth burn-up is
 * never year-scoped (BR-019-13, DL-019-04): `GrowthGoalCard` reads
 * `goalView.growth`, which `loadGoalsView` computes over the wallet's whole
 * life regardless of `year`. Only `goalView.earnings` — the wallet's
 * SPEC-014 income folded into the selected calendar year — moves when the
 * selector changes. Nothing in this file, or in either card, filters the
 * growth series by year; that is what keeps AC-7 true.
 * ---------------------------------------------------------------------------
 *
 * SPEC-022 BR-022-02 / #208 — Portfólio › **Metas**. It was
 * `/wallets/[id]/goals`, which redirects here with the wallet as the scope
 * (BR-022-08); the `year` parameter rides along on the redirect.
 *
 * Never statically prerendered: this renders one tenant's own goals and
 * progress, so a cached copy built once would be served to every visitor.
 */
export const dynamic = 'force-dynamic';

export default async function PortfolioGoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('objetivos');
  const tp = await getTranslations('portfolio');
  const tr = await getTranslations('reports');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={tp('title')}>
        <EmptyState title={tp('signedOut')} />
      </PageShell>
    );
  }

  const raw = await searchParams;
  const { scope } = fromSearchParams(
    {
      get: (name: string) => {
        const value = raw[name];
        return typeof value === 'string' ? value : null;
      },
    },
    'asset_class',
  );
  const wallets = await loadScopeWallets(userId);

  /*
   * SPEC-019 — a goal belongs to one wallet, so "all wallets" has no goals of
   * its own to show. It lists the wallets instead, each opening this tab
   * scoped to it — the same URL the scope selector writes (BR-022-17).
   */
  if (scope.kind === 'portfolio') {
    return (
      <PortfolioFrame wallets={wallets}>
        <Section title={tp('goals.chooseTitle')} description={tp('goals.chooseDescription')}>
          {/* One row a wallet, so it grows with the portfolio: a paged,
              filterable table like every collection (BR-022-18). */}
          <NodeTable
            columns={[
              {
                id: 'wallet',
                header: tp('wallets.columnWallet'),
                kind: 'text',
                width: 40,
                sortable: true,
              },
            ]}
            rows={wallets.map((wallet): NodeRow => ({
              id: wallet.walletId,
              keys: { wallet: wallet.name },
              cells: {
                wallet: (
                  <Link
                    href={`/portfolio/goals?${PARAM.wallet}=${wallet.walletId}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {wallet.name}
                  </Link>
                ),
              },
            }))}
            caption={tp('goals.chooseTitle')}
            noun={tp('wallets.noun')}
            filterPlaceholder={tp('wallets.filterPlaceholder')}
            paramPrefix="wallets"
            sort={{ id: 'wallet', desc: false }}
            empty={<EmptyState title={tp('wallets.empty')} />}
          />
        </Section>
      </PortfolioFrame>
    );
  }

  const rawYear = raw.year;
  const yearParam = typeof rawYear === 'string' ? rawYear : undefined;
  // BR-019-22 / AC-7: only a plain four-digit year is even attempted: an
  // unparseable or out-of-range value falls back to `loadGoalsView`'s own
  // default rather than being trusted from the URL.
  const year = yearParam !== undefined && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;

  const view = await loadGoalsView(userId, scope.walletId, year);
  if (view === null) {
    // A wallet deleted since the link was made (BR-011-16).
    return (
      <PortfolioFrame wallets={wallets}>
        <ErrorState title={tr('scope.walletNotFound')} />
      </PortfolioFrame>
    );
  }

  const growthGoals = view.goals.filter((goalView) => goalView.goal.kind === 'growth');
  const earningsGoals = view.goals.filter((goalView) => goalView.goal.kind === 'earnings');

  return (
    <PortfolioFrame wallets={wallets}>
      {/*
        SPEC-022 BR-022-36 — the wallet's heading over its goal panels: a
        group of panels, so the heading is plain, and the year selector that
        redraws them is its action.
      */}
      <Section
        variant="plain"
        title={tp('goals.title', { wallet: view.wallet.name })}
        description={t('description')}
        // BR-019-22 / AC-7 — only offered when there is an earnings goal to
        // redraw: the selector has nothing to do on a wallet with growth goals
        // alone, and showing it anyway would suggest the growth chart moves too.
        actions={
          earningsGoals.length > 0 ? (
            <form method="get" action="/portfolio/goals" aria-label={t('yearLabel')}>
              <input type="hidden" name={PARAM.wallet} value={view.wallet.id} />
              <Cluster gap="sm" align="end">
                <Field id="goals-year" label={t('yearLabel')} width="sm">
                  <NativeSelect name="year" defaultValue={String(view.selectedYear)}>
                    {view.years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Button type="submit">{t('yearApply')}</Button>
              </Cluster>
            </form>
          ) : undefined
        }
      >
        {view.goals.length === 0 && <EmptyState title={t('empty')} />}
      </Section>

      {growthGoals.map((goalView) => (
        <GrowthGoalCard key={goalView.goal.id} goalView={goalView} />
      ))}

      {earningsGoals.map((goalView) => (
        <EarningsGoalCard key={goalView.goal.id} goalView={goalView} />
      ))}

      {/*
        DL-019-06 — SPEC-010 BR-010-02's free-text goal becomes the name a new
        goal starts with, on both forms: the wallet's stated purpose did not
        pick a kind, so neither form claims it more than the other.
        SPEC-022 BR-022-37 — each is the standard form: Nome beside Valor, the
        third field alone (short, so its neighbouring cell stays empty).
      */}
      <ActionForm
        action={createGoalAction}
        panel={{
          title: t('createGrowthTitle'),
          description: t('createGrowthDescription'),
          footer: (
            <FormActions>
              <Button type="submit">{t('create')}</Button>
            </FormActions>
          ),
        }}
      >
        <input type="hidden" name="walletId" value={view.wallet.id} />
        <input type="hidden" name="kind" value="growth" />
        <FormGrid>
          <Field id="growth-goal-name" label={t('nameLabel')}>
            <Input
              name="name"
              required
              defaultValue={view.wallet.goal ?? ''}
              placeholder={t('namePlaceholder')}
            />
          </Field>
          <Field id="growth-goal-amount" label={t('amountLabel')}>
            <Input name="amount" inputMode="decimal" required />
          </Field>
          <Field id="growth-goal-basis" label={t('basisLabel')}>
            <NativeSelect name="basis" defaultValue={GROWTH_BASES[0]}>
              {GROWTH_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(basis === 'invested' ? 'basisInvested' : 'basisCurrentValue')}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </FormGrid>
      </ActionForm>

      <ActionForm
        action={createGoalAction}
        panel={{
          title: t('createEarningsTitle'),
          description: t('createEarningsDescription'),
          footer: (
            <FormActions>
              <Button type="submit">{t('create')}</Button>
            </FormActions>
          ),
        }}
      >
        <input type="hidden" name="walletId" value={view.wallet.id} />
        <input type="hidden" name="kind" value="earnings" />
        <FormGrid>
          <Field id="earnings-goal-name" label={t('nameLabel')}>
            <Input
              name="name"
              required
              defaultValue={view.wallet.goal ?? ''}
              placeholder={t('namePlaceholder')}
            />
          </Field>
          <Field id="earnings-goal-amount" label={t('amountLabel')}>
            <Input name="amount" inputMode="decimal" required />
          </Field>
          <Field id="earnings-goal-period" label={t('periodLabel')}>
            <NativeSelect name="period" defaultValue={EARNINGS_PERIODS[0]}>
              {EARNINGS_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {t(period === 'monthly' ? 'periodMonthly' : 'periodYearly')}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </FormGrid>
      </ActionForm>
    </PortfolioFrame>
  );
}
