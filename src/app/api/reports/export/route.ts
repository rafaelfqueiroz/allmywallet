import { type NextRequest, NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { fromSearchParams } from '@/lib/report-url-state';
import { SystemClock } from '@/core/shared/clock';
import { runReportQuery } from '@/core/reporting/base-query';
import { defaultGroupingFor, groupNameKey } from '@/core/reporting/grouping';
import { defaultGroupLabeller, exportGroupedCsv } from '@/core/reporting/export-csv';
import { withReportPort } from '@/app/(app)/reports/data';
import { getTranslations } from 'next-intl/server';

/**
 * SPEC-011 BR-011-12 / AC-011-11 — "the grouped view can be exported as CSV".
 *
 * `exportGroupedCsv` was written and tested and referenced by nothing: no route
 * handler, no control on any page, and `reports.export.csv` /
 * `reports.export.filename` unused in the catalogue. The criterion was ticked
 * on a function a user had no way to invoke (#61).
 *
 * A route handler rather than a server action, for the same reason as
 * `api/transactions/export` (AR-33): the response body *is* the file, with a
 * `Content-Disposition` header, which a server action's serialisable return
 * value cannot express.
 *
 * **Exports exactly what is on screen.** The query string is parsed with the
 * same `lib/report-url-state.ts` the three report pages read, and run through
 * the same `runReportQuery`, so period, scope and grouping cannot drift
 * between the table and the file — which is the whole point of exporting a
 * *grouped* view rather than a flat list.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const userId = await requireUserId();
  const t = await getTranslations('reports');

  const params = { get: (name: string) => request.nextUrl.searchParams.get(name) };
  // Two passes for the same reason the pages do it: the default grouping
  // depends on the resolved scope (BR-011-04), so the scope has to be parsed
  // before the grouping default is known.
  const provisional = fromSearchParams(params, 'asset_class');
  const state = fromSearchParams(params, defaultGroupingFor(provisional.scope, undefined));

  const result = await withReportPort(userId, (port) =>
    port.earliestSnapshotDate().then((earliest) =>
      runReportQuery(
        port,
        {
          period: state.period,
          scope: state.scope,
          grouping: state.grouping,
          today: new SystemClock().today(),
        },
        earliest,
      ),
    ),
  );

  if (!result.ok) {
    // A bookmark naming a deleted wallet, or an invalid custom range. 404
    // rather than an empty file: a zero-byte CSV downloaded successfully is
    // indistinguishable from "you hold nothing", which is a different claim.
    return NextResponse.json({ error: result.error.code }, { status: 404 });
  }

  // `reports.table.*` — the same headings the on-screen table uses, so the
  // file and the page name their columns identically.
  const labels = {
    group: t('table.group'),
    assetCode: t('table.assetCode'),
    assetName: t('table.assetName'),
    quantity: t('table.quantity'),
    value: t('table.value'),
    costBasis: t('table.costBasis'),
    estimated: t('table.estimated'),
    unassigned: t('group.unassigned'),
    notClassified: t('group.notClassified'),
    yes: t('table.yes'),
    no: t('table.no'),
    total: t('table.total'),
  };

  /**
   * The same names the screen renders (#77's `GroupLabel`), re-keyed to the
   * bare id `defaultGroupLabeller` looks up. Asset class is absent from
   * `groupNames` because its labels are i18n keys rather than tenant data, so
   * it is filled in here — otherwise the export would carry `stock` where the
   * table shows "Ações" (AR-44).
   */
  const names = new Map<string, string>();
  for (const group of result.value.report.groups) {
    if (group.key.synthetic) continue;
    names.set(
      group.key.id,
      group.key.dimension === 'asset_class'
        ? t(`assetClass.${group.key.id}`)
        : (result.value.groupNames.get(groupNameKey(group.key)) ?? group.key.id),
    );
  }

  const csv = exportGroupedCsv(result.value.report, labels, defaultGroupLabeller(labels, names));

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${t('export.filename')}.csv"`,
    },
  });
}
