import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity, sumMoney } from '@/core/shared/money';
import { ASSET_CONVERSION_DEFINITIONS } from '@/core/ingestion/asset-conversion-definitions';
import type { AssetConversionDefinition } from '@/core/ingestion/asset-conversion-definitions';
import {
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
    expect(first.groupKey.startsWith('conversion:v2:')).toBe(true);
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
});
