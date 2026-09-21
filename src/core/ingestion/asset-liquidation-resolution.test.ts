import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity, asStored } from '@/core/shared/money';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import { replayPosition } from '@/core/positions/replay';
import { externalFlow } from '@/core/valuation/snapshot';
import {
  ASSET_LIQUIDATION_DEFINITIONS,
  type AssetLiquidationDefinition,
} from '@/core/ingestion/asset-conversion-definitions';
import {
  isRedemptionInTradingBlock,
  type LiquidationEvidence,
  type ResolvedLiquidation,
  liquidationGroupKey,
  resolveLiquidation,
} from '@/core/ingestion/asset-liquidation-resolution';

/**
 * SPEC-005 BR-005-20c (#143 D10) — the liquidation resolver, on generated
 * holdings (DV-24). Only the administrator's per-share figures are real.
 */
const definition = ASSET_LIQUIDATION_DEFINITIONS.find(
  (candidate) => candidate.id === 'bpff11-and-hgff11-liquidated-into-rvbi11',
) as AssetLiquidationDefinition;

function redemption(
  id: string,
  code: string,
  quantity: string,
  overrides: Partial<LiquidationEvidence> = {},
): LiquidationEvidence {
  return {
    id,
    role: 'source_redemption',
    assetCode: code,
    tradeDate: BusinessDate.of('2025-10-14'),
    quantity: Quantity.fromString(quantity),
    state: 'open',
    heldBefore: Quantity.fromString(quantity),
    ...overrides,
  };
}

function credit(
  id: string,
  quantity: string,
  overrides: Partial<LiquidationEvidence> = {},
): LiquidationEvidence {
  return {
    id,
    role: 'target_credit',
    assetCode: 'RVBI15',
    tradeDate: BusinessDate.of('2025-10-06'),
    quantity: Quantity.fromString(quantity),
    state: 'open',
    ...overrides,
  };
}

const complete = () => [
  credit('rvbi15-a', '83.89'),
  credit('rvbi15-b', '75.36'),
  redemption('bpff-resgate', 'BPFF11', '90'),
  redemption('hgff-resgate', 'HGFF11', '70'),
];

const resolve = (evidence: readonly LiquidationEvidence[], windowDays = 45) =>
  resolveLiquidation({ definition, evidence, windowDays });

