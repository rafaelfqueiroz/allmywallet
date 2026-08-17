import { getTranslations } from 'next-intl/server';
import {
  GROUPINGS,
  PERIOD_KINDS,
  type Grouping,
  type Period,
  type Scope,
} from '@/core/reporting/ports';
import { PARAM } from '@/lib/report-url-state';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

/**
 * SPEC-011 BR-011-01/02/03/05/06/11 — the control bar every report shares.
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
 * AR-44: every string comes from `next-intl`; there is not one literal below.
 * AR-46 keeps the market vocabulary Portuguese — *patrimônio*, never "net
 * worth".
 */

export interface ControlsProps {
  /** Where the form submits — each report passes its own route. */
  readonly action: string;
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
  /** The tenant's wallets, for the scope selector (BR-011-02). */
  readonly wallets: readonly { readonly walletId: string; readonly name: string }[];
}

export async function Controls({ action, period, scope, grouping, wallets }: ControlsProps) {
  const t = await getTranslations('reports');

  return (
    <form method="get" action={action} aria-label={t('title')}>
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

            {/*
          BR-011-02 — scope. The two URL parameters (`scope` and `wallet`) are
          collapsed into one control here, because "portfolio or which wallet" is
          one question to a user even though it is two values in the URL.
        */}
            <Field id="report-scope" label={t('scope.label')} width="lg">
              <NativeSelect
                name={PARAM.wallet}
                defaultValue={scope.kind === 'wallet' ? scope.walletId : ''}
              >
                <option value="">{t('scope.portfolio')}</option>
                {wallets.map((wallet) => (
                  <option key={wallet.walletId} value={wallet.walletId}>
                    {wallet.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {/*
          No hidden `scope` field. It used to be submitted here, with its value
          derived from the *current* scope rather than from the select above —
          so from portfolio scope this form posted `wallet=<uuid>&scope=`, and
          `parseScope` returned portfolio because it tested `scope` before it
          looked at the id. Choosing a wallet and pressing Aplicar reloaded the
          whole portfolio, and no link in the app emitted `scope=wallet` either,
          which left wallet scope reachable only by hand-typing a URL.

          The comment that used to sit here already described the right
          contract — "`scope=wallet` is implied by a non-empty wallet id" — so
          the parser now implements it, and the select is the only thing that
          says which scope this is.
        */}
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
          </Cluster>
        </CardContent>
      </Card>
    </form>
  );
}
