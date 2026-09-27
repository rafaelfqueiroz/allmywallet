import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { asStored, Money, Quantity } from '@/core/shared/money';
import type { AssetIdentity } from '@/core/ledger/ports';
import type { Transaction } from '@/core/ledger/transaction';
import { FakeTransactionRepository } from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import type { PayoutSchedule } from '@/core/quotes/tesouro-title';
import {
  type AmortizationTerms,
  amortizationBasisOf,
  amortizationTermsOf,
  applyAmortization,
  installmentsRemaining,
  lastPaymentOf,
  loadAmortizationTerms,
} from '@/core/positions/amortization';
import { makePosition, type PositionState } from '@/core/positions/position-state';
import { replayPosition } from '@/core/positions/replay';

/**
 * SPEC-007 BR-007-05c / DL-007-13 — an amortization returns capital.
 *
 * Every expected figure below is computed by hand in the comment beside it
 * (TS-05). The fixtures are the ones #166 names: the owner's VIVT3
 * restituição de capital shape, a FII amortização above the remaining cost,
 * and Tesouro Educa+ / Renda+ titles in their payment phase.
 */

const EDUCA_2026 = 'Tesouro Educa+ 2026';
const RENDA_2030 = 'Tesouro Renda+ Aposentadoria Extra 2030';
const IPCA_2029 = 'Tesouro IPCA+ 2029';
const CDB = 'CDB BANCO X 2027';

function identity(code: string, assetClass: string): AssetIdentity {
  return { assetId: assetIdFor(code), code, assetClass };
}

/** The catalogue as replay sees it: two listed assets, two NTN-B1, two without a rule. */
const TERMS: AmortizationTerms = amortizationTermsOf([
  identity('VIVT3', 'stock'),
  identity('HGLG11', 'fii'),
  identity(EDUCA_2026, 'tesouro_direto'),
  identity(RENDA_2030, 'tesouro_direto'),
  identity(IPCA_2029, 'tesouro_direto'),
  identity(CDB, 'cdb'),
]);

function replay(rows: readonly Transaction[]): PositionState {
  const result = replayPosition(rows, { amortization: TERMS });
  if (!result.ok) throw new Error(`replay failed: ${result.error.code}`);
  return result.value;
}

function figures(state: PositionState) {
  return {
    quantity: state.quantity.toString(),
    totalCost: state.totalCost.toString(),
    averageCost: state.averageCost.toString(),
    realizedGain: state.realizedGain.toString(),
  };
}

