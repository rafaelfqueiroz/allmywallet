import { beforeEach, describe, expect, it } from 'vitest';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { replayPositions } from '@/core/positions/replay';

/**
 * SPEC-007's last acceptance criterion: "**Average cost for a real portfolio
 * matches the broker's statement for at least three assets with
 * corporate-event history.**"
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CAN AND CANNOT BE
 *
 * It cannot hold a real statement. DV-24 and TS-19 are absolute: a real B3
 * extract or broker statement carries a real CPF and a real person's holdings,
 * and never enters this repository. So the *comparison against a real
 * statement* is a human step, performed once against a live account and
 * recorded on the issue — it is not automatable without breaking a rule that
 * exists for better reasons than this test.
 *
 * What is automatable, and what this is, is the half that keeps that human
 * check honest: three assets whose histories have the shape a real statement
 * has — fees on acquisition, a split, a grupamento, a bonificação with
 * attributed value, a subscription, and a partial sale after each event — with
 * every expected figure computed by hand and the arithmetic written out
 * (TS-05). If these three disagree with the engine, no real statement is going
 * to agree with it either, and this says so in seconds rather than in a
 * support conversation.
 *
 * The figures are deliberately chosen to divide exactly. A repeating decimal
 * here would make the assertion a statement about `PRECISION` rather than
 * about the rule under test — those belong in `precision.test.ts`, which is
 * where the drift question is actually asked.
 * ---------------------------------------------------------------------------
 */

const PETR4 = assetIdFor('PETR4');
const ITSA4 = assetIdFor('ITSA4');
const HGLG11 = assetIdFor('HGLG11');

beforeEach(() => {
  resetTransactionSequence();
});

function figures(assetId: string, transactions: Parameters<typeof replayPositions>[0]) {
  const replayed = replayPositions(transactions);
  if (!replayed.ok) throw new Error(`replay failed: ${replayed.error.code}`);
  const position = replayed.value.find((snapshot) => snapshot.assetId === assetId);
  if (position === undefined) throw new Error(`no position for ${assetId}`);
  return {
    quantity: position.state.quantity.toString(),
    totalCost: position.state.totalCost.toString(),
    averageCost: position.state.averageCost.toString(),
    realizedGain: position.state.realizedGain.toString(),
  };
}

