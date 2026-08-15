import { getTranslations } from 'next-intl/server';
import {
  GROUPINGS,
  PERIOD_KINDS,
  type Grouping,
  type Period,
  type Scope,
} from '@/core/reporting/ports';
import { PARAM } from '@/lib/report-url-state';

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
    <form
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-4 rounded-lg border p-4"
      aria-label={t('title')}
    >
      {/* BR-011-01 — period */}
      <label className="flex flex-col gap-1 text-sm">
        {t('period.label')}
        <select
          name={PARAM.period}
          defaultValue={period.kind}
          className="rounded-md border px-2 py-1"
        >
          {PERIOD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`period.${kind}`)}
            </option>
          ))}
        </select>
      </label>

      {/*
        BR-011-01's custom range. Always rendered rather than revealed by
        JavaScript, so the form degrades to something usable without it; the
        parser ignores both dates unless `period=custom` (report-url-state.ts),
        which is what stops a stale pair contradicting a named period.
      */}
      <label className="flex flex-col gap-1 text-sm">
        {t('period.from')}
        <input
          type="date"
          name={PARAM.from}
          defaultValue={period.kind === 'custom' ? period.from : ''}
          className="rounded-md border px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('period.to')}
        <input
          type="date"
          name={PARAM.to}
          defaultValue={period.kind === 'custom' ? period.to : ''}
          className="rounded-md border px-2 py-1"
        />
      </label>

      {/*
        BR-011-02 — scope. The two URL parameters (`scope` and `wallet`) are
        collapsed into one control here, because "portfolio or which wallet" is
        one question to a user even though it is two values in the URL.
      */}
      <label className="flex flex-col gap-1 text-sm">
        {t('scope.label')}
        <select
          name={PARAM.wallet}
          defaultValue={scope.kind === 'wallet' ? scope.walletId : ''}
          className="rounded-md border px-2 py-1"
        >
          <option value="">{t('scope.portfolio')}</option>
          {wallets.map((wallet) => (
            <option key={wallet.walletId} value={wallet.walletId}>
              {wallet.name}
            </option>
          ))}
        </select>
      </label>
      {/*
        `scope=wallet` is implied by a non-empty wallet id. Submitting it as a
        hidden constant would force portfolio scope to carry a contradictory
        parameter; the parser already treats "scope is not 'wallet'" as
        portfolio, so an empty selection lands there naturally.
      */}
      <input type="hidden" name={PARAM.scope} value={scope.kind === 'wallet' ? 'wallet' : ''} />

      {/* BR-011-03 — grouping. Independent of scope (DL-011-01). */}
      <label className="flex flex-col gap-1 text-sm">
        {t('grouping.label')}
        <select
          name={PARAM.grouping}
          defaultValue={grouping}
          className="rounded-md border px-2 py-1"
        >
          {GROUPINGS.map((dimension) => (
            <option key={dimension} value={dimension}>
              {t(`grouping.${dimension}`)}
            </option>
          ))}
        </select>
      </label>

      <button type="submit" className="rounded-md border px-3 py-1 text-sm font-medium">
        {t('apply')}
      </button>
    </form>
  );
}
