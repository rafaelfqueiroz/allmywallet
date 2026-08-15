import { getTranslations } from 'next-intl/server';
import { SystemClock } from '@/core/shared/clock';
import { runReportQuery } from '@/core/reporting/base-query';
import { defaultGroupingFor } from '@/core/reporting/grouping';
import {
  NOT_CLASSIFIED_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  type ReportGroup,
} from '@/core/reporting/ports';
import { formatCurrency, formatQuantity } from '@/i18n/format';
import { fromSearchParams } from '@/lib/report-url-state';
import { Controls } from '@/app/(app)/reports/_components/Controls';
import { withReportPort } from '@/app/(app)/reports/data';
import { tryUserId } from '@/app/(app)/reports/session';

/**
 * SPEC-011 — the reporting framework's own page: the shared controls, the
 * grouped table and the empty states, exercised end to end.
 *
 * SPEC-012 through SPEC-015 build their reports on the same
 * `runReportQuery` + `Controls` pair, which is what makes BR-011-06's "same
 * control, same options, same semantics" hold across all four.
 *
 * Never statically prerendered: this renders one tenant's own holdings, so a
 * cached copy built once (or with no session) would be served to everyone —
 * the same reasoning as `(app)/wallets/page.tsx`.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const t = await getTranslations('reports');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  const raw = await searchParams;
  // BR-011-11: the three controls are read from the URL, so a bookmark
  // reproduces the view exactly.
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' ? value : null;
    },
  };

  // Parsed twice on purpose: the default grouping depends on the scope
  // (BR-011-04), and the scope is itself one of the parsed values.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const { result, wallets } = await withReportPort(userId, async (port) => ({
    wallets: await port.listWallets(),
    result: await runReportQuery(
      port,
      {
        period: state.period,
        scope: state.scope,
        grouping: state.grouping,
        today: new SystemClock().today(),
      },
      await port.earliestSnapshotDate(),
    ),
  }));

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <Controls
        action="/reports"
        period={state.period}
        scope={state.scope}
        grouping={state.grouping}
        wallets={wallets.map((wallet) => ({ walletId: wallet.walletId, name: wallet.name }))}
      />

      {!result.ok ? (
        // BR-011-16: a named, explanatory outcome — never a blank page and
        // never a zero that looks like a real figure.
        <p role="alert" className="rounded-lg border p-6 text-muted-foreground">
          {result.error.code === 'REPORTING_INVALID_PERIOD_RANGE'
            ? t('period.invalidRange')
            : t('scope.walletNotFound')}
        </p>
      ) : result.value.empty ? (
        <EmptyState scoped={state.scope.kind === 'wallet'} />
      ) : (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {result.value.range.from} — {result.value.range.to}
          </p>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t(`grouping.${result.value.report.grouping}`)}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2">
                  {t('table.group')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('table.quantity')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('table.value')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('table.costBasis')}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.value.report.groups.map((group: ReportGroup) => (
                <GroupRow key={group.key.id} group={group} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <th scope="row" className="py-2 text-left">
                  {t('table.total')}
                </th>
                <td className="py-2 text-right">
                  {formatQuantity(result.value.report.total.quantity)}
                </td>
                <td className="py-2 text-right">
                  {formatCurrency(result.value.report.total.value)}
                </td>
                <td className="py-2 text-right">
                  {formatCurrency(result.value.report.total.costBasis)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </main>
  );
}

/**
 * BR-011-07 / AC-9 — "a group row drills down to its constituent assets
 * without leaving the report."
 *
 * `<details>` rather than client-side state: the constituents already travel
 * with the group (`ReportGroup.holdings`), so expanding needs no second query
 * and therefore no JavaScript. A drill-down that re-queried could show figures
 * derived differently from the row it expands — which is exactly the class of
 * disagreement this spec exists to prevent.
 */
async function GroupRow({ group }: { readonly group: ReportGroup }) {
  const t = await getTranslations('reports');

  // AR-44: synthetic buckets render an i18n label, never their sentinel id.
  const label = group.key.synthetic
    ? group.key.id === UNASSIGNED_GROUP_ID
      ? t('group.unassigned')
      : t('group.notClassified')
    : group.key.dimension === 'asset_class'
      ? t(`assetClass.${group.key.id}`)
      : (group.holdings[0]?.assetCode ?? group.key.id);

  return (
    <tr className="border-b align-top">
      <td className="py-2">
        <details>
          <summary className="cursor-pointer">
            {label}
            {group.totals.estimated ? (
              <span className="ml-2 rounded border px-1 text-xs" title={t('estimate.explanation')}>
                {t('estimate.badge')}
              </span>
            ) : null}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {group.holdings.map((holding, index) => (
              <li
                key={`${holding.assetId}-${holding.institutionId ?? NOT_CLASSIFIED_GROUP_ID}-${index}`}
              >
                {holding.assetCode} · {formatQuantity(holding.quantity)} ·{' '}
                {formatCurrency(holding.value)}
              </li>
            ))}
          </ul>
        </details>
      </td>
      <td className="py-2 text-right">{formatQuantity(group.totals.quantity)}</td>
      <td className="py-2 text-right">{formatCurrency(group.totals.value)}</td>
      <td className="py-2 text-right">{formatCurrency(group.totals.costBasis)}</td>
    </tr>
  );
}

/**
 * BR-011-16 / AC-14 — an empty scope gets an explanation, never a misleading
 * zero. The wording differs by scope because the useful next action does: an
 * empty portfolio needs an import, an empty wallet needs an allocation.
 */
async function EmptyState({ scoped }: { readonly scoped: boolean }) {
  const t = await getTranslations('reports');
  return (
    <div role="status" className="rounded-lg border p-6">
      <p className="font-medium">{scoped ? t('empty.walletTitle') : t('empty.portfolioTitle')}</p>
      <p className="text-muted-foreground">
        {scoped ? t('empty.walletBody') : t('empty.portfolioBody')}
      </p>
    </div>
  );
}
