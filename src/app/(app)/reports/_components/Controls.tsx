import { getTranslations } from 'next-intl/server';
import {
  GROUPINGS,
  PERIOD_KINDS,
  type Grouping,
  type Period,
  type Scope,
} from '@/core/reporting/ports';
import { PARAM, toQueryString, type ReportUrlState } from '@/lib/report-url-state';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-011 BR-011-01/03/05/06/11 — the filter bar every report shares.
 *
 * **One component, used by all four reports** (AC-1: "all four reports expose
 * identical period, scope and grouping controls"). DL-011-02: four separate
 * control bars drift — the options diverge, one report quietly gains a sixth
 * grouping, and a user who learned the controls on Composition finds they
 * behave differently on Earnings.
 *
 * **A plain `<form method="get">`, deliberately.** The three controls live in
 * the URL (BR-011-11, DL-011-06), and a GET form puts them there natively:
 * the view is bookmarkable, shareable into a bug report, and works with
 * JavaScript disabled or still loading. A client component holding this in
 * React state would have to mirror it into the URL anyway, and the two copies
 * would disagree on the back button.
 *
 * This is also why the selects are `NativeSelect` rather than the Radix
 * `Select`: a GET form submits native controls and nothing else.
 *
 * **No scope field** (SPEC-022 BR-022-17, DL-022-09). The scope is chosen in
 * the page header, by the one `ScopeSelector` Portfólio uses too, and arrives
 * here as the `wallet` parameter. The form carries it as a hidden field, or
 * applying a period would drop the wallet the header selected.
 *
 * **Exportar CSV sits in the bar** (#209): the file is the grouped view for
 * the period, scope and grouping this bar applied, so it belongs beside them.
 * Only a tab whose subject is that file passes `exportHref` — Evolução
 * patrimonial (see `api/reports/export/route.ts`).
 *
 * AR-44: every string comes from `next-intl`; there is not one literal below.
 * AR-46 keeps the market vocabulary Portuguese — *patrimônio*, never "net
 * worth".
 */

/**
 * SPEC-011 BR-011-12 — the export URL for the view on screen. Serialised
 * against the **same** default grouping the page parsed the URL with: passing
 * `state.grouping` as the default would omit the parameter every time, and the
 * file would silently fall back to the scope's default grouping rather than
 * the one the table shows.
 */
export function reportExportHref(state: ReportUrlState, defaultGrouping: Grouping): string {
  return `/api/reports/export${toQueryString(state, defaultGrouping)}`;
}

export interface ControlsProps {
  /** Where the form submits — each report passes its own route. */
  readonly action: string;
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
  /**
   * Report-specific state this shared form must carry across a submit — today
   * only SPEC-012's `earnings` (#63). Rendered as hidden inputs.
   *
   * A value here belongs to a control this form does not render — like the
   * header's wallet — so carrying the current value forward is the only
   * correct thing it can do. Without it, changing the period silently reverts
   * "sem proventos" to "com proventos". (A hidden field that *shadowed* a
   * visible one was the defect: the old Escopo select posted `scope=` derived
   * from the current scope beside the wallet being chosen, and the form
   * contradicted itself.)
   */
  readonly hidden?: Readonly<Record<string, string>>;
  /**
   * SPEC-011 BR-011-12 — the CSV of the view as applied, serialised by the
   * page against the same default grouping it parsed the URL with. Absent
   * when there is nothing to export (an empty scope, an invalid range).
   */
  readonly exportHref?: string | undefined;
}

export async function Controls({
  action,
  period,
  scope,
  grouping,
  hidden,
  exportHref,
}: ControlsProps) {
  const t = await getTranslations('reports');

  return (
    <form method="get" action={action} aria-label={t('title')}>
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* BR-022-17 — the header's scope, carried across a submit. */}
      {scope.kind === 'wallet' && (
        <input type="hidden" name={PARAM.wallet} value={scope.walletId} />
      )}
      <Card>
        <CardContent>
          <Cluster gap="md" align="end">
            {/* BR-011-01 — period */}
            <Field id="report-period" label={t('period.label')} width="md">
              <NativeSelect name={PARAM.period} defaultValue={period.kind}>
                {PERIOD_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`period.${kind}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            {/*
          BR-011-01's custom range. Always rendered rather than revealed by
          JavaScript, so the form degrades to something usable without it; the
          parser ignores both dates unless `period=custom` (report-url-state.ts),
          which is what stops a stale pair contradicting a named period.
        */}
            <Field id="report-from" label={t('period.from')} width="md">
              <Input
                type="date"
                name={PARAM.from}
                defaultValue={period.kind === 'custom' ? period.from : ''}
              />
            </Field>
            <Field id="report-to" label={t('period.to')} width="md">
              <Input
                type="date"
                name={PARAM.to}
                defaultValue={period.kind === 'custom' ? period.to : ''}
              />
            </Field>

            {/* BR-011-03 — grouping. Independent of scope (DL-011-01). */}
            <Field id="report-grouping" label={t('grouping.label')} width="lg">
              <NativeSelect name={PARAM.grouping} defaultValue={grouping}>
                {GROUPINGS.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {t(`grouping.${dimension}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Button type="submit">{t('apply')}</Button>

            {/*
              BR-011-12 / AC-011-11 — a link rather than a button: the
              response is a file and the handler is a GET. It exports the
              view as applied — the page's URL — not the fields as edited and
              not yet applied.
            */}
            {exportHref !== undefined && (
              <Button asChild variant="outline">
                <a href={exportHref}>{t('export.csv')}</a>
              </Button>
            )}
          </Cluster>
        </CardContent>
      </Card>
    </form>
  );
}
