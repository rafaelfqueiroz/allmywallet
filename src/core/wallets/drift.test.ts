import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity, sumQuantity } from '@/core/shared/money';
import {
  DriftUnavailableReason,
  computeDrift,
  isPriceUsable,
  type TargetedValue,
} from '@/core/wallets/drift';
import type { WalletTarget } from '@/core/wallets/targets';

/**
 * SPEC-017 BR-017-13..16, BR-017-21.
 *
 * TS-04: hand-computed, exact. The figures are chosen so every share
 * terminates — a wallet of 1.000 split 140/860 is 14 % and 86 % exactly — so
 * an assertion that fails is a wrong *rule*, not a rounding artefact. The
 * non-terminating case gets its own test, where the property asserted is the
 * one that survives truncation: the shares total exactly 100.
 */

const PETR = AssetId.generate();
const VALE = AssetId.generate();
const ITSA = AssetId.generate();

function target(assetId: AssetId, pct: string): WalletTarget {
  return { assetId, targetPct: Quantity.fromString(pct) };
}

function valued(assetId: AssetId, value: string, priceUsable = true): TargetedValue {
  return { assetId, value: Money.fromString(value), priceUsable };
}

const TOLERANCE = Quantity.fromString('5');

describe('BR-017-13/14 — current share and signed drift', () => {
  it('AC-8 — an asset at 14 % against a 10 % target reads +4pp', () => {
    /*
     * By hand: the wallet's targeted value is 140 + 860 = 1.000.
     *   PETR4: 140 ÷ 1.000 × 100 = 14 %   target 10 %  → +4 pp
     *   VALE3: 100 − 14          = 86 %   target 90 %  → −4 pp
     */
    const report = computeDrift(
      [target(PETR, '10'), target(VALE, '90')],
      [valued(PETR, '140'), valued(VALE, '860')],
      TOLERANCE,
    );

    expect(report.rows[0]?.currentPct?.toString()).toBe('14');
    expect(report.rows[0]?.driftPp?.toString()).toBe('4');
    expect(report.rows[1]?.currentPct?.toString()).toBe('86');
    expect(report.rows[1]?.driftPp?.toString()).toBe('-4');
    expect(report.targetedValue.toString()).toBe('1000');
  });

  it('the drift figures on a wallet sum to exactly zero', () => {
    /*
     * This is the invariant the residual exists for. Targets total exactly 100
     * (BR-017-04) and current shares total exactly 100, so their differences
     * total exactly 0. Divide all three shares instead of giving the last one
     * the residual and this reads −1e-38: invisible on screen, and enough to
     * make a table that "adds up" not add up.
     *
     * Three equal thirds of 100 — the case with no terminating decimal.
     */
    const report = computeDrift(
      [target(PETR, '30'), target(VALE, '30'), target(ITSA, '40')],
      [valued(PETR, '100'), valued(VALE, '100'), valued(ITSA, '100')],
      TOLERANCE,
    );

    const shares = report.rows.map((row) => row.currentPct as Quantity);
    expect(sumQuantity(shares).toString()).toBe('100');
    expect(sumQuantity(report.rows.map((row) => row.driftPp as Quantity)).toString()).toBe('0');
  });

  it('an asset allocated to the wallet but worth nothing reads 0 % rather than being dropped', () => {
    const report = computeDrift(
      [target(PETR, '50'), target(VALE, '50')],
      [valued(PETR, '1000'), valued(VALE, '0')],
      TOLERANCE,
    );

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]?.currentPct?.toString()).toBe('100');
    expect(report.rows[1]?.currentPct?.toString()).toBe('0');
    expect(report.rows[1]?.driftPp?.toString()).toBe('-50');
  });
});

