import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { WalletId } from '@/core/shared/ids';
import { GROWTH_BASES, EARNINGS_PERIODS } from '@/core/goals/goal';
import { loadGoalsView } from '@/app/(app)/wallets/goals-data';
import { createGoalAction } from '@/app/(app)/wallets/goal-actions';
import { tryUserId } from '@/app/(app)/wallets/session';
import { GrowthGoalCard } from '@/app/(app)/wallets/[walletId]/goals/_components/GrowthGoalCard';
import { EarningsGoalCard } from '@/app/(app)/wallets/[walletId]/goals/_components/EarningsGoalCard';
import { PageShell } from '@/components/patterns/page-shell';
import { ActionForm } from '@/components/patterns/action-form';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field } from '@/components/patterns/field';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-019 — Objetivos: a wallet's growth and earnings goals, each charted
 * separately (AC-1).
 *
 * Modelled closely on `[walletId]/balance/page.tsx` — the same `PageShell`,
 * `Section`, `EmptyState`, `ActionForm`, `Field` vocabulary, the same
 * signed-out and `notFound()` handling, the same back-link pattern.
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
 * Never statically prerendered: this renders one tenant's own goals and
 * progress, so a cached copy built once would be served to every visitor.
 */
export const dynamic = 'force-dynamic';

export default async function WalletGoalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ walletId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { walletId: rawWalletId } = await params;
  const t = await getTranslations('objetivos');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell width="narrow" title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawWalletId)) notFound();
  const walletId = WalletId.of(rawWalletId);

  const raw = await searchParams;
  const rawYear = raw.year;
  const yearParam = typeof rawYear === 'string' ? rawYear : undefined;
  // BR-019-22 / AC-7: only a plain four-digit year is even attempted: an
  // unparseable or out-of-range value falls back to `loadGoalsView`'s own
  // default rather than being trusted from the URL.
  const year = yearParam !== undefined && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;

  const view = await loadGoalsView(userId, walletId, year);
  if (view === null) notFound();

  const growthGoals = view.goals.filter((goalView) => goalView.goal.kind === 'growth');
  const earningsGoals = view.goals.filter((goalView) => goalView.goal.kind === 'earnings');

  return (
    <PageShell
      title={`${t('title')} · ${view.wallet.name}`}
      description={t('description')}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/wallets/${view.wallet.id}`}>{t('back')}</Link>
        </Button>
      }
    >
      {view.goals.length === 0 && <EmptyState title={t('empty')} />}

      {/*
        BR-019-22 / AC-7 — only offered when there is an earnings goal to
        redraw: the selector has nothing to do on a wallet with growth goals
        alone, and showing it anyway would suggest the growth chart moves too.
      */}
      {earningsGoals.length > 0 && (
        <form method="get" action={`/wallets/${view.wallet.id}/goals`} aria-label={t('yearLabel')}>
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
      )}

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
      */}
      <Section title={t('createGrowthTitle')} description={t('createGrowthDescription')}>
        <ActionForm action={createGoalAction}>
          <input type="hidden" name="walletId" value={view.wallet.id} />
          <input type="hidden" name="kind" value="growth" />
          <Stack gap="md" align="start">
            <Field id="growth-goal-name" label={t('nameLabel')} width="lg">
              <Input
                name="name"
                required
                defaultValue={view.wallet.goal ?? ''}
                placeholder={t('namePlaceholder')}
              />
            </Field>
            <Field id="growth-goal-amount" label={t('amountLabel')} width="md">
              <Input name="amount" inputMode="decimal" required />
            </Field>
            <Field id="growth-goal-basis" label={t('basisLabel')} width="md">
              <NativeSelect name="basis" defaultValue={GROWTH_BASES[0]}>
                {GROWTH_BASES.map((basis) => (
                  <option key={basis} value={basis}>
                    {t(basis === 'invested' ? 'basisInvested' : 'basisCurrentValue')}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit">{t('create')}</Button>
          </Stack>
        </ActionForm>
      </Section>

      <Section title={t('createEarningsTitle')} description={t('createEarningsDescription')}>
        <ActionForm action={createGoalAction}>
          <input type="hidden" name="walletId" value={view.wallet.id} />
          <input type="hidden" name="kind" value="earnings" />
          <Stack gap="md" align="start">
            <Field id="earnings-goal-name" label={t('nameLabel')} width="lg">
              <Input
                name="name"
                required
                defaultValue={view.wallet.goal ?? ''}
                placeholder={t('namePlaceholder')}
              />
            </Field>
            <Field id="earnings-goal-amount" label={t('amountLabel')} width="md">
              <Input name="amount" inputMode="decimal" required />
            </Field>
            <Field id="earnings-goal-period" label={t('periodLabel')} width="md">
              <NativeSelect name="period" defaultValue={EARNINGS_PERIODS[0]}>
                {EARNINGS_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {t(period === 'monthly' ? 'periodMonthly' : 'periodYearly')}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit">{t('create')}</Button>
          </Stack>
        </ActionForm>
      </Section>
    </PageShell>
  );
}
