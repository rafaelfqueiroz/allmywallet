import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { accrualFactor, valueFixedIncome } from './accrual';
import { NeedsAttentionReason, ValuationErrorCode, ValuationMethod } from './ports';
import type { AccrualInputs } from './accrual';
import type { IndexSeriesPoint } from './ports';
import { aContract, indexPoint } from './test-support';

/**
 * SPEC-009 BR-009-07..15 — fixed-income accrual, against hand-computed values.
 *
 * ## Where the CDI fixture numbers come from (TS-10)
 *
 * BCB SGS series 12 publishes the CDI as a **daily** rate in percent, defined
 * by the BCB's own published rule as
 *
 *     daily% = ( (1 + annual/100) ^ (1/252) − 1 ) × 100,  truncated to 8 dp
 *
 * so a fixture is derived from a published *annual* CDI level rather than
 * invented:
 *
 *     13,65 % a.a.  →  1,1365 ^ (1/252) − 1  =  0,0005078803…  →  **0,05078803**
 *     13,15 % a.a.  →  1,1315 ^ (1/252) − 1  =  0,0004903749…  →  **0,04903749**
 *
 * Every expected value below was then computed **independently of this
 * implementation** — by an arbitrary-precision decimal evaluator configured to
 * match `core/shared/money.ts` (40 significant digits, truncating) — and
 * cross-checked by hand through a binomial expansion, shown inline. If the two
 * disagree the implementation is what changes, not the literal.
 *
 * Assertions are made at **8 decimal places** because that is what
 * `NUMERIC(20,8)` stores; carrying all 40 digits into an assertion would test
 * decimal.js's last-ulp behaviour rather than this spec's arithmetic.
 */

const calendar = new B3TradingCalendar();
const CDB = AssetId.of('0000000a-0009-7000-8000-000000000001');
const d = (value: string): BusinessDate => BusinessDate.of(value);

/** The persisted precision — NUMERIC(20,8). `toFixed` truncates (AR-09's rounding mode). */
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

/**
 * CDI at 13,65 % a.a. on 16 and 17 March, cut to 13,15 % a.a. on 18 and 19 —
 * a Copom move inside the accrual window, so the test cannot pass by treating
 * the rate as constant.
 */
const CDI_MARCH: readonly IndexSeriesPoint[] = [
  indexPoint('2026-03-16', '0.05078803'),
  indexPoint('2026-03-17', '0.05078803'),
  indexPoint('2026-03-18', '0.04903749'),
  indexPoint('2026-03-19', '0.04903749'),
  indexPoint('2026-03-20', '0.04903749'),
];

function inputs(overrides: Partial<AccrualInputs> = {}): AccrualInputs {
  return {
    contract: aContract(CDB),
    asOf: d('2026-03-20'),
    calendar,
    cdi: CDI_MARCH,
    ipca: [],
    ...overrides,
  };
}

