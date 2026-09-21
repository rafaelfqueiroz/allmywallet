import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity, sumMoney } from '@/core/shared/money';
import { ASSET_CONVERSION_DEFINITIONS } from '@/core/ingestion/asset-conversion-definitions';
import type { AssetConversionDefinition } from '@/core/ingestion/asset-conversion-definitions';
import {
  corroboratesSourceBalance,
  resolveAssetConversion,
  type AssetConversionEvidence,
  type AssetConversionSourcePosition,
  type ResolvedAssetConversion,
} from '@/core/ingestion/asset-conversion-resolution';

const oneToOne: AssetConversionDefinition = {
  id: 'old3-to-new3',
  sourceAssetCodes: ['OLD3'],
  targets: [{ assetCode: 'NEW3', allocationWeight: null }],
};

function evidence(
  id: string,
  assetCode: string,
  before: string,
  after: string,
  movement:
    'atualizacao' | 'resgate' | 'incorporacao' | 'transfer_in' | 'transfer_out' = 'atualizacao',
  date = '2026-04-01',
): AssetConversionEvidence {
  return {
    id,
    assetCode,
    movement,
    tradeDate: BusinessDate.of(date),
    beforeQuantity: Quantity.fromString(before),
    statementQuantity: Quantity.fromString(after),
  };
}

function source(
  assetCode: string,
  quantity: string,
  averageCost: string | null,
): AssetConversionSourcePosition {
  return {
    assetCode,
    quantity: Quantity.fromString(quantity),
    totalCost:
      averageCost === null
        ? null
        : Money.fromString(averageCost).times(Quantity.fromString(quantity)),
  };
}

function resolve(
  definitions: readonly AssetConversionDefinition[],
  rows: readonly AssetConversionEvidence[],
  sources: readonly AssetConversionSourcePosition[],
  window = 7,
) {
  return resolveAssetConversion({
    definitions,
    evidence: rows,
    sourcePositions: sources,
    conversionWindowDays: window,
  });
}

function expectResolved(result: ReturnType<typeof resolve>): ResolvedAssetConversion {
  expect(result.status).toBe('resolved');
  if (result.status !== 'resolved') throw new Error(`Expected resolved, got ${result.reason}`);
  return result;
}