describe('a portfolio with corporate-event history reconciles to hand-computed figures', () => {
  /**
   * PETR4 — acquisition fees, a 1:2 desdobramento, then a partial sale.
   *
   *   buy 100 @ 32,00 + 5,00 fees → total 3.205,00 ÷ 100 = 32,05
   *   buy  50 @ 34,90 + 0,00 fees → total 4.950,00 ÷ 150 = 33,00
   *   split ×2                    → qty 300, total 4.950,00 ÷ 300 = 16,50
   *                                 (BR-007-04: total cost untouched)
   *   sell 100 @ 20,00 − 8,00 fees → realized (20,00 − 16,50) × 100 − 8,00
   *                                        = 350,00 − 8,00 = 342,00
   *                                 qty 200, total 4.950,00 − 1.650,00 = 3.300,00
   *                                 average unchanged at 16,50 (BR-007-03)
   */
  it('PETR4 — buys with fees, a 1:2 split, then a partial sale', () => {
    const history = [
      aTransaction()
        .buy()
        .of('PETR4')
        .on('2024-03-11')
        .quantity('100')
        .price('32.00')
        .fees('5.00')
        .build(),
      aTransaction().buy().of('PETR4').on('2024-07-15').quantity('50').price('34.90').build(),
      aTransaction().split().of('PETR4').on('2024-11-04').ratio('2').build(),
      aTransaction()
        .sell()
        .of('PETR4')
        .on('2025-02-10')
        .quantity('100')
        .price('20.00')
        .fees('8.00')
        .build(),
    ];

    expect(figures(PETR4, history)).toEqual({
      quantity: '200',
      totalCost: '3300',
      averageCost: '16.5',
      realizedGain: '342',
    });
  });

  /**
   * ITSA4 — a bonificação carrying an attributed value, then a partial sale.
   *
   *   buy 1.000 @ 10,50 + 10,00 fees → total 10.510,00 ÷ 1.000 = 10,51
   *   bonificação 100 @ 4,90         → total 11.000,00 ÷ 1.100 = 10,00
   *                                    (BR-007-05: attributed value is added
   *                                    to cost; quantity rises with it)
   *   sell 100 @ 12,00 − 5,00 fees   → realized (12,00 − 10,00) × 100 − 5,00
   *                                          = 200,00 − 5,00 = 195,00
   *                                    qty 1.000, total 10.000,00, average 10,00
   */
  it('ITSA4 — a bonificação with attributed value, then a partial sale', () => {
    const history = [
      aTransaction()
        .buy()
        .of('ITSA4')
        .on('2024-02-05')
        .quantity('1000')
        .price('10.50')
        .fees('10.00')
        .build(),
      aTransaction()
        .bonificacao()
        .of('ITSA4')
        .on('2024-06-20')
        .quantity('100')
        .price('4.90')
        .build(),
      aTransaction()
        .sell()
        .of('ITSA4')
        .on('2025-01-15')
        .quantity('100')
        .price('12.00')
        .fees('5.00')
        .build(),
    ];

    expect(figures(ITSA4, history)).toEqual({
      quantity: '1000',
      totalCost: '10000',
      averageCost: '10',
      realizedGain: '195',
    });
  });

  /**
   * HGLG11 — a grupamento, then a subscription exercised below the average.
   *
   *   buy 200 @ 149,90 + 20,00 fees → total 30.000,00 ÷ 200 = 150,00
   *   grupamento ×0,5               → qty 100, total 30.000,00 ÷ 100 = 300,00
   *   subscription 20 @ 150,00      → total 33.000,00 ÷ 120 = 275,00
   *                                   (BR-007-06: arithmetically a buy)
   */
  it('HGLG11 — a grupamento, then a subscription', () => {
    const history = [
      aTransaction()
        .buy()
        .of('HGLG11')
        .on('2024-01-10')
        .quantity('200')
        .price('149.90')
        .fees('20.00')
        .build(),
      aTransaction().grupamento().of('HGLG11').on('2024-09-02').ratio('0.5').build(),
      aTransaction()
        .subscription()
        .of('HGLG11')
        .on('2024-12-01')
        .quantity('20')
        .price('150.00')
        .build(),
    ];

    expect(figures(HGLG11, history)).toEqual({
      quantity: '120',
      totalCost: '33000',
      averageCost: '275',
      realizedGain: '0',
    });
  });

  /**
   * AC: "Selling to zero then rebuying resets average cost — no residual
   * carries over."
   *
   * Covered at the arithmetic level in `average-cost.test.ts`; asserted here
   * over a *replayed sequence*, which is how the rule is actually stated and
   * the only level at which "a re-entry starts a new lot" is observable. A
   * carried-over average produces a preço médio matching nothing — not the
   * broker, not the tax return, not intuition.
   */
  it('a position closed to zero and re-entered starts a genuinely new lot', () => {
    const history = [
      aTransaction().buy().of('PETR4').on('2024-01-05').quantity('100').price('30.00').build(),
      aTransaction().sell().of('PETR4').on('2024-06-05').quantity('100').price('45.00').build(),
      // Re-entry, months later, at a completely different price.
      aTransaction().buy().of('PETR4').on('2025-03-10').quantity('50').price('12.00').build(),
    ];

    expect(figures(PETR4, history)).toEqual({
      quantity: '50',
      totalCost: '600',
      // 12,00, not a blend of 30,00 and 12,00 — the lot reset on close.
      averageCost: '12',
      // (45,00 − 30,00) × 100, realised before the reset and never restated.
      realizedGain: '1500',
    });
  });
});