/** The 15th of month `k` (0-based) counted from January `year`, as a trade date. */
function fifteenth(year: number, k: number): string {
  const y = year + Math.floor(k / 12);
  const m = (k % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-15`;
}

beforeEach(() => {
  resetTransactionSequence();
});

describe('SPEC-007 BR-007-05c — a listed asset returns the whole amount', () => {
  it("the owner's VIVT3 shape: 240 shares, total cost 5.697,02, restitution of 1,2265 a share", () => {
    // Buy 240 @ 23,70 + 9,02 fees      = 5.688,00 + 9,02   = 5.697,02
    // Restitution 1,2265 × 240          =   294,36         (principal: all of it)
    // Total cost 5.697,02 − 294,36      = 5.402,66
    // Average    5.402,66 ÷ 240         =    22,51108333…  (…3 repeating; 40
    //                                                       significant digits,
    //                                                       truncated — Money)
    // Quantity 240 and realized gain 0 both unchanged.
    const buy = aTransaction().of('VIVT3').buy().on('2024-03-01').quantity('240').price('23.70');
    const before = replay([buy.fees('9.02').build()]);
    expect(before.totalCost.toString()).toBe('5697.02');

    const after = replay([
      buy.fees('9.02').build(),
      aTransaction()
        .of('VIVT3')
        .amortization()
        .on('2024-07-10')
        .quantity('240')
        .price('1.2265')
        .build(),
    ]);
    expect(figures(after)).toEqual({
      quantity: '240',
      totalCost: '5402.66',
      averageCost: `22.51108${'3'.repeat(33)}`,
      realizedGain: '0',
    });
    // What the column stores and a broker statement shows: 22,51108333.
    expect(asStored(after.averageCost)).toBe('22.51108333');
  });

  it('an amount above the remaining cost takes cost to zero and realises the excess (BR-007-09)', () => {
    // Buy 10 HGLG11 @ 5,00                 → cost 50,00, average 5,00
    // Amortização 10 × 6,00 = 60,00:
    //   returned capital = min(60,00; 50,00) = 50,00 → cost 0, average 0
    //   excess           = 60,00 − 50,00     = 10,00 → realized gain 10,00
    // Quantity stays 10.
    const rows = [
      aTransaction().of('HGLG11').buy().on('2026-01-05').quantity('10').price('5.00').build(),
      aTransaction()
        .of('HGLG11')
        .amortization()
        .on('2026-02-10')
        .quantity('10')
        .price('6.00')
        .build(),
    ];
    expect(figures(replay(rows))).toEqual({
      quantity: '10',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '10',
    });

    // A later sale of those shares realises its whole proceeds, since nothing
    // of their cost is left: 10 + (7,00 − 0) × 10 = 80,00.
    const sold = replay([
      ...rows,
      aTransaction().of('HGLG11').sell().on('2026-03-02').quantity('10').price('7.00').build(),
    ]);
    expect(figures(sold)).toEqual({
      quantity: '0',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '80',
    });
  });

  it('an amount exactly equal to the remaining cost realises nothing', () => {
    // 10 @ 5,00 = 50,00; amortização 10 × 5,00 = 50,00 → cost 0, gain 0.
    const rows = [
      aTransaction().of('HGLG11').buy().on('2026-01-05').quantity('10').price('5.00').build(),
      aTransaction()
        .of('HGLG11')
        .amortization()
        .on('2026-02-10')
        .quantity('10')
        .price('5.00')
        .build(),
    ];
    expect(figures(replay(rows))).toEqual({
      quantity: '10',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '0',
    });
  });

  it('on a closed position the whole amount is realized gain, and a re-entry starts a fresh lot', () => {
    // Buy 10 @ 5,00 → 50,00; sell 10 @ 7,00 → realized (7 − 5) × 10 = 20,00,
    // position closed (BR-007-07). Restitution paid after the sale on the
    // shares that were held at record date: 10 × 1,00 = 10,00. Remaining cost
    // is 0, so all 10,00 is above it → realized 20,00 + 10,00 = 30,00.
    // Quantity stays 0. A buy of 5 @ 8,00 afterwards opens 5 / 40,00 / 8,00 —
    // no negative or residual cost carried from the closed lot.
    const rows = [
      aTransaction().of('VIVT3').buy().on('2026-01-05').quantity('10').price('5.00').build(),
      aTransaction().of('VIVT3').sell().on('2026-02-02').quantity('10').price('7.00').build(),
      aTransaction()
        .of('VIVT3')
        .amortization()
        .on('2026-02-20')
        .quantity('10')
        .price('1.00')
        .build(),
    ];
    expect(figures(replay(rows))).toEqual({
      quantity: '0',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '30',
    });
    const reopened = replay([
      ...rows,
      aTransaction().of('VIVT3').buy().on('2026-03-02').quantity('5').price('8.00').build(),
    ]);
    expect(figures(reopened)).toEqual({
      quantity: '5',
      totalCost: '40',
      averageCost: '8',
      realizedGain: '30',
    });
  });

  it('a payment of nothing changes nothing', () => {
    // A hand-entered provento with no quantity: 0 × 1,00 = 0 returned.
    const rows = [
      aTransaction().of('VIVT3').buy().on('2026-01-05').quantity('10').price('5.00').build(),
      aTransaction()
        .of('VIVT3')
        .amortization()
        .on('2026-02-10')
        .quantity('0')
        .price('1.00')
        .build(),
    ];
    expect(figures(replay(rows))).toEqual({
      quantity: '10',
      totalCost: '50',
      averageCost: '5',
      realizedGain: '0',
    });
  });

  it('TS-06 — buy → split → buy → restitution → bonificação → partial sell → restitution', () => {
    // buy 100 @ 20,00 + 10,00        → 100 / 2.010,00 / 20,10
    // split ×2                       → 200 / 2.010,00 / 10,05   (BR-007-04)
    // buy 100 @ 12,85 + 5,00         → 300 / 3.300,00 / 11,00   (BR-007-02)
    // restitution 300 × 0,50 = 150   → 300 / 3.150,00 / 10,50   (BR-007-05c)
    // bonificação 30 at 0,60 each    → 330 / 3.168,00 /  9,60   (BR-007-05: +18,00)
    // sell 130 @ 12,00, fees 6,00    → 200 / 1.920,00 /  9,60   (BR-007-03)
    //   realized (12,00 − 9,60) × 130 − 6,00 = 312,00 − 6,00 = 306,00
    //   cost removed 9,60 × 130 = 1.248,00; 3.168,00 − 1.248,00 = 1.920,00
    // restitution 200 × 0,40 = 80    → 200 / 1.840,00 /  9,20,  realized 306,00
    const v = aTransaction().of('VIVT3');
    const steps: [Transaction, string, string, string, string][] = [
      [
        v.buy().on('2026-01-05').quantity('100').price('20.00').fees('10.00').build(),
        '100',
        '2010',
        '20.1',
        '0',
      ],
      [v.split().on('2026-02-10').ratio('2').build(), '200', '2010', '10.05', '0'],
      [
        v.buy().on('2026-03-16').quantity('100').price('12.85').fees('5.00').build(),
        '300',
        '3300',
        '11',
        '0',
      ],
      [
        v.amortization().on('2026-04-10').quantity('300').price('0.50').build(),
        '300',
        '3150',
        '10.5',
        '0',
      ],
      [
        v.bonificacao().on('2026-05-04').quantity('30').price('0.60').build(),
        '330',
        '3168',
        '9.6',
        '0',
      ],
      [
        v.sell().on('2026-06-01').quantity('130').price('12.00').fees('6.00').build(),
        '200',
        '1920',
        '9.6',
        '306',
      ],
      [
        v.amortization().on('2026-07-10').quantity('200').price('0.40').build(),
        '200',
        '1840',
        '9.2',
        '306',
      ],
    ];
    const ledger: Transaction[] = [];
    for (const [row, quantity, totalCost, averageCost, realizedGain] of steps) {
      ledger.push(row);
      expect(figures(replay(ledger)), `after ${row.type} on ${row.tradeDate}`).toEqual({
        quantity,
        totalCost,
        averageCost,
        realizedGain,
      });
    }
  });

  it('TS-07 — a backdated restitution produces the same position as if it had always been there', () => {
    // The TS-06 sequence's first restitution, entered last. Replay sorts by
    // trade date, so the end state is the same 200 / 1.840,00 / 9,20 / 306,00.
    const v = aTransaction().of('VIVT3');
    const chronological = [
      v.buy().on('2026-01-05').quantity('100').price('20.00').fees('10.00').build(),
      v.split().on('2026-02-10').ratio('2').build(),
      v.buy().on('2026-03-16').quantity('100').price('12.85').fees('5.00').build(),
      v.amortization().on('2026-04-10').quantity('300').price('0.50').build(),
      v.bonificacao().on('2026-05-04').quantity('30').price('0.60').build(),
      v.sell().on('2026-06-01').quantity('130').price('12.00').fees('6.00').build(),
      v.amortization().on('2026-07-10').quantity('200').price('0.40').build(),
    ];
    const backdated = chronological[3] as Transaction;
    const arrival = [...chronological.filter((row) => row !== backdated), backdated];
    expect(figures(replay(arrival))).toEqual(figures(replay(chronological)));
    expect(figures(replay(arrival))).toEqual({
      quantity: '200',
      totalCost: '1840',
      averageCost: '9.2',
      realizedGain: '306',
    });
  });

  it('a same-day sale is applied before the restitution (BR-007-15 rank: proventos last)', () => {
    // Buy 100 @ 10,00 = 1.000,00. Same day 2026-03-10: sell 40 @ 12,00 and a
    // restitution 100 × 1,00 = 100,00 (paid on the 100 held at record date).
    // Sale first: realized (12 − 10) × 40 = 80,00; 60 / 600,00.
    // Restitution: 600,00 − 100,00 = 500,00; average 500,00 ÷ 60 = 8,333…
    const rows = [
      aTransaction().of('VIVT3').buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction()
        .of('VIVT3')
        .amortization()
        .on('2026-03-10')
        .quantity('100')
        .price('1.00')
        .build(),
      aTransaction().of('VIVT3').sell().on('2026-03-10').quantity('40').price('12.00').build(),
    ];
    const state = replay(rows);
    expect(state.quantity.toString()).toBe('60');
    expect(state.totalCost.toString()).toBe('500');
    expect(asStored(state.averageCost)).toBe('8.33333333');
    expect(state.realizedGain.toString()).toBe('80');
  });
});

describe('SPEC-007 BR-007-05c — an NTN-B1 title returns remaining cost ÷ payments remaining', () => {
  it('Educa+ 2026: 2 titles for 6.000,00 amortize 100,00 a month and reach zero on the 60th', () => {
    // Bought 2025-06-10: 2 × 2.995,00 + 10,00 fees = 6.000,00.
    // 2026-01-15: 60 remaining → 6.000,00 ÷ 60 = 100,00 → 5.900,00
    // 2026-02-16 (the 15th is a Sunday): 59 → 5.900,00 ÷ 59 = 100,00 → 5.800,00
    // … each month (6.000,00 − 100,00·k) ÷ (60 − k) = 100,00 exactly …
    // 2030-12-15: 1 remaining → the whole 100,00 left → 0.
    // Each payment is 2 × 55,00 = 110,00: 100,00 principal, 10,00 yield, which
    // stays in the Earnings report and never touches cost (realized gain 0).
    const title = aTransaction().of(EDUCA_2026);
    const ledger: Transaction[] = [
      title.buy().on('2025-06-10').quantity('2').price('2995.00').fees('10.00').build(),
    ];
    expect(replay(ledger).totalCost.toString()).toBe('6000');

    for (let k = 0; k < 60; k += 1) {
      const date = k === 1 ? '2026-02-16' : fifteenth(2026, k);
      ledger.push(title.amortization().on(date).quantity('2').price('55.00').build());
      const state = replay(ledger);
      // 6.000,00 − 100,00 × (k + 1)
      const expected = Money.fromString('6000').minus(Money.fromString('100').times(String(k + 1)));
      expect(state.totalCost.toString(), `after payment ${k + 1} on ${date}`).toBe(
        expected.toString(),
      );
      expect(state.quantity.toString()).toBe('2');
      expect(state.realizedGain.toString()).toBe('0');
    }
    const [first, second] = [ledger.slice(0, 2), ledger.slice(0, 3)].map(replay);
    expect(first?.totalCost.toString()).toBe('5900');
    expect(first?.averageCost.toString()).toBe('2950');
    expect(second?.totalCost.toString()).toBe('5800');
    expect(figures(replay(ledger))).toEqual({
      quantity: '2',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '0',
    });
  });

  it('TS-11 — a repeating principal (1.000,00 ÷ 60) never drifts, and the last payment leaves exactly zero', () => {
    // 1.000,00 ÷ 60 = 16,666… each month. With 40 significant digits and
    // truncation, each step is 16,66666667 at the stored eight places, and
    // because the 60th divides the remainder by 1 the cost ends at a literal
    // 0 — no residue, positive or negative, survives the schedule.
    const title = aTransaction().of(EDUCA_2026);
    const ledger: Transaction[] = [
      title.buy().on('2025-06-10').quantity('1').price('1000.00').build(),
    ];
    let previous = replay(ledger).totalCost;
    for (let k = 0; k < 60; k += 1) {
      ledger.push(title.amortization().on(fifteenth(2026, k)).quantity('1').price('20.00').build());
      const cost = replay(ledger).totalCost;
      expect(asStored(previous.minus(cost)), `principal ${k + 1}`).toBe('16.66666667');
      expect(cost.isNegative()).toBe(false);
      previous = cost;
    }
    expect(previous.toString()).toBe('0');
  });

  it('Renda+ 2030: the first payment returns cost ÷ 240', () => {
    // 1 title for 1.200,00. 2030-01-15: 240 remaining → 1.200,00 ÷ 240 = 5,00
    // → 1.195,00. 2030-02-15: 239 → 1.195,00 ÷ 239 = 5,00 → 1.190,00.
    const title = aTransaction().of(RENDA_2030);
    const ledger = [
      title.buy().on('2029-11-05').quantity('1').price('1200.00').build(),
      title.amortization().on('2030-01-15').quantity('1').price('9.10').build(),
    ];
    expect(replay(ledger).totalCost.toString()).toBe('1195');
    ledger.push(title.amortization().on('2030-02-15').quantity('1').price('9.12').build());
    expect(replay(ledger).totalCost.toString()).toBe('1190');
  });

  it('Renda+ 2030: the 240th payment, on 2049-12-15, returns the whole remaining cost', () => {
    // No payment recorded before the last (a ledger begun late): 1 remaining,
    // so principal = all of 1.200,00 → 0. Quantity stays 1 (BR-007-05c).
    const title = aTransaction().of(RENDA_2030);
    const state = replay([
      title.buy().on('2029-11-05').quantity('1').price('1200.00').build(),
      title.amortization().on('2049-12-15').quantity('1').price('9.10').build(),
    ]);
    expect(figures(state)).toEqual({
      quantity: '1',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '0',
    });
  });

  it('a partial sale in the payment phase: remaining cost ÷ remaining payments still holds', () => {
    // 4 Educa+ 2026 for 6.000,00 (1.500,00 each; 25,00 a title a month).
    // 2026-01-15: 6.000,00 ÷ 60 = 100,00 → 5.900,00
    // 2026-02-16: 5.900,00 ÷ 59 = 100,00 → 5.800,00; average 5.800,00 ÷ 4 = 1.450,00
    // 2026-03-02 sell 1 @ 1.600,00: realized (1.600,00 − 1.450,00) × 1 = 150,00
    //   cost 5.800,00 − 1.450,00 = 4.350,00 over 3
    // 2026-03-16: 58 remaining → 4.350,00 ÷ 58 = 75,00 (= 3 titles × 25,00)
    //   → 4.275,00; average 4.275,00 ÷ 3 = 1.425,00 (= 1.500,00 − 3 × 25,00)
    const title = aTransaction().of(EDUCA_2026);
    const ledger = [
      title.buy().on('2025-06-10').quantity('4').price('1500.00').build(),
      title.amortization().on('2026-01-15').quantity('4').price('27.00').build(),
      title.amortization().on('2026-02-16').quantity('4').price('27.00').build(),
      title.sell().on('2026-03-02').quantity('1').price('1600.00').build(),
    ];
    expect(figures(replay(ledger))).toEqual({
      quantity: '3',
      totalCost: '4350',
      averageCost: '1450',
      realizedGain: '150',
    });
    ledger.push(title.amortization().on('2026-03-16').quantity('3').price('27.00').build());
    expect(figures(replay(ledger))).toEqual({
      quantity: '3',
      totalCost: '4275',
      averageCost: '1425',
      realizedGain: '150',
    });
  });

  it('a closed NTN-B1 position has no cost to return: the payment changes nothing', () => {
    // 1 Educa+ for 3.000,00, sold 2026-03-02 @ 3.100,00 → realized 100,00,
    // closed. 2026-03-16: 0 ÷ 58 = 0 principal; the payment is all yield.
    const title = aTransaction().of(EDUCA_2026);
    const state = replay([
      title.buy().on('2025-06-10').quantity('1').price('3000.00').build(),
      title.sell().on('2026-03-02').quantity('1').price('3100.00').build(),
      title.amortization().on('2026-03-16').quantity('1').price('55.00').build(),
    ]);
    expect(figures(state)).toEqual({
      quantity: '0',
      totalCost: '0',
      averageCost: '0',
      realizedGain: '100',
    });
  });

  it.each([
    ['2025-12-15', 'before the first payment'],
    ['2031-01-15', 'after the last payment'],
  ])('refuses a payment dated %s, %s — no count of payments remaining exists', (date) => {
    const title = aTransaction().of(EDUCA_2026);
    const result = replayPosition(
      [
        title.buy().on('2025-06-10').quantity('1').price('3000.00').build(),
        title.amortization().on(date).quantity('1').price('55.00').build(),
      ],
      { amortization: TERMS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AMORTIZATION_OUTSIDE_SCHEDULE');
    expect(result.error.context).toEqual({
      date,
      firstPayment: '2026-01-15',
      lastPayment: '2030-12-15',
    });
  });
});

describe('SPEC-007 BR-007-05c — an asset with no principal rule is refused, not guessed', () => {
  it.each([
    [IPCA_2029, 'a Tesouro title that is not NTN-B1'],
    [CDB, 'bank paper'],
  ])('%s (%s)', (code) => {
    const result = replayPosition(
      [
        aTransaction().of(code).buy().on('2025-06-10').quantity('1').price('1000.00').build(),
        aTransaction()
          .of(code)
          .amortization()
          .on('2026-03-16')
          .quantity('1')
          .price('50.00')
          .build(),
      ],
      { amortization: TERMS },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AMORTIZATION_NOT_SUPPORTED');
    expect(result.error.context).toEqual({ date: '2026-03-16' });
  });
});

describe('amortizationBasisOf — the class decides, the code only for Tesouro', () => {
  it.each(['stock', 'fii', 'bdr', 'etf'])('a %s returns the whole amount', (assetClass) => {
    expect(amortizationBasisOf(identity('XPTO3', assetClass))).toEqual({ kind: 'whole_amount' });
  });

  it('a listed class is never read as a Tesouro code', () => {
    expect(amortizationBasisOf(identity(EDUCA_2026, 'stock'))).toEqual({ kind: 'whole_amount' });
  });

  it('an Educa+ or Renda+ title pays in instalments', () => {
    expect(amortizationBasisOf(identity(EDUCA_2026, 'tesouro_direto'))).toEqual({
      kind: 'installments',
      schedule: { firstPayment: '2026-01-15', installments: 60 },
    });
    expect(amortizationBasisOf(identity(RENDA_2030, 'tesouro_direto'))).toEqual({
      kind: 'installments',
      schedule: { firstPayment: '2030-01-15', installments: 240 },
    });
  });

  it.each([
    [IPCA_2029, 'tesouro_direto'],
    [CDB, 'cdb'],
    ['LCI BANCO X 2027', 'lci'],
    ['LCA BANCO X 2027', 'lca'],
  ])('%s (%s) has no rule', (code, assetClass) => {
    expect(amortizationBasisOf(identity(code, assetClass))).toEqual({ kind: 'unsupported' });
  });
});

describe('installmentsRemaining — counted by month, including this payment', () => {
  const educa: PayoutSchedule = {
    firstPayment: BusinessDate.of('2026-01-15'),
    installments: 60,
  };

  it.each([
    ['2026-01-15', 60],
    ['2026-01-10', 60], // same month as the first payment
    ['2026-02-16', 59], // the 15th slid to Monday
    ['2027-01-15', 48], // 12 months elapsed: 60 − 12
    ['2030-11-17', 2],
    ['2030-12-15', 1],
  ])('%s → %i', (date, remaining) => {
    expect(installmentsRemaining(educa, BusinessDate.of(date))).toBe(remaining);
  });

  it.each(['2025-12-15', '2031-01-15', '2040-06-15'])('%s is outside the schedule', (date) => {
    expect(installmentsRemaining(educa, BusinessDate.of(date))).toBeNull();
  });

  it('the last payment is the maturity: Educa+ 2026 → 2030-12-15, Renda+ 2030 → 2049-12-15', () => {
    expect(lastPaymentOf(educa)).toBe('2030-12-15');
    // 2030-01 + 239 months = 2030-01 + 19 years 11 months = 2049-12.
    expect(lastPaymentOf({ firstPayment: BusinessDate.of('2030-01-15'), installments: 240 })).toBe(
      '2049-12-15',
    );
  });
});

describe('applyAmortization — the handler on its own', () => {
  it('keeps an explicit average out of it: the average is recomputed from the new cost', () => {
    // 3 @ 10,00 = 30,00 with the sale-carried average 10,00; 10,00 returned
    // → 20,00 ÷ 3 = 6,666…
    const state = makePosition(
      Quantity.fromString('3'),
      Money.fromString('30'),
      Money.zero(),
      Money.fromString('10'),
    );
    const result = applyAmortization(state, {
      received: Money.fromString('10'),
      basis: { kind: 'whole_amount' },
      date: BusinessDate.of('2026-02-10'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCost.toString()).toBe('20');
    expect(asStored(result.value.averageCost)).toBe('6.66666667');
  });
});

describe('loadAmortizationTerms — every stored amortization, plus the rows about to be added', () => {
  it('describes the amortized assets and the included ones, and nothing undescribed', async () => {
    const repository = new FakeTransactionRepository([
      aTransaction().of('VIVT3').amortization().build(),
      aTransaction().of('PETR4').buy().build(),
      aTransaction().of('UNKNOWN11').amortization().build(),
    ]);
    repository.describeAsset(assetIdFor('VIVT3'), {
      code: 'VIVT3',
      name: 'Telefônica Brasil ON',
      assetClass: 'stock',
    });
    repository.describeAsset(assetIdFor(EDUCA_2026), {
      code: EDUCA_2026,
      name: EDUCA_2026,
      assetClass: 'tesouro_direto',
    });
    repository.describeAsset(assetIdFor('PETR4'), {
      code: 'PETR4',
      name: 'Petrobras PN',
      assetClass: 'stock',
    });

    const terms = await loadAmortizationTerms(repository, [assetIdFor(EDUCA_2026)]);

    expect(terms.get(assetIdFor('VIVT3'))).toEqual({ kind: 'whole_amount' });
    expect(terms.get(assetIdFor(EDUCA_2026))?.kind).toBe('installments');
    // Held but never amortized, and not included: not asked for.
    expect(terms.has(assetIdFor('PETR4'))).toBe(false);
    // Amortized but absent from the catalogue: unknown, so its replay fails closed.
    expect(terms.has(assetIdFor('UNKNOWN11'))).toBe(false);
  });
});
