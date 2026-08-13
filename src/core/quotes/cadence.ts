/**
 * SPEC-008 BR-008-22 — the degradation ladder (30 → 60 → 120 minutes, via
 * `quotes.degradation_ladder`). Pure arithmetic; the worker's `budget.check`
 * handler is the only caller, and it owns reading config, reading the
 * budget counter, and writing the result to `runtime_state`
 * (`@/config/runtime-state`) — none of which core/ is allowed to touch
 * (AR-01).
 *
 * Reference table (SPEC-008, ~7h/420min session, 21 trading days/month):
 *
 *   30 min:  floor(420/30)=14 intraday + 1 close = 15/day * 21 = 315/asset/month
 *   60 min:  floor(420/60)= 7 intraday + 1 close =  8/day * 21 = 168/asset/month
 *  120 min:  floor(420/120)=3 intraday + 1 close =  4/day * 21 =  84/asset/month
 *
 * `callsPerAssetPerMonth` below reproduces exactly this arithmetic, generally,
 * off `regularSessionMinutes()`/`tradingDaysInMonth()` (TradingCalendar,
 * BR-008-07) rather than the hardcoded 420/21 — so it stays correct if the
 * calendar data changes (a holiday-heavy month, a different session length).
 */

const CLOSE_CAPTURES_PER_DAY = 1;

export function intradayCallsPerDay(sessionMinutes: number, cadenceMinutes: number): number {
  if (cadenceMinutes <= 0) throw new RangeError('intradayCallsPerDay: cadenceMinutes must be > 0');
  return Math.floor(sessionMinutes / cadenceMinutes);
}

export function callsPerAssetPerMonth(
  sessionMinutes: number,
  cadenceMinutes: number,
  tradingDaysInMonth: number,
): number {
  return (
    (intradayCallsPerDay(sessionMinutes, cadenceMinutes) + CLOSE_CAPTURES_PER_DAY) *
    tradingDaysInMonth
  );
}

/**
 * BR-008-22: picks the fastest (smallest) rung of `ladder` whose projected
 * monthly consumption still fits `scheduledBudgetPerMonth`; if even the
 * slowest rung does not fit, that slowest rung is still returned — it is the
 * best available, and BR-008-24's stale-marking is what covers the shortfall
 * rather than this function refusing to answer. `ladder` is assumed already
 * validated ascending by the registry schema (`quotes.degradation_ladder`).
 */
export function chooseCadenceMinutes(
  ladder: readonly number[],
  distinctHeldAssetCount: number,
  scheduledBudgetPerMonth: number,
  sessionMinutes: number,
  tradingDaysInMonth: number,
): number {
  if (ladder.length === 0) throw new RangeError('chooseCadenceMinutes: ladder must not be empty');
  if (distinctHeldAssetCount === 0) return ladder[0] ?? 30;

  for (const cadence of ladder) {
    const projected =
      distinctHeldAssetCount * callsPerAssetPerMonth(sessionMinutes, cadence, tradingDaysInMonth);
    if (projected <= scheduledBudgetPerMonth) return cadence;
  }
  // Every rung, including the most conservative, projects over budget — still
  // the best available; BR-008-24's stale-marking covers the shortfall.
  const slowest = ladder[ladder.length - 1];
  return slowest ?? ladder[0] ?? 30;
}