describe('SPEC-005 BR-005-20c / SPEC-007 BR-007-05b — asset conversion planning', () => {
  it('rounds a partial removed cost once and writes the same exact amount on both legs', () => {
    const result = expectResolved(
      resolve(
        [oneToOne],
        [
          evidence('source-row', 'OLD3', '2', '1', 'resgate'),
          evidence('target-row', 'NEW3', '0', '1'),
        ],
        [
          {
            assetCode: 'OLD3',
            quantity: Quantity.fromString('2'),
            totalCost: Money.fromString('1.00000001'),
          },
        ],
      ),
    );
    expect(result.legs.map((leg) => leg.costBasis?.toString())).toEqual([
      '0.50000001',
      '0.50000001',
    ]);
  });

  it('resolves explicit one-to-one conversion from target Atualização and replayed source alone', () => {
    const result = expectResolved(
      resolve(
        [oneToOne],
        [evidence('target-row', 'NEW3', '0', '20')],
        [source('OLD3', '80', '12.50')],
      ),
    );

    // 80 OLD3 × R$ 12,50 = R$ 1.000,00 carried to 20 NEW3.
    expect(result.totalCost.toString()).toBe('1000');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.removedCost.toString()).toBe('1000');
    expect(
      result.legs.map((leg) => ({
        type: leg.type,
        code: leg.assetCode,
        quantity: leg.quantity.toString(),
        cost: leg.costBasis?.toString() ?? null,
        row: leg.evidenceId,
        cash: leg.totalValue.toString(),
      })),
    ).toEqual([
      {
        type: 'conversion_out',
        code: 'OLD3',
        quantity: '80',
        cost: '1000',
        row: null,
        cash: '0',
      },
      {
        type: 'conversion_in',
        code: 'NEW3',
        quantity: '20',
        cost: '1000',
        row: 'target-row',
        cash: '0',
      },
    ]);
  });

  it('uses a source balance row when present and combines multiple sources', () => {
    const definition: AssetConversionDefinition = {
      id: 'a-and-b-to-c',
      sourceAssetCodes: ['A3', 'B3'],
      targets: [{ assetCode: 'C3', allocationWeight: null }],
    };
    const result = expectResolved(
      resolve(
        [definition],
        [
          evidence('a-row', 'A3', '10', '2', 'resgate'),
          evidence('b-row', 'B3', '4', '0', 'resgate'),
          evidence('c-row', 'C3', '0', '7'),
        ],
        [source('A3', '10', '3.25'), source('B3', '4', '5.625')],
      ),
    );

    // A: 8 × 3,25 = 26,00; B: 4 × 5,625 = 22,50; target carries 48,50.
    expect(result.totalCost.toString()).toBe('48.5');
    expect(result.legs.at(-1)?.costBasis?.toString()).toBe('48.5');
  });

  it('allocates weighted one-to-many and puts storage residual on the final target', () => {
    const definition: AssetConversionDefinition = {
      id: 'one-to-three',
      sourceAssetCodes: ['OLD3'],
      targets: [
        { assetCode: 'A3', allocationWeight: Quantity.fromString('1') },
        { assetCode: 'B3', allocationWeight: Quantity.fromString('1') },
        { assetCode: 'C3', allocationWeight: Quantity.fromString('1') },
      ],
    };
    const result = expectResolved(
      resolve(
        [definition],
        [
          evidence('a', 'A3', '0', '2'),
          evidence('b', 'B3', '0', '3'),
          evidence('c', 'C3', '0', '4'),
        ],
        [source('OLD3', '1', '100')],
      ),
    );
    const incoming = result.legs.filter((leg) => leg.type === 'conversion_in');
    expect(incoming.map((leg) => leg.costBasis?.toString())).toEqual([
      '33.33333333',
      '33.33333333',
      '33.33333334',
    ]);
    expect(
      sumMoney(
        incoming.flatMap((leg) => (leg.costBasis === null ? [] : [leg.costBasis])),
      ).toString(),
    ).toBe('100');
  });

  it('splits one target allocation over repeated same-day transfer credits without losing cost', () => {
    const definition = ASSET_CONVERSION_DEFINITIONS.find(
      (candidate) => candidate.id === 'klbn11-to-klbn3-and-klbn4',
    );
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    const result = expectResolved(
      resolve(
        [definition],
        [
          evidence('out', 'KLBN11', '0.6', '0', 'transfer_out'),
          evidence('k3', 'KLBN3', '0', '0.6', 'transfer_in'),
          evidence('k4-whole', 'KLBN4', '0', '2', 'transfer_in'),
          evidence('k4-fraction', 'KLBN4', '0', '0.4', 'transfer_in'),
        ],
        [source('KLBN11', '0.6', '10')],
      ),
    );
    const incoming = result.legs.filter((leg) => leg.type === 'conversion_in');
    expect(
      incoming.map((leg) => [leg.assetCode, leg.quantity.toString(), leg.costBasis?.toString()]),
    ).toEqual([
      ['KLBN3', '0.6', '1.2'],
      ['KLBN4', '2', '4'],
      ['KLBN4', '0.4', '0.8'],
    ]);
    expect(sumMoney(incoming.map((leg) => leg.costBasis ?? Money.zero())).toString()).toBe('6');
  });

  it('resolves an exact-zero-cost position and preserves zero exactly', () => {
    const result = expectResolved(
      resolve([oneToOne], [evidence('target', 'NEW3', '0', '5')], [source('OLD3', '5', '0')]),
    );
    expect(result.totalCost.toString()).toBe('0');
    expect(result.sources[0]?.removedCost.toString()).toBe('0');
    expect(result.legs[0]?.costBasis?.toString()).toBe('0');
    expect(result.legs[1]?.costBasis?.toString()).toBe('0');
  });

  it('produces deterministic non-UUID group/leg keys independent of input order', () => {
    const rows = [evidence('target', 'NEW3', '0', '5')];
    const sources = [source('OLD3', '5', '12.5')];
    const first = expectResolved(resolve([oneToOne], rows, sources));
    const second = expectResolved(resolve([oneToOne], [...rows].reverse(), [...sources].reverse()));
    expect(second.groupKey).toBe(first.groupKey);
    expect(first.groupKey.startsWith('conversion:v8:')).toBe(true);
    expect(second.legs.map((leg) => leg.key).sort()).toEqual(
      first.legs.map((leg) => leg.key).sort(),
    );
  });

  it('maps AXIA15 movement evidence to the canonical AXIA15G ledger asset', () => {
    const definition = ASSET_CONVERSION_DEFINITIONS.find(
      (candidate) => candidate.id === 'axia7-to-axia15g',
    );
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    const result = expectResolved(
      resolve(
        [definition],
        [evidence('axia-target', 'AXIA15', '0', '12')],
        // #128 D3: AXIA7 alone. 12 of the 12 held leave, so the whole
        // 12 × 10,00 = 120,00 goes to the single AXIA15G target.
        [source('AXIA7', '12', '10')],
      ),
    );
    expect(
      result.legs.filter((leg) => leg.type === 'conversion_in').map((leg) => leg.assetCode),
    ).toEqual(['AXIA15G']);
    expect(result.legs.some((leg) => leg.assetCode === 'AXIA15')).toBe(false);
  });

  it('converts a whole source position on target-only evidence (bidi11-to-inbr32)', () => {
    const definition = ASSET_CONVERSION_DEFINITIONS.find(
      (candidate) => candidate.id === 'bidi11-to-inbr32',
    );
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    // #120: B3 states only the target balance — BIDI11 simply stops, so the
    // group carries no source evidence row and `remaining` is zero. All 150
    // held leave, carrying 150 × 8,00 = 1.200,00 onto the 75 INBR32 the
    // statement declares, and no gain is realised (BR-007-05b).
    const result = expectResolved(
      resolve(
        [definition],
        [evidence('inbr-target', 'INBR32', '0', '75')],
        [source('BIDI11', '150', '8')],
      ),
    );
    expect(result.sources.map((plan) => [plan.assetCode, plan.quantity.toString()])).toEqual([
      ['BIDI11', '150'],
    ]);
    expect(
      result.legs.map((leg) => [
        leg.type,
        leg.assetCode,
        leg.quantity.toString(),
        leg.costBasis?.toString(),
      ]),
    ).toEqual([
      ['conversion_out', 'BIDI11', '150', '1200'],
      ['conversion_in', 'INBR32', '75', '1200'],
    ]);
    expect(result.totalCost.toString()).toBe('1200');
  });

  it('leaves bidi11-to-inbr32 unresolved when the source position is empty', () => {
    const definition = ASSET_CONVERSION_DEFINITIONS.find(
      (candidate) => candidate.id === 'bidi11-to-inbr32',
    );
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    // The owner's real blocker: BIDI11 replays to nothing until its
    // pre-extract opening position and its 2021 Desdobro are in the ledger.
    const result = resolve(
      [definition],
      [evidence('inbr-target', 'INBR32', '0', '75')],
      [source('BIDI11', '0', '8')],
    );
    expect(result.status).toBe('unresolved');
    if (result.status !== 'unresolved') return;
    expect(result.reason).toBe('insufficient_quantity');
  });

  it.each([
    ['wizs3-to-wizc3', 'WIZS3', 'WIZC3'],
    ['trpl4-to-isae4', 'TRPL4', 'ISAE4'],
    ['odpv3-to-saud3', 'ODPV3', 'SAUD3'],
    ['mall11-to-pmll11', 'MALL11', 'PMLL11'],
  ])('converts a ticker rename one-to-one on target-only evidence (%s)', (id, from, to) => {
    const definition = ASSET_CONVERSION_DEFINITIONS.find((candidate) => candidate.id === id);
    expect(definition).toBeDefined();
    if (definition === undefined) return;
    // #143: B3 credits the new code and never debits the old one. The whole
    // 180 held leave at 180 × 9,11 = 1.639,80 and arrive as the 180 the
    // statement adds; the target's own later purchases are not evidence.
    const result = expectResolved(
      resolve([definition], [evidence('rename', to, '0', '180')], [source(from, '180', '9.11')]),
    );
    expect(
      result.legs.map((leg) => [
        leg.type,
        leg.assetCode,
        leg.quantity.toString(),
        leg.costBasis?.toString(),
      ]),
    ).toEqual([
      ['conversion_out', from, '180', '1639.8'],
      ['conversion_in', to, '180', '1639.8'],
    ]);
  });

  it('does not match a rename to the wrong source code (#143)', () => {
    // WIZC3 evidence against a TRPL4 holding: no definition names that pair.
    const result = resolve(
      ASSET_CONVERSION_DEFINITIONS,
      [evidence('rename', 'WIZC3', '0', '180')],
      [source('TRPL4', '180', '9.11')],
    );
    expect(result).toEqual({ status: 'unresolved', reason: 'incomplete' });
  });

  it('keeps missing-weight, incomplete and ambiguous groups unresolved', () => {
    const noWeights: AssetConversionDefinition = {
      id: 'klbn-unpublished',
      sourceAssetCodes: ['KLBN11'],
      targets: [
        { assetCode: 'KLBN3', allocationWeight: null },
        { assetCode: 'KLBN4', allocationWeight: null },
      ],
    };
    expect(
      resolve(
        [noWeights],
        [evidence('k3', 'KLBN3', '0', '10'), evidence('k4', 'KLBN4', '0', '20')],
        [source('KLBN11', '10', '20')],
      ),
    ).toEqual({ status: 'unresolved', reason: 'missing_allocation_weights' });
    expect(resolve([oneToOne], [evidence('unknown', 'OTHER3', '0', '1')], [])).toEqual({
      status: 'unresolved',
      reason: 'incomplete',
    });
    expect(
      resolve(
        [oneToOne, { ...oneToOne, id: 'also-matches' }],
        [evidence('target', 'NEW3', '0', '5')],
        [source('OLD3', '5', '10')],
      ),
    ).toEqual({ status: 'unresolved', reason: 'ambiguous' });
  });

  /**
   * #129 D3 — a **zero** allocation weight says B3 put shares on this target
   * and attributed no value to them: the same reading a bonificação takes of a
   * quantity B3 states without a price (SPEC-007 BR-007-05).
   */
  describe('#129 BR-005-20c — a zero allocation weight', () => {
    const weighted = (...weights: readonly (string | null)[]): AssetConversionDefinition => ({
      id: 'old3-to-many',
      sourceAssetCodes: ['OLD3'],
      targets: weights.map((weight, index) => ({
        assetCode: `T${index}`,
        allocationWeight: weight === null ? null : Quantity.fromString(weight),
      })),
    });
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => evidence(`t${index}`, `T${index}`, '0', '10'));

    it('carries no cost, leaving the whole basis on the positive-weight target', () => {
      const result = expectResolved(
        resolve([weighted('1', '0')], rows(2), [source('OLD3', '10', '13.4725')]),
      );
      expect(
        result.legs
          .filter((leg) => leg.type === 'conversion_in')
          .map((leg) => [leg.assetCode, leg.costBasis?.toString()]),
      ).toEqual([
        ['T0', '134.725'],
        ['T1', '0'],
      ]);
    });

    it('keeps the residual on the last positive-weight target, not simply the last', () => {
      // 100,00 over three equal weights is 33,33333333 twice and a residual of
      // 33,33333334. A zero-weight target in final position must not absorb it.
      const result = expectResolved(
        resolve([weighted('1', '1', '1', '0')], rows(4), [source('OLD3', '1', '100')]),
      );
      const incoming = result.legs.filter((leg) => leg.type === 'conversion_in');
      expect(incoming.map((leg) => leg.costBasis?.toString())).toEqual([
        '33.33333333',
        '33.33333333',
        '33.33333334',
        '0',
      ]);
      expect(
        sumMoney(incoming.flatMap((leg) => (leg.costBasis === null ? [] : [leg.costBasis]))),
      ).toEqual(Money.fromString('100'));
    });

    it('still refuses an all-zero split, a negative weight and a missing one', () => {
      for (const definition of [weighted('0', '0'), weighted('1', '-1'), weighted('1', null)]) {
        expect(resolve([definition], rows(2), [source('OLD3', '10', '20')])).toEqual({
          status: 'unresolved',
          reason: 'missing_allocation_weights',
        });
      }
    });
  });

  it('keeps insufficient, missing-cost and negative-cost groups unresolved', () => {
    const target = [evidence('target', 'NEW3', '0', '5')];
    expect(resolve([oneToOne], target, [source('OLD3', '0', '10')])).toEqual({
      status: 'unresolved',
      reason: 'insufficient_quantity',
    });
    expect(resolve([oneToOne], target, [source('OLD3', '5', null)])).toEqual({
      status: 'unresolved',
      reason: 'missing_cost',
    });
    expect(resolve([oneToOne], target, [source('OLD3', '5', '-1')])).toEqual({
      status: 'unresolved',
      reason: 'negative_cost',
    });
  });

  it('requires all target evidence inside the configured window', () => {
    const twoTargets: AssetConversionDefinition = {
      id: 'windowed',
      sourceAssetCodes: ['OLD3'],
      targets: [
        { assetCode: 'A3', allocationWeight: Quantity.fromString('1') },
        { assetCode: 'B3', allocationWeight: Quantity.fromString('1') },
      ],
    };
    expect(
      resolve(
        [twoTargets],
        [
          evidence('a', 'A3', '0', '1', 'atualizacao', '2026-04-01'),
          evidence('b', 'B3', '0', '1', 'atualizacao', '2026-04-10'),
        ],
        [source('OLD3', '2', '10')],
        7,
      ),
    ).toEqual({ status: 'unresolved', reason: 'outside_window' });
  });

  it('leaves a lone undefined Atualização or Incorporação incomplete', () => {
    expect(
      resolve([oneToOne], [evidence('unknown', 'OTHER3', '0', '5')], [source('OLD3', '5', '10')]),
    ).toEqual({
      status: 'unresolved',
      reason: 'incomplete',
    });
    expect(
      resolve(
        [oneToOne],
        [evidence('inhf', 'INHF12', '0', '10', 'incorporacao')],
        [source('OLD3', '5', '10')],
      ),
    ).toEqual({ status: 'unresolved', reason: 'incomplete' });
  });

  /**
   * #143 — the RVBI11 → PSEC11 rename, and the source-restatement reading it
   * opts into, on generated figures (DV-24): the shape of B3's record, never
   * the owner's costs. BPFF11/HGFF11 → RVBI11 is a liquidation since v8 (#143
   * D10, `asset-liquidation-resolution.ts`), not a conversion.
   */
  describe('#143 BR-005-20c — a conversion carries no cash, and the rename to PSEC11', () => {
    /** A one-to-one definition that opts in to source restatements, as the rename does. */
    const restating: AssetConversionDefinition = { ...oneToOne, sourceBalanceRestatements: true };
    const rename = ASSET_CONVERSION_DEFINITIONS.find(
      (candidate) => candidate.id === 'rvbi11-to-psec11',
    ) as AssetConversionDefinition;

    const legsOf = (result: ResolvedAssetConversion) =>
      result.legs.map((leg) => [
        leg.type,
        leg.assetCode,
        leg.quantity.toString(),
        leg.costBasis?.toString(),
        leg.totalValue.toString(),
        leg.evidenceId,
      ]);

    it('SPEC-007 BR-007-05b — every leg carries zero cash and Σ in cost = Σ out cost', () => {
      /**
       * OLD3 10 at 10,00 = 100,00; B3 states 4 remaining after a Resgate, so
       * 6 leave at 100,00 × 6 ÷ 10 = 60,00, and NEW3's 6 arrive at 60,00.
       * No cash on either leg: out 60,00 = in 60,00 exactly.
       */
      const result = expectResolved(
        resolve(
          [oneToOne],
          [evidence('out', 'OLD3', '10', '4', 'resgate'), evidence('in', 'NEW3', '0', '6')],
          [source('OLD3', '10', '10')],
        ),
      );
      expect(result.totalCost.toString()).toBe('60');
      expect(legsOf(result)).toEqual([
        ['conversion_out', 'OLD3', '6', '60', '0', 'out'],
        ['conversion_in', 'NEW3', '6', '60', '0', 'in'],
      ]);
      expect(result.sources).toEqual([
        {
          assetCode: 'OLD3',
          quantity: Quantity.fromString('6'),
          removedCost: Money.fromString('60'),
        },
      ]);
      const out = sumMoney(
        result.legs
          .filter((l) => l.type === 'conversion_out')
          .map((l) => l.costBasis ?? Money.zero()),
      );
      const carried = sumMoney(
        result.legs
          .filter((l) => l.type === 'conversion_in')
          .map((l) => l.costBasis ?? Money.zero()),
      );
      expect(out.equals(carried)).toBe(true);
    });

    it('refuses two same-day target Atualizações as two readings of one balance', () => {
      // B3 stating NEW3 at 4 and at 6 on one date is ambiguous: only
      // Transferência credits are deltas that sum (#121). The #149 exception
      // for repeated Atualização credits went with the cash component; a
      // liquidation reads its own credits (#143 D10).
      expect(
        resolve(
          [restating],
          [evidence('n1', 'NEW3', '0', '4'), evidence('n2', 'NEW3', '0', '6')],
          [source('OLD3', '10', '10')],
        ),
      ).toEqual({ status: 'unresolved', reason: 'ambiguous' });
    });

    it('sets aside a source Atualização that restates an unchanged balance', () => {
      // OLD3 100 → 100 on the credit's date: read as "what remains", it would
      // leave nothing removed. Set aside, the whole 100 at 10,00 = 1.000,00
      // converts on the target-only evidence.
      const restated = evidence('old-atualizacao', 'OLD3', '100', '100');
      expect(corroboratesSourceBalance(restated, [restating])).toBe(true);
      const result = expectResolved(
        resolve(
          [restating],
          [restated, evidence('new', 'NEW3', '0', '100')],
          [source('OLD3', '100', '10')],
        ),
      );
      // The same group as without it — the statement is not a leg.
      expect(legsOf(result)).toEqual([
        ['conversion_out', 'OLD3', '100', '1000', '0', null],
        ['conversion_in', 'NEW3', '100', '1000', '0', 'new'],
      ]);
    });

    it('keeps an unchanged source statement as evidence for a definition that does not opt in (review F3)', () => {
      // OLD3 holds 100 and B3 states 100 remaining: without the opt-in that
      // still says nothing converted, so the group refuses instead of guessing.
      const restatement = evidence('old-atualizacao', 'OLD3', '100', '100');
      expect(corroboratesSourceBalance(restatement, [oneToOne])).toBe(false);
      expect(
        resolve(
          [oneToOne],
          [restatement, evidence('new', 'NEW3', '0', '20')],
          [source('OLD3', '100', '10')],
        ),
      ).toEqual({ status: 'unresolved', reason: 'insufficient_quantity' });
    });

    it('still reads a changed source statement, and a target statement, as before', () => {
      // 90 → 30 is a statement of what remains: evidence, not corroboration.
      expect(corroboratesSourceBalance(evidence('x', 'OLD3', '90', '30'), [restating])).toBe(false);
      // An unchanged balance on a code no definition sources is not set aside.
      expect(corroboratesSourceBalance(evidence('x', 'NEW3', '5', '5'), [restating])).toBe(false);
      // Nor is an unchanged Resgate-shaped row.
      expect(
        corroboratesSourceBalance(evidence('x', 'OLD3', '90', '90', 'resgate'), [restating]),
      ).toBe(false);
      // A lone restated source with target-only evidence: the whole position converts.
      const result = expectResolved(
        resolve(
          [rename],
          [
            evidence(
              'rvbi11-atualizacao',
              'RVBI11',
              '159.25',
              '159.25',
              'atualizacao',
              '2025-10-17',
            ),
            evidence('psec11', 'PSEC11', '0', '159', 'atualizacao', '2025-10-27'),
          ],
          [
            {
              assetCode: 'RVBI11',
              quantity: Quantity.fromString('159'),
              totalCost: Money.fromString('15900'),
            },
          ],
          45,
        ),
      );
      expect(result.legs.map((leg) => leg.evidenceId)).toEqual([null, 'psec11']);
    });

    it('converts RVBI11 to PSEC11 one-to-one on target-only evidence', () => {
      // After the 0,25 fraction settles RVBI11 holds 159 at 15.900,00 (avg 100,00).
      const result = expectResolved(
        resolve(
          [rename],
          [evidence('psec11', 'PSEC11', '0', '159', 'atualizacao', '2025-10-27')],
          [
            {
              assetCode: 'RVBI11',
              quantity: Quantity.fromString('159'),
              totalCost: Money.fromString('15900'),
            },
          ],
        ),
      );
      expect(legsOf(result)).toEqual([
        ['conversion_out', 'RVBI11', '159', '15900', '0', null],
        ['conversion_in', 'PSEC11', '159', '15900', '0', 'psec11'],
      ]);
      expect(result.legs[0]?.tradeDate).toBe('2025-10-27');
    });

    it('refuses when only corroborating statements are left', () => {
      expect(
        resolve(
          [rename],
          [evidence('rvbi11-atualizacao', 'RVBI11', '159', '159')],
          [
            {
              assetCode: 'RVBI11',
              quantity: Quantity.fromString('159'),
              totalCost: Money.fromString('15900'),
            },
          ],
        ),
      ).toEqual({ status: 'unresolved', reason: 'incomplete' });
    });
  });
});
