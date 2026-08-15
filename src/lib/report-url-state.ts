import { BusinessDate } from '@/core/shared/clock';
import { isUuid, WalletId } from '@/core/shared/ids';
import { isGrouping } from '@/core/reporting/grouping';
import { isPeriodKind } from '@/core/reporting/period';
import type { Grouping, Period, Scope } from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-11 / AC-10 — "period, scope and grouping are reflected in
 * the URL so a view can be bookmarked and returned to."
 *
 * DL-011-06: URL state is not a nicety. Bookmarking a view and coming back to
 * it is a basic expectation, and it makes support conversations concrete — a
 * user can paste the exact view they are asking about into a bug report
 * instead of describing it.
 *
 * This lives in `src/lib/` rather than `src/core/` because it is a transport
 * concern: it maps the domain's `Period`/`Scope`/`Grouping` onto query
 * parameters. It imports the domain types, never the other way round, so
 * `core/` stays free of any notion of a URL (AR-01).
 *
 * **Parsing never throws and never fails the page.** Every parameter is
 * user-editable text — a truncated link in a chat client, a hand-typed date, a
 * wallet deleted since the bookmark was made. An unreadable value falls back
 * to the documented default rather than erroring, because a report that
 * refuses to render is worse than one that renders the default view. The one
 * thing it must never do is *misread* a value into a different valid one: a
 * grouping of `sectr` becomes the default, never `sector`.
 */

export const PARAM = {
  period: 'period',
  from: 'from',
  to: 'to',
  scope: 'scope',
  wallet: 'wallet',
  grouping: 'grouping',
} as const;

export interface ReportUrlState {
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
}

/**
 * A read-only view of the query string. `URLSearchParams` and Next's
 * `ReadonlyURLSearchParams` both satisfy it, as does a plain object in a test,
 * so this module never has to know which one it was handed.
 */
export interface ReadableParams {
  get(name: string): string | null;
}

/**
 * BR-011-11 — state → query string.
 *
 * Only non-default values are written. A URL carrying every parameter at its
 * default is noise in a bookmark and in a bug report, and it makes the common
 * link longer than the interesting one. `?grouping=sector` says exactly what
 * is unusual about the view.
 *
 * The custom range's two dates are written only for a custom period — carrying
 * `from`/`to` alongside `period=ytd` would put two contradictory answers in
 * one URL, and whichever one lost would surprise somebody.
 */
export function toSearchParams(state: ReportUrlState, defaultGrouping: Grouping): URLSearchParams {
  const params = new URLSearchParams();

  if (state.period.kind !== 'ytd') params.set(PARAM.period, state.period.kind);
  if (state.period.kind === 'custom') {
    params.set(PARAM.from, state.period.from);
    params.set(PARAM.to, state.period.to);
  }

  if (state.scope.kind === 'wallet') {
    params.set(PARAM.scope, 'wallet');
    params.set(PARAM.wallet, state.scope.walletId);
  }

  if (state.grouping !== defaultGrouping) params.set(PARAM.grouping, state.grouping);

  return params;
}

/** Convenience for a link: the query string with its `?`, or `''` when empty. */
export function toQueryString(state: ReportUrlState, defaultGrouping: Grouping): string {
  const params = toSearchParams(state, defaultGrouping);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * BR-011-11 — query string → state, total and non-throwing.
 *
 * `defaultGrouping` is BR-011-04's scope-dependent default, resolved by the
 * caller (it depends on the scope, which is itself being parsed here, and on
 * SPEC-002 config the domain does not read).
 */
export function fromSearchParams(
  params: ReadableParams,
  defaultGrouping: Grouping,
): ReportUrlState {
  const scope = parseScope(params);
  return {
    period: parsePeriod(params),
    scope,
    grouping: parseGrouping(params, defaultGrouping),
  };
}

function parsePeriod(params: ReadableParams): Period {
  const kind = params.get(PARAM.period);
  // BR-011-01's first option is the default: YTD is the window a user checking
  // in on their portfolio almost always wants.
  if (kind === null || !isPeriodKind(kind)) return { kind: 'ytd' };
  if (kind !== 'custom') return { kind };

  const from = parseDate(params.get(PARAM.from));
  const to = parseDate(params.get(PARAM.to));
  // A custom period missing or mangling either end is not a custom period.
  // Falling back to YTD is safe; inventing the missing end would silently
  // report on a range nobody asked for.
  if (from === null || to === null) return { kind: 'ytd' };
  return { kind: 'custom', from, to };
}

/**
 * `BusinessDate.of` throws on anything that is not a real `YYYY-MM-DD` — it
 * rejects `2026-02-31` as well as `not-a-date`. Here that is caught and turned
 * into `null`, because a hand-edited URL is input, not a bug.
 */
function parseDate(raw: string | null): BusinessDate | null {
  if (raw === null) return null;
  try {
    return BusinessDate.of(raw);
  } catch {
    return null;
  }
}

function parseScope(params: ReadableParams): Scope {
  if (params.get(PARAM.scope) !== 'wallet') return { kind: 'portfolio' };
  const walletId = params.get(PARAM.wallet);
  // `WalletId.of` throws on a non-UUID, and this is attacker-reachable text —
  // ids are interpolated into tenant-scoped comparisons (AR-11), so a value
  // that is not a UUID must not get that far. Checking first keeps the
  // fallback explicit rather than relying on a caught exception.
  if (walletId === null || !isUuid(walletId)) return { kind: 'portfolio' };
  return { kind: 'wallet', walletId: WalletId.of(walletId) };
}

function parseGrouping(params: ReadableParams, fallback: Grouping): Grouping {
  const raw = params.get(PARAM.grouping);
  if (raw === null || !isGrouping(raw)) return fallback;
  return raw;
}