describe('BR-017-15/16 — tolerance and the wallet flag', () => {
  /**
   * The rule says drift must **exceed** the tolerance, so a drift landing
   * exactly on it is inside. Stated in the rule, and the one place an
   * off-by-one changes which assets a user sees flagged — so both sides of the
   * boundary are asserted rather than one.
   */
  it('a drift exactly on the threshold is within tolerance; a hair past it is not', () => {
    const onBoundary = computeDrift(
      [target(PETR, '10'), target(VALE, '90')],
      [valued(PETR, '150'), valued(VALE, '850')],
      TOLERANCE,
    );
    expect(onBoundary.rows[0]?.driftPp?.toString()).toBe('5');
    expect(onBoundary.rows[0]?.outOfTolerance).toBe(false);
    expect(onBoundary.outOfBalance).toBe(false);

    const past = computeDrift(
      [target(PETR, '10'), target(VALE, '90')],
      [valued(PETR, '150.1'), valued(VALE, '849.9')],
      TOLERANCE,
    );
    expect(past.rows[0]?.outOfTolerance).toBe(true);
    expect(past.outOfBalance).toBe(true);
  });

  it('flags an underweight asset as readily as an overweight one', () => {
    const report = computeDrift(
      [target(PETR, '50'), target(VALE, '50')],
      [valued(PETR, '300'), valued(VALE, '700')],
      TOLERANCE,
    );
    expect(report.rows[0]?.driftPp?.toString()).toBe('-20');
    expect(report.rows[0]?.outOfTolerance).toBe(true);
    expect(report.rows[1]?.outOfTolerance).toBe(true);
  });

  /** AC-9 — the tolerance is the user's number, and moving it moves the flags. */
  it('a wider tolerance stops flagging the same wallet, with no other change', () => {
    const args = [
      [target(PETR, '10'), target(VALE, '90')],
      [valued(PETR, '160'), valued(VALE, '840')],
    ] as const;

    expect(computeDrift(...args, Quantity.fromString('5')).outOfBalance).toBe(true);
    expect(computeDrift(...args, Quantity.fromString('10')).outOfBalance).toBe(false);
  });

  it('a zero tolerance flags any drift at all, which is a coherent instruction', () => {
    const report = computeDrift(
      [target(PETR, '50'), target(VALE, '50')],
      [valued(PETR, '501'), valued(VALE, '499')],
      Quantity.zero(),
    );
    expect(report.outOfBalance).toBe(true);
  });

  it('a wallet sitting exactly on its targets is not out of balance', () => {
    const report = computeDrift(
      [target(PETR, '25'), target(VALE, '75')],
      [valued(PETR, '250'), valued(VALE, '750')],
      TOLERANCE,
    );
    expect(report.rows.every((row) => row.driftPp?.isZero())).toBe(true);
    expect(report.outOfBalance).toBe(false);
  });

  it('a wallet with no targets is not out of balance and reports nothing unavailable', () => {
    const report = computeDrift([], [], TOLERANCE);
    expect(report).toEqual({
      rows: [],
      targetedValue: Money.zero(),
      outOfBalance: false,
      unavailableReason: null,
      unpricedAssetIds: [],
    });
  });
});

