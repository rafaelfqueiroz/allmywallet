import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import {
  ASSET_CONVERSION_DEFINITIONS,
  ASSET_CONVERSION_DEFINITIONS_VERSION,
  ASSET_LIQUIDATION_DEFINITIONS,
} from '@/core/ingestion/asset-conversion-definitions';

describe('SPEC-005 BR-005-20c — public-code conversion definitions', () => {
  it('is explicitly versioned and contains no dates, quantities or personal data', () => {
    // #128 D3: v2 replaced `axia7-and-axia13-to-axia15g` with a definition
    // sourced from AXIA7 alone. #129 D2: v3 did the same for CPLE3, which is
    // sourced from CPLE6 — the only CPLE code that ever holds a position.
    // #129 D3: v4 added CPLE7 to it as a zero-cost target. #120: v5 added
    // `bidi11-to-inbr32`, purely additive — no existing definition changed.
    // #143: v6 added four one-to-one ticker renames, likewise additive; v7 the
    // BPFF11/HGFF11 → RVBI11 cash-bearing incorporation and RVBI11 → PSEC11,
    // additive too. #143 D10: v8 removed the incorporation — it is a
    // liquidation, in its own table below — and kept the rename. Removing the
    // cash-bearing fields it alone used changed no definition, so no bump.
    expect(ASSET_CONVERSION_DEFINITIONS_VERSION).toBe(8);
    expect(
      ASSET_CONVERSION_DEFINITIONS.map((definition) => ({
        id: definition.id,
        sources: definition.sourceAssetCodes,
        targets: definition.targets.map((target) => ({
          evidence: target.evidenceAssetCode ?? target.assetCode,
          ledger: target.assetCode,
        })),
      })),
    ).toEqual([
      {
        id: 'elet3-to-axia3',
        sources: ['ELET3'],
        targets: [{ evidence: 'AXIA3', ledger: 'AXIA3' }],
      },
      {
        id: 'cple6-to-cple3-and-cple7',
        sources: ['CPLE6'],
        targets: [
          { evidence: 'CPLE3', ledger: 'CPLE3' },
          { evidence: 'CPLE7', ledger: 'CPLE7' },
        ],
      },
      {
        id: 'axia7-to-axia13',
        sources: ['AXIA7'],
        targets: [{ evidence: 'AXIA13', ledger: 'AXIA13' }],
      },
      {
        id: 'axia7-to-axia15g',
        sources: ['AXIA7'],
        targets: [{ evidence: 'AXIA15', ledger: 'AXIA15G' }],
      },
      {
        id: 'bidi11-to-inbr32',
        sources: ['BIDI11'],
        targets: [{ evidence: 'INBR32', ledger: 'INBR32' }],
      },
      {
        id: 'wizs3-to-wizc3',
        sources: ['WIZS3'],
        targets: [{ evidence: 'WIZC3', ledger: 'WIZC3' }],
      },
      {
        id: 'trpl4-to-isae4',
        sources: ['TRPL4'],
        targets: [{ evidence: 'ISAE4', ledger: 'ISAE4' }],
      },
      {
        id: 'odpv3-to-saud3',
        sources: ['ODPV3'],
        targets: [{ evidence: 'SAUD3', ledger: 'SAUD3' }],
      },
      {
        id: 'mall11-to-pmll11',
        sources: ['MALL11'],
        targets: [{ evidence: 'PMLL11', ledger: 'PMLL11' }],
      },
      {
        id: 'rvbi11-to-psec11',
        sources: ['RVBI11'],
        targets: [{ evidence: 'PSEC11', ledger: 'PSEC11' }],
      },
      {
        id: 'klbn11-to-klbn3-and-klbn4',
        sources: ['KLBN11'],
        targets: [
          { evidence: 'KLBN3', ledger: 'KLBN3' },
          { evidence: 'KLBN4', ledger: 'KLBN4' },
        ],
      },
    ]);
  });

  it('#143 — only the rename to PSEC11 reads a source restatement', () => {
    // A conversion carries no cash (BR-007-05b): #149's cash-bearing fields are
    // gone with the one definition that used them, and the opt-in that
    // remains belongs to `rvbi11-to-psec11` alone.
    expect(
      ASSET_CONVERSION_DEFINITIONS.filter(
        (definition) => definition.sourceBalanceRestatements !== undefined,
      ).map((definition) => definition.id),
    ).toEqual(['rvbi11-to-psec11']);
  });

  it("#143 D10 — the liquidation table carries only the administrator's public per-share figures", () => {
    expect(
      ASSET_LIQUIDATION_DEFINITIONS.map((definition) => ({
        id: definition.id,
        sources: definition.sources.map((source) => [
          source.assetCode,
          source.liquidationValue.toString(),
        ]),
        target: [
          definition.target.evidenceAssetCode,
          definition.target.assetCode,
          definition.target.unitCost.toString(),
        ],
      })),
    ).toEqual([
      {
        id: 'bpff11-and-hgff11-liquidated-into-rvbi11',
        // Fatos relevantes of 02/10/2025: 59,79675590 in RVBI + 2,23862655 in
        // cash = 62,03538245; 69,06381092 + 1,98289016 = 71,04670108.
        sources: [
          ['BPFF11', '62.03538245'],
          ['HGFF11', '71.04670108'],
        ],
        target: ['RVBI15', 'RVBI11', '64.15'],
      },
    ]);
    // Each published total is exactly its in-kind part plus its cash part, by
    // hand: 59,79675590 + 2,23862655 = 62,03538245; 69,06381092 + 1,98289016
    // = 71,04670108.
    const parts: Record<string, readonly [string, string]> = {
      BPFF11: ['59.79675590', '2.23862655'],
      HGFF11: ['69.06381092', '1.98289016'],
    };
    for (const source of ASSET_LIQUIDATION_DEFINITIONS[0]?.sources ?? []) {
      const [inKind, cash] = parts[source.assetCode] as readonly [string, string];
      expect(
        Money.fromString(inKind).plus(Money.fromString(cash)).equals(source.liquidationValue),
        source.assetCode,
      ).toBe(true);
    }
  });
});