describe('BR-009-08 / AC-6 — % of CDI, compounded on business days', () => {
  /**
   * R$ 10.000,00 at **110 % of CDI**, issued Monday 2026-03-16 and valued
   * Friday 2026-03-20.
   *
   * Business days in [16 Mar, 20 Mar) = 16, 17, 18, 19 — four. The 20th is
   * excluded: interest is earned *over* a day, and the 20th has not finished.
   *
   *   p = 110 / 100 = 1,1
   *
   *   16 & 17 Mar:  1 + 0,0005078803 × 1,1 = 1,00055866833
   *   18 & 19 Mar:  1 + 0,0004903749 × 1,1 = 1,00053941239
   *
   * Squaring each by binomial expansion, as an independent check:
   *
   *   1,00055866833² = 1 + 2(0,00055866833) + 0,00055866833²
   *                  = 1 + 0,00111733666  + 0,00000031211029…
   *                  = 1,00111764877030294498…
   *   1,00053941239² = 1 + 2(0,00053941239) + 0,00053941239²
   *                  = 1 + 0,00107882478  + 0,00000029096573…
   *                  = 1,00107911574573…
   *
   *   factor = 1,00111764877030294498… × 1,00107911574573…
   *          = 1 + 0,00111764877… + 0,00107911574…
   *              + (0,00111764877… × 0,00107911574…)
   *          = 1 + 0,00219676451… + 0,00000120607…
   *          = 1,002197970588415656252996632310492899145
   *
   *   value  = 10.000 × factor = 10.021,979705884156…
   *          → **10.021,97970588** at NUMERIC(20,8)
   */
  it('accrues to the independently computed figure over four business days', () => {
    const accrued = accrualFactor(inputs());
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;

    expect(accrued.value.basis.businessDays).toBe(4);
    expect(accrued.value.factor.toDecimal().toFixed(30)).toBe('1.002197970588415656252996632310');

    const valued = valueFixedIncome({
      ...inputs(),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('10000'),
    });
    expect(to8(valued.value)).toBe('10021.97970588');
    // BR-009-04 applied to fixed income: accrued interest *is* the unrealised gain.
    expect(to8(valued.unrealizedGain)).toBe('21.97970588');
  });

  it('scales the daily rate by the percentage, day by day', () => {
    /**
     * What "110 % of CDI" means, pinned by comparison with 100 %. At 100 % the
     * factor must be exactly the unscaled product of the published dailies:
     *
     *   1,0005078803² × 1,0004903749²
     *     1,0005078803² = 1 + 2(0,0005078803) + 0,0005078803²
     *                   = 1 + 0,0010157606 + 0,00000025794…
     *                   = 1,00101601854…
     *     1,0004903749² = 1 + 2(0,0004903749) + 0,0004903749²
     *                   = 1 + 0,0009807498 + 0,00000024047…
     *                   = 1,00098099027…
     *     product       = 1,001998005514243414412355915132399220780
     *
     * and the 110 % figure must be strictly larger — a check that the
     * percentage is not being dropped, and not being applied twice.
     */
    const at100 = accrualFactor(inputs({ contract: aContract(CDB, { ratePercent: '100' }) }));
    const at110 = accrualFactor(inputs());
    expect(at100.ok && at110.ok).toBe(true);
    if (!at100.ok || !at110.ok) return;
    expect(at100.value.factor.toDecimal().toFixed(30)).toBe('1.001998005514243414412355915132');
    expect(at110.value.factor.comparedTo(at100.value.factor)).toBe(1);
  });

  it('applies the factor to the ledger’s cost basis, so any quantity is valued correctly', () => {
    // 4 units at an average of R$ 2.500,00 is the same R$ 10.000,00 invested,
    // and must produce the same value — the accrual anchors on cost basis, not
    // on the contract's `principal` field.
    const valued = valueFixedIncome({
      ...inputs(),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('4'),
      averageCost: Money.fromString('2500'),
    });
    expect(to8(valued.value)).toBe('10021.97970588');
    expect(to8(valued.costBasis)).toBe('10000.00000000');
  });

  it('a day with no published CDI does not compound, and the gap is reported', () => {
    // BCB publishes with a lag, so a missing tail day is normal rather than a
    // defect. Dropping 18 March leaves three compounding days:
    //   1,00055866833² × 1,00053941239
    //     = 1,00111764877030294498… × 1,00053941239
    //     = 1,001657664033897314661480501072471
    //   value = **10.016,57664033**
    // The day is neither guessed at nor treated as zero-interest-with-a-shrug:
    // `missingIndexDays` travels with the result so the UI can say so.
    const accrued = accrualFactor({
      ...inputs(),
      cdi: CDI_MARCH.filter((point) => point.date !== '2026-03-18'),
    });
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;
    expect(accrued.value.basis.missingIndexDays).toBe(1);
    expect(accrued.value.basis.businessDays).toBe(4);
    expect(accrued.value.factor.toDecimal().toFixed(30)).toBe('1.001657664033897314661480501072');
  });

  it('an instrument valued on its issue date is worth exactly its principal', () => {
    const accrued = accrualFactor(inputs({ asOf: d('2026-03-16') }));
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;
    expect(accrued.value.basis.businessDays).toBe(0);
    expect(accrued.value.factor.toString()).toBe('1');
  });

  it('skips the weekend — Friday to Monday adds one business day, not three', () => {
    // [16 Mar, 23 Mar) = 16,17,18,19,20 — Sat 21 and Sun 22 earn nothing.
    const accrued = accrualFactor(inputs({ asOf: d('2026-03-23') }));
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;
    expect(accrued.value.basis.businessDays).toBe(5);
  });
});