describe('BR-017-21 / AC-13 — an unusable price makes drift unavailable', () => {
  it('names the asset, computes nothing, and does not flag the wallet', () => {
    const report = computeDrift(
      [target(PETR, '10'), target(VALE, '90')],
      [valued(PETR, '500'), valued(VALE, '500', false)],
      TOLERANCE,
    );

    expect(report.unavailableReason).toBe(DriftUnavailableReason.PRICE_UNUSABLE);
    expect(report.unpricedAssetIds).toEqual([VALE]);
    expect(report.rows.every((row) => row.currentPct === null && row.driftPp === null)).toBe(true);
    // On the priced asset's numbers alone PETR4 would read 50 % against a 10 %
    // target — a 40 pp drift, and a wallet screaming for attention over a
    // denominator nobody could measure.
    expect(report.outOfBalance).toBe(false);
  });

  /**
   * The propagation is the point. Every share divides by the same total, and
   * that total includes the asset nothing could price — so dropping it would
   * inflate every remaining share by exactly the weight of the unmeasured
   * thing, and the table would be full of confident wrong percentages.
   */
  it('withholds the *other* assets’ shares too, not just the unpriced one’s', () => {
    const report = computeDrift(
      [target(PETR, '50'), target(VALE, '50')],
      [valued(PETR, '500'), valued(VALE, '500', false)],
      TOLERANCE,
    );
    expect(report.rows[0]?.currentPct).toBeNull();
    expect(report.rows[0]?.priceUsable).toBe(true);
    expect(report.rows[1]?.priceUsable).toBe(false);
  });

  it('BR-015-10’s refusal, reused: a share of a zero total is undefined, not zero', () => {
    const report = computeDrift(
      [target(PETR, '50'), target(VALE, '50')],
      [valued(PETR, '0'), valued(VALE, '0')],
      TOLERANCE,
    );
    expect(report.unavailableReason).toBe(DriftUnavailableReason.NO_TARGETED_VALUE);
    expect(report.unpricedAssetIds).toEqual([]);
    expect(report.rows.every((row) => row.currentPct === null)).toBe(true);
  });

  it('still carries each asset’s value and target while the shares are withheld', () => {
    const report = computeDrift([target(PETR, '40')], [valued(PETR, '250', false)], TOLERANCE);
    expect(report.rows[0]?.value.toString()).toBe('250');
    expect(report.rows[0]?.targetPct.toString()).toBe('40');
  });

  it('treats a target with no matching holding as worth nothing rather than crashing', () => {
    const report = computeDrift([target(PETR, '100')], [], TOLERANCE);
    expect(report.unavailableReason).toBe(DriftUnavailableReason.NO_TARGETED_VALUE);
    expect(report.rows[0]?.value.toString()).toBe('0');
  });
});

describe('isPriceUsable — BR-017-21’s three inputs', () => {
  const NOW = new Date('2026-08-26T14:00:00Z');
  const base = { priceUnavailable: false, sessionOpen: true, cadenceMinutes: 30, now: NOW };

  it('refuses a holding nothing could price, whatever the quote table says', () => {
    expect(isPriceUsable({ ...base, priceUnavailable: true, quotedAt: new Date(NOW) })).toBe(false);
  });

  it('accepts a quote inside the cadence during an open session', () => {
    expect(isPriceUsable({ ...base, quotedAt: new Date('2026-08-26T13:45:00Z') })).toBe(true);
  });

  it('refuses a quote older than the cadence during an open session', () => {
    expect(isPriceUsable({ ...base, quotedAt: new Date('2026-08-26T13:00:00Z') })).toBe(false);
  });

  /**
   * SPEC-008 BR-008-15 / DL-008-03, inherited rather than restated: outside
   * the session a stored quote is never stale, however old. A Saturday reading
   * of Friday's close is not a degraded answer, it is the answer — which is
   * also why SPEC-009's carried-forward close does not disqualify an asset.
   */
  it('accepts an old quote outside the session', () => {
    expect(
      isPriceUsable({
        ...base,
        sessionOpen: false,
        quotedAt: new Date('2026-08-21T20:00:00Z'),
      }),
    ).toBe(true);
  });

  it('refuses an asset with no intraday quote at all while the session is open', () => {
    // Whatever priced this holding is a close, and a close during an open
    // session is at least a day old — past any cadence.
    expect(isPriceUsable({ ...base, quotedAt: null })).toBe(false);
  });

  it('accepts an asset with no intraday quote outside the session', () => {
    expect(isPriceUsable({ ...base, sessionOpen: false, quotedAt: null })).toBe(true);
  });

  it('honours a degraded cadence rather than a hard-coded 30 minutes', () => {
    // BR-008-22: under budget pressure the poller steps out to 60 or 120
    // minutes, and a quote that is fresh *for that cadence* must stay usable.
    const quotedAt = new Date('2026-08-26T13:15:00Z');
    expect(isPriceUsable({ ...base, quotedAt })).toBe(false);
    expect(isPriceUsable({ ...base, cadenceMinutes: 120, quotedAt })).toBe(true);
  });
});