describe('SPEC-005 BR-005-20c (#143 D10) — a liquidation paid partly in another asset', () => {
  it('sells each source at its liquidation value and subscribes the target at its unit cost', () => {
    const resolution = resolve(complete());

    expect(resolution.status).toBe('resolved');
    const { writes, proceeds, acquisitionCost, anchorDate } = resolution as ResolvedLiquidation;
    expect(anchorDate).toBe('2025-10-06');
    expect(
      writes.map((w) => [
        w.evidenceId,
        w.type,
        w.assetCode,
        w.tradeDate,
        w.quantity.toString(),
        w.unitPrice.toString(),
      ]),
    ).toEqual([
      // B3's dates and quantities; the administrator's prices; RVBI11, never
      // the receipt code RVBI15.
      ['bpff-resgate', 'sell', 'BPFF11', '2025-10-14', '90', '62.03538245'],
      ['hgff-resgate', 'sell', 'HGFF11', '2025-10-14', '70', '71.04670108'],
      ['rvbi15-a', 'subscription', 'RVBI11', '2025-10-06', '83.89', '64.15'],
      ['rvbi15-b', 'subscription', 'RVBI11', '2025-10-06', '75.36', '64.15'],
    ]);
    // 90 × 62,03538245 = 5.583,1844205; 70 × 71,04670108 = 4.973,2690756.
    expect(proceeds.toString()).toBe('10556.4534961');
    // 83,89 × 64,15 = 5.381,5435; 75,36 × 64,15 = 4.834,344.
    expect(acquisitionCost.toString()).toBe('10215.8875');
  });

  it('realises the hand-computed result on each source through the ordinary sell path (DL-007-02)', () => {
    const { writes } = resolve(complete()) as ResolvedLiquidation;
    const sale = (code: string) => {
      const plan = writes.find((w) => w.assetCode === code);
      if (plan === undefined) throw new Error(code);
      return aTransaction()
        .sell()
        .of(code)
        .on(plan.tradeDate)
        .quantity(plan.quantity.toString())
        .price(plan.unitPrice.toString())
        .fees('0')
        .build();
    };
    // BPFF11: 90 @ 100,00 → cost 9.000,00. Sale 5.583,1844205:
    // realised 5.583,1844205 − 9.000,00 = −3.416,8155795; average unchanged
    // until the position closes (BR-007-03).
    const bpff = replayPosition([
      aTransaction()
        .buy()
        .of('BPFF11')
        .on('2024-03-01')
        .quantity('90')
        .price('100')
        .fees('0')
        .build(),
      sale('BPFF11'),
    ]);
    if (!bpff.ok) throw new Error('BPFF11 does not replay');
    expect(bpff.value.quantity.toString()).toBe('0');
    expect(bpff.value.realizedGain.toString()).toBe('-3416.8155795');
    // HGFF11: 70 @ 103,79 + 0,02 → 7.265,32. Sale 4.973,2690756: realised
    // −2.292,0509244 (the average repeats, so exact at the column's scale).
    const hgff = replayPosition([
      aTransaction()
        .buy()
        .of('HGFF11')
        .on('2024-03-01')
        .quantity('70')
        .price('103.79')
        .fees('0.02')
        .build(),
      sale('HGFF11'),
    ]);
    if (!hgff.ok) throw new Error('HGFF11 does not replay');
    expect(asStored(hgff.value.realizedGain)).toBe('-2292.05092440');
  });

  it('flows out the sales and in the acquisitions: −340,5659961 against B3’s 340,32 of cash', () => {
    const { writes } = resolve(complete()) as ResolvedLiquidation;
    const flow = writes
      .map((w) =>
        (w.type === 'sell' ? aTransaction().sell() : aTransaction().subscription())
          .of(w.assetCode)
          .on(w.tradeDate)
          .quantity(w.quantity.toString())
          .price(w.unitPrice.toString())
          .fees('0')
          .build(),
      )
      .reduce((sum, t) => sum.plus(externalFlow(t)), Money.zero());
    // 10.215,8875 − 10.556,4534961. B3 states 90 × 2,239 + 70 × 1,983 =
    // 201,51 + 138,81 = 340,32; the 0,2459961 is the administrator's sub-cent
    // figures B3 does not carry, accepted by #143 D10.
    expect(flow.toString()).toBe('-340.5659961');
  });

  it('refuses on a partial extract: the receipts without the cash, or the cash without the receipts (BR-005-17)', () => {
    const [a, b, bpff, hgff] = complete() as [
      LiquidationEvidence,
      LiquidationEvidence,
      LiquidationEvidence,
      LiquidationEvidence,
    ];
    expect(resolve([a, b])).toEqual({ status: 'unresolved', reason: 'incomplete' });
    expect(resolve([a, b, bpff])).toEqual({ status: 'unresolved', reason: 'incomplete' });
    expect(resolve([bpff, hgff])).toEqual({ status: 'unresolved', reason: 'incomplete' });
    // A credit that adds nothing is no credit.
    expect(resolve([credit('zero', '0'), bpff, hgff])).toEqual({
      status: 'unresolved',
      reason: 'incomplete',
    });
  });

  it('refuses ambiguity: two Resgates of one source, or credits on two dates', () => {
    expect(resolve([...complete(), redemption('bpff-second', 'BPFF11', '90')])).toEqual({
      status: 'unresolved',
      reason: 'ambiguous',
    });
    expect(
      resolve([
        credit('rvbi15-a', '83.89'),
        credit('rvbi15-b', '75.36', { tradeDate: BusinessDate.of('2025-10-07') }),
        redemption('bpff-resgate', 'BPFF11', '90'),
        redemption('hgff-resgate', 'HGFF11', '70'),
      ]),
    ).toEqual({ status: 'unresolved', reason: 'ambiguous' });
  });

  it('refuses a Resgate outside the window, and an invalid window', () => {
    // 2025-10-06 → 2025-10-14 is 8 days.
    expect(resolve(complete(), 7)).toEqual({ status: 'unresolved', reason: 'outside_window' });
    expect(resolve(complete(), 8).status).toBe('resolved');
    expect(resolve(complete(), -1)).toEqual({ status: 'unresolved', reason: 'outside_window' });
    // Review F1: never before the credits — the cash follows the receipts.
    const early = complete().map((item) =>
      item.id === 'bpff-resgate' ? { ...item, tradeDate: BusinessDate.of('2025-10-05') } : item,
    );
    expect(resolve(early)).toEqual({ status: 'unresolved', reason: 'outside_window' });
    expect(resolve(complete(), 1.5)).toEqual({ status: 'unresolved', reason: 'outside_window' });
  });

  it('refuses a Resgate that is not the whole position, or a position that does not replay', () => {
    const [a, b, , hgff] = complete() as LiquidationEvidence[];
    expect(
      resolve([
        a as LiquidationEvidence,
        b as LiquidationEvidence,
        redemption('bpff-resgate', 'BPFF11', '90', { heldBefore: Quantity.fromString('100') }),
        hgff as LiquidationEvidence,
      ]),
    ).toEqual({ status: 'unresolved', reason: 'quantity_mismatch' });
    expect(
      resolve([
        a as LiquidationEvidence,
        b as LiquidationEvidence,
        redemption('bpff-resgate', 'BPFF11', '90', { heldBefore: null }),
        hgff as LiquidationEvidence,
      ]),
    ).toEqual({ status: 'unresolved', reason: 'quantity_mismatch' });
  });

  it('never completes around a row a user edited', () => {
    const evidence = complete().map((item) =>
      item.id === 'bpff-resgate' ? { ...item, state: 'locked' as const } : item,
    );
    expect(resolve(evidence)).toEqual({ status: 'unresolved', reason: 'user_modified' });
  });

  it('is idempotent: rows already applied are not written again', () => {
    const applied = complete().map((item) => ({ ...item, state: 'applied' as const }));
    expect(resolve(applied)).toEqual({
      status: 'applied',
      definitionId: 'bpff11-and-hgff11-liquidated-into-rvbi11',
      anchorDate: '2025-10-06',
    });
    // Only the rows still open are written.
    const partly = complete().map((item) =>
      item.role === 'source_redemption' ? { ...item, state: 'applied' as const } : item,
    );
    const resolution = resolve(partly) as ResolvedLiquidation;
    expect(resolution.writes.map((w) => w.evidenceId)).toEqual(['rvbi15-a', 'rvbi15-b']);
    // The group's figures are still the whole liquidation's.
    expect(resolution.proceeds.toString()).toBe('10556.4534961');
  });

  it('reads a target coded like its ledger code when the definition names no evidence code', () => {
    const plain: AssetLiquidationDefinition = {
      id: 'src-liquidated-into-tgt',
      sources: [
        {
          assetCode: 'SRC11',
          liquidationValue: Money.fromString('10'),
          tradingBlockedFrom: BusinessDate.of('2025-08-18'),
        },
      ],
      target: { assetCode: 'TGT11', unitCost: Money.fromString('4') },
    };
    // 3 SRC11 at 10,00 = 30,00 of proceeds; 7,5 TGT11 at 4,00 = 30,00 acquired.
    const resolution = resolveLiquidation({
      definition: plain,
      evidence: [credit('tgt', '7.5', { assetCode: 'TGT11' }), redemption('src', 'SRC11', '3')],
      windowDays: 45,
    }) as ResolvedLiquidation;
    expect(resolution.proceeds.toString()).toBe('30');
    expect(resolution.acquisitionCost.toString()).toBe('30');
    expect(resolution.writes.map((w) => [w.type, w.assetCode])).toEqual([
      ['sell', 'SRC11'],
      ['subscription', 'TGT11'],
    ]);
  });

  it('keys a liquidation by definition, institution and the credits’ date', () => {
    expect(liquidationGroupKey('d', 'inst', BusinessDate.of('2025-10-06'))).toBe(
      'liquidation:d:inst:2025-10-06',
    );
    expect(liquidationGroupKey('d', null, BusinessDate.of('2025-10-06'))).toBe(
      'liquidation:d:none:2025-10-06',
    );
  });

  describe('review F1 — a stored sale under the mapped key read as the Resgate', () => {
    const bpff = definition.sources[0] as AssetLiquidationDefinition['sources'][number];
    const sale = (date: string, quantity: string) =>
      aTransaction()
        .sell()
        .of('BPFF11')
        .on(date)
        .quantity(quantity)
        .price('2.239')
        .imported()
        .build();
    const ninety = Quantity.fromString('90');

    it('is the Resgate: an untouched import of the whole position inside the trading block', () => {
      // Block from 2025-08-18 (fato relevante of 12/08/2025); 90 held, 90 sold.
      expect(isRedemptionInTradingBlock(sale('2025-10-14', '90'), bpff, ninety)).toBe(true);
      // The block's first day counts.
      expect(isRedemptionInTradingBlock(sale('2025-08-18', '90'), bpff, ninety)).toBe(true);
    });

    it('is not before the block, nor part of the position, nor with no replayable position', () => {
      expect(isRedemptionInTradingBlock(sale('2025-08-15', '90'), bpff, ninety)).toBe(false);
      expect(isRedemptionInTradingBlock(sale('2025-10-14', '40'), bpff, ninety)).toBe(false);
      expect(isRedemptionInTradingBlock(sale('2025-10-14', '90'), bpff, null)).toBe(false);
    });

    it('is never a row a person touched, entered, or that is not an active sell', () => {
      const whole = sale('2025-10-14', '90');
      for (const t of [
        { ...whole, isUserModified: true },
        { ...whole, isManual: true },
        { ...whole, importBatchId: null },
        { ...whole, status: 'unclassified' as const },
        { ...whole, type: 'buy' as const },
      ]) {
        expect(isRedemptionInTradingBlock(t, bpff, ninety)).toBe(false);
      }
    });
  });
});