describe('BR-009-09 / AC-7 — prefixado on the 252-business-day basis', () => {
  /**
   * R$ 5.000,00 at **12 % a.a. prefixado**, issued 2026-03-16, valued
   * 2026-04-30. `DU` = 31 business days (hand-counted in
   * `business-days.test.ts`, excluding Sexta-feira Santa and Tiradentes).
   *
   *   factor = 1,12 ^ (31 / 252) = 1,12 ^ 0,1230158730158730…
   *
   * Independent check via logarithms:
   *   ln 1,12          = 0,113328685307…
   *   × 0,12301587301… = 0,013941199…
   *   e^0,013941199    = 1 + 0,013941199 + 0,000097178 + 0,000000452
   *                    = 1,01403883…
   *   full precision   = 1,014038859244252849711902671951704402468
   *
   *   value = 5.000 × factor = 5.070,194296221264…
   *         → **5.070,19429622**
   *
   * What is deliberately *not* done: a 365-calendar-day pro-rata. The same
   * window is 45 calendar days, so that convention would compute
   * 1,12 ^ (45/365) = 1,0140700946… → **5.070,35047346** — R$ 0,16 higher.
   * The gap is small here only because this window happens to carry close to
   * the average holiday density; a window containing Carnaval *and* Semana
   * Santa has proportionally fewer business days than 252/365 implies and the
   * error does not cancel. The decisive argument is simpler than the size of
   * the drift, though: 252 business days is what the issuer itself computes,
   * so it is the only convention under which a user reconciling against a bank
   * statement can get an exact match (DL-009-08).
   */
  it('compounds pro-rata over 31 business days, not 45 calendar days', () => {
    const valued = valueFixedIncome({
      ...inputs({
        contract: aContract(CDB, { indexer: 'prefixado', ratePercent: '12' }),
        asOf: d('2026-04-30'),
      }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('5000'),
    });
    expect(valued.basis?.businessDays).toBe(31);
    expect(to8(valued.value)).toBe('5070.19429622');
    expect(to8(valued.unrealizedGain)).toBe('70.19429622');
    // The 365-calendar-day figure, excluded explicitly: if the convention ever
    // silently changes, this is the value the code would start producing.
    expect(to8(valued.value)).not.toBe('5070.35047346');
  });

  it('needs no index series at all — the rate is contracted, not observed', () => {
    const accrued = accrualFactor({
      ...inputs({
        contract: aContract(CDB, { indexer: 'prefixado', ratePercent: '12' }),
        asOf: d('2026-04-30'),
      }),
      cdi: [],
    });
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;
    expect(accrued.value.basis.missingIndexDays).toBe(0);
  });

  it('is worth its principal on day one — anything ^ 0 is 1', () => {
    const accrued = accrualFactor(
      inputs({
        contract: aContract(CDB, { indexer: 'prefixado', ratePercent: '12' }),
        asOf: d('2026-03-16'),
      }),
    );
    expect(accrued.ok).toBe(true);
    if (!accrued.ok) return;
    expect(accrued.value.factor.toString()).toBe('1');
  });
});

describe('BR-009-10 / AC-8 — IPCA + spread', () => {
  /**
   * R$ 20.000,00 at **IPCA + 6 % a.a.**, issued 2026-01-15, valued
   * 2026-04-15, with published monthly IPCA of 0,42 % (Jan), 0,83 % (Feb) and
   * 0,16 % (Mar).
   *
   * **SGS 433 dates each point at the first of the month it measures**, which
   * `bcb-sgs.ts` stores verbatim — so January's point is 2026-01-01. The
   * filter is `point.date >= issueDate`, and 1 January precedes a 15 January
   * issue, so **January does not apply**: the contract did not exist for the
   * first half of the month that index measures, and `accrual.ts` applies a
   * month whole or not at all rather than pro-rating it.
   *
   * This fixture previously dated the same three figures one month later,
   * which slipped every point past the filter and made the test assert a
   * number the production path could never produce — R$ 86 high on a R$ 20.000
   * holding, green the whole time.
   *
   *   IPCA factor = 1,0083 × 1,0016            (February and March only)
   *                = 1,0083 + 1,0083 × 0,0016
   *                = 1,0083 + 0,00161328
   *                = **1,00991328**            (exact — no truncation reached)
   *
   *   DU [15 Jan, 15 Apr) = 61 business days
   *   spread = 1,06 ^ (61/252) = 1,06 ^ 0,2420634920634920…
   *     ln 1,06         = 0,058268908123…
   *     × 0,24206349206 = 0,014104764…
   *     e^…             = 1 + 0,014104764 + 0,000099472 + 0,000000468
   *                     = 1,01420470…
   *     full precision  = 1,014204717055610400986196218283678182234
   *
   *   factor = 1,00991328 × 1,014204717055610400986…
   *          = 1,024258812393103442462084657530465403484…
   *
   *   value  = 20.000 × factor = 20.485,176247862068849…
   *          → **20.485,17624786**, of which **485,17624786** is the gain.
   */
  // Dated exactly as BCB publishes them: the first of the month measured.
  const ipcaPoints = [
    indexPoint('2026-01-01', '0.42'),
    indexPoint('2026-02-01', '0.83'),
    indexPoint('2026-03-01', '0.16'),
  ];

  it('applies each published month to principal and accrues the spread on business days', () => {
    const valued = valueFixedIncome({
      ...inputs({
        contract: aContract(CDB, {
          indexer: 'ipca_spread',
          ratePercent: '6',
          issueDate: '2026-01-15',
        }),
        asOf: d('2026-04-15'),
        ipca: ipcaPoints,
      }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('20000'),
    });
    expect(valued.basis?.businessDays).toBe(61);
    expect(to8(valued.value)).toBe('20485.17624786');
    expect(to8(valued.unrealizedGain)).toBe('485.17624786');
  });

  /**
   * BR-009-10's boundary, pinned because it is the part the old fixture hid.
   * A month counts only when the contract existed for all of it — which, given
   * SGS dates a point at the first of the month it measures, is exactly
   * `point.date >= issueDate`. Issuing one day earlier changes the answer by a
   * whole month of inflation, and nothing else in the suite says so.
   */
  it('applies the issue month when the contract existed for all of it, and not otherwise', () => {
    const valueFor = (issueDate: string) =>
      to8(
        valueFixedIncome({
          ...inputs({
            contract: aContract(CDB, { indexer: 'ipca_spread', ratePercent: '0', issueDate }),
            asOf: d('2026-04-15'),
            ipca: ipcaPoints,
          }),
          assetId: CDB,
          assetClass: 'cdb',
          quantity: Quantity.fromString('1'),
          averageCost: Money.fromString('20000'),
        }).value,
      );

    // Issued 1 January: January's point is on the issue date, so it counts.
    // 20.000 × 1,0042 × 1,0083 × 1,0016 = 20.283,09831552
    expect(valueFor('2026-01-01')).toBe('20283.09831552');

    // Issued 2 January: January's point predates the issue and is dropped.
    // 20.000 × 1,0083 × 1,0016 = 20.198,26560000
    expect(valueFor('2026-01-02')).toBe('20198.26560000');
  });

  it('ignores IPCA months outside the accrual window', () => {
    // December 2025's IPCA (dated 2025-12-01) precedes the issue date and must
    // not be applied; May 2026's postdates the valuation. Adding both must
    // leave the figure untouched. January 2026's is already excluded for the
    // same reason — see the worked example above.
    const valued = valueFixedIncome({
      ...inputs({
        contract: aContract(CDB, {
          indexer: 'ipca_spread',
          ratePercent: '6',
          issueDate: '2026-01-15',
        }),
        asOf: d('2026-04-15'),
        ipca: [indexPoint('2025-12-01', '5'), ...ipcaPoints, indexPoint('2026-05-01', '5')],
      }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('20000'),
    });
    expect(to8(valued.value)).toBe('20485.17624786');
  });

  it('with no published IPCA yet, the spread alone still accrues', () => {
    // 1,06 ^ (61/252) applied to R$ 20.000 = 20.284,09434111…
    const valued = valueFixedIncome({
      ...inputs({
        contract: aContract(CDB, {
          indexer: 'ipca_spread',
          ratePercent: '6',
          issueDate: '2026-01-15',
        }),
        asOf: d('2026-04-15'),
        ipca: [],
      }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('20000'),
    });
    // 20.000 × 1,014204717055610400986196218283678182234
    expect(to8(valued.value)).toBe('20284.09434111');
  });
});

describe('BR-009-15 / AC-12 — maturity halts accrual', () => {
  /**
   * The same 110 %-of-CDI CDB, but maturing Wednesday 2026-03-18. Business
   * days in [16 Mar, 18 Mar) = 16 and 17 only, so:
   *
   *   factor = 1,00055866833² = 1,0011176487703029449889
   *   value  = 10.000 × factor = **10.011,17648770**
   *
   * and that figure must not move however far past maturity it is valued. A
   * matured instrument holds its maturity value until a redemption
   * transaction is recorded — anything else invents interest an issuer stopped
   * paying.
   */
  const matured = aContract(CDB, { maturityDate: '2026-03-18' });

  it('stops at the maturity date and stays there', () => {
    const onMaturity = valueFixedIncome({
      ...inputs({ contract: matured, asOf: d('2026-03-18') }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('10000'),
    });
    const nineDaysLater = valueFixedIncome({
      ...inputs({ contract: matured, asOf: d('2026-03-27') }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('10000'),
    });

    expect(to8(onMaturity.value)).toBe('10011.17648770');
    expect(to8(nineDaysLater.value)).toBe('10011.17648770');
    expect(onMaturity.basis?.businessDays).toBe(2);
    expect(nineDaysLater.basis?.businessDays).toBe(2);
  });

  it('reports `matured` from the maturity date onwards, and not before', () => {
    const before = accrualFactor(inputs({ contract: matured, asOf: d('2026-03-17') }));
    const on = accrualFactor(inputs({ contract: matured, asOf: d('2026-03-18') }));
    const after = accrualFactor(inputs({ contract: matured, asOf: d('2026-03-27') }));
    expect(before.ok && before.value.basis.matured).toBe(false);
    expect(on.ok && on.value.basis.matured).toBe(true);
    expect(after.ok && after.value.basis.matured).toBe(true);
    // The cut-off date the UI shows on hover stops moving too.
    expect(after.ok && after.value.basis.throughDate).toBe('2026-03-18');
  });

  it('an instrument with no stated maturity accrues through the valuation date', () => {
    const perpetual = accrualFactor(
      inputs({ contract: aContract(CDB, { maturityDate: null }), asOf: d('2026-03-20') }),
    );
    expect(perpetual.ok).toBe(true);
    if (!perpetual.ok) return;
    expect(perpetual.value.basis.matured).toBe(false);
    expect(perpetual.value.basis.throughDate).toBe('2026-03-20');
  });
});

describe('BR-009-13 / AC-11 — an unreadable rate is valued at cost, flagged, never omitted', () => {
  const common = {
    assetId: CDB,
    assetClass: 'cdb' as const,
    quantity: Quantity.fromString('1'),
    averageCost: Money.fromString('10000'),
  };

  it('a missing contract yields the cost basis and a CONTRACT_MISSING flag', () => {
    const valued = valueFixedIncome({ ...inputs({ contract: null }), ...common });
    // The three things DL-009-05 requires, asserted separately because each
    // has its own failure mode: not zero, not omitted, and visibly flagged.
    expect(to8(valued.value)).toBe('10000.00000000');
    expect(valued.value.isZero()).toBe(false);
    expect(valued.needsAttention).toBe(NeedsAttentionReason.FIXED_INCOME_CONTRACT_MISSING);
    expect(valued.method).toBe(ValuationMethod.COST_FALLBACK);
    expect(valued.estimated).toBe(true);
    expect(valued.basis).toBeNull();
    expect(valued.unrealizedGain.isZero()).toBe(true);
  });

  it('a contract with no indexer yields RATE_UNREADABLE', () => {
    const valued = valueFixedIncome({
      ...inputs({ contract: aContract(CDB, { indexer: null }) }),
      ...common,
    });
    expect(to8(valued.value)).toBe('10000.00000000');
    expect(valued.needsAttention).toBe(NeedsAttentionReason.FIXED_INCOME_RATE_UNREADABLE);
  });

  it('a contract with an indexer but no rate also yields RATE_UNREADABLE', () => {
    const valued = valueFixedIncome({
      ...inputs({ contract: aContract(CDB, { ratePercent: null }) }),
      ...common,
    });
    expect(to8(valued.value)).toBe('10000.00000000');
    expect(valued.needsAttention).toBe(NeedsAttentionReason.FIXED_INCOME_RATE_UNREADABLE);
  });

  it('carries the reason as a code with primitive-only context (AR-37/AR-39)', () => {
    const missing = accrualFactor(inputs({ contract: null }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe(ValuationErrorCode.CONTRACT_MISSING);

    const unreadable = accrualFactor(inputs({ contract: aContract(CDB, { ratePercent: null }) }));
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) return;
    expect(unreadable.error.code).toBe(ValuationErrorCode.RATE_UNREADABLE);
    expect(unreadable.error.context).toEqual({ indexer: 'cdi_percent', hasRate: false });

    const noIndexer = accrualFactor(inputs({ contract: aContract(CDB, { indexer: null }) }));
    expect(noIndexer.ok).toBe(false);
    if (noIndexer.ok) return;
    expect(noIndexer.error.context).toEqual({ indexer: null, hasRate: true });
  });
});

describe('BR-009-11/12 — the estimate marker and the gross-of-tax statement', () => {
  it('an accrued value is always flagged estimated, with its basis for the hover text', () => {
    const valued = valueFixedIncome({
      ...inputs(),
      assetId: CDB,
      assetClass: 'lci',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('10000'),
    });
    expect(valued.estimated).toBe(true);
    expect(valued.method).toBe(ValuationMethod.FIXED_INCOME_ACCRUAL);
    // AC-9: what the UI needs to explain the number, as codes rather than prose.
    expect(valued.basis).toEqual({
      indexer: 'cdi_percent',
      ratePercent: '110',
      businessDays: 4,
      throughDate: '2026-03-20',
      matured: false,
      missingIndexDays: 0,
    });
  });

  it('BR-009-12 / AC-10: every fixed-income figure declares itself gross of IR and IOF', () => {
    for (const assetClass of ['cdb', 'lci', 'lca'] as const) {
      const valued = valueFixedIncome({
        ...inputs(),
        assetId: CDB,
        assetClass,
        quantity: Quantity.fromString('1'),
        averageCost: Money.fromString('10000'),
      });
      expect(valued.grossOfTaxes, assetClass).toBe(true);
      expect(valued.carriedForward, assetClass).toBe(false);
    }
    // The cost-fallback path says the same thing — a flagged figure is still
    // a fixed-income figure, and the UI's disclosure must not disappear with it.
    const fallback = valueFixedIncome({
      ...inputs({ contract: null }),
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('10000'),
    });
    expect(fallback.grossOfTaxes).toBe(true);
  });
});

describe('TS-11 — adversarial precision: 248 business days of repeating decimals', () => {
  /**
   * The test that catches a JS `number` leaking into a money path. Every daily
   * rate below is a non-terminating decimal truncated the way SGS publishes
   * (8 dp) — 1/300 %, 1/400 %, … cycling — compounded across every business
   * day B3 opens in 2026.
   *
   * A float would accumulate error over 248 multiplications and land visibly
   * away from the expected figure; `Decimal` at 40 significant digits does not.
   * The expected value was computed independently at the same precision.
   */
  it('248 compounding steps land exactly on the independently computed value', () => {
    const days: IndexSeriesPoint[] = [];
    let cursor = d('2026-01-02');
    let index = 0;
    while (BusinessDate.isBefore(cursor, d('2026-12-31'))) {
      if (calendar.isTradingDay(cursor)) {
        // 1/(100 × n) for n cycling 3..9 — 0,00333333, 0,0025, 0,002,
        // 0,00166666, 0,00142857, 0,00125, 0,00111111 — truncated to 8 dp.
        const denominator = 3 + (index % 7);
        const percent = Quantity.fromString('1')
          .dividedBy(Quantity.fromString(String(denominator * 100)))
          .toDecimal()
          .toFixed(8);
        days.push({ date: cursor, value: Quantity.fromString(percent) });
        index += 1;
      }
      const next = new Date(`${cursor}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = BusinessDate.of(next.toISOString().slice(0, 10));
    }

    expect(days).toHaveLength(248);
    expect(days[0]?.value.toString()).toBe('0.00333333');
    expect(days[3]?.value.toString()).toBe('0.00166666');

    const valued = valueFixedIncome({
      contract: aContract(CDB, { issueDate: '2026-01-02' }),
      asOf: d('2026-12-31'),
      calendar,
      cdi: days,
      ipca: [],
      assetId: CDB,
      assetClass: 'cdb',
      quantity: Quantity.fromString('1'),
      averageCost: Money.fromString('1000'),
    });

    expect(valued.basis?.businessDays).toBe(248);
    expect(valued.basis?.missingIndexDays).toBe(0);
    expect(to8(valued.value)).toBe('1005.21618409');
  });
});
