import { describe, expect, it } from 'vitest';
import {
  ASSET_CONVERSION_DEFINITIONS,
  ASSET_CONVERSION_DEFINITIONS_VERSION,
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
    // additive too, in that order (the rename measures RVBI11 after its arrival).
    expect(ASSET_CONVERSION_DEFINITIONS_VERSION).toBe(7);
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
        id: 'bpff11-and-hgff11-to-rvbi11',
        sources: ['BPFF11', 'HGFF11'],
        targets: [{ evidence: 'RVBI15', ledger: 'RVBI11' }],
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

  it('#143 — names priced redemptions and repeated target credits on one definition only', () => {
    const flagged = ASSET_CONVERSION_DEFINITIONS.filter(
      (definition) =>
        definition.pricedRedemptionSourceCodes !== undefined ||
        definition.repeatedTargetCredits !== undefined,
    );
    expect(
      flagged.map((definition) => ({
        id: definition.id,
        priced: definition.pricedRedemptionSourceCodes,
        repeated: definition.repeatedTargetCredits,
      })),
    ).toEqual([
      {
        id: 'bpff11-and-hgff11-to-rvbi11',
        priced: ['BPFF11', 'HGFF11'],
        repeated: true,
      },
    ]);
    // The rename is read after the incorporation that creates its source.
    const ids = ASSET_CONVERSION_DEFINITIONS.map((definition) => definition.id);
    expect(ids.indexOf('bpff11-and-hgff11-to-rvbi11')).toBeLessThan(
      ids.indexOf('rvbi11-to-psec11'),
    );
  });
});
