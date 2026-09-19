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
    // #129 D3: v4 added CPLE7 to it as a zero-cost target.
    expect(ASSET_CONVERSION_DEFINITIONS_VERSION).toBe(4);
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
        id: 'klbn11-to-klbn3-and-klbn4',
        sources: ['KLBN11'],
        targets: [
          { evidence: 'KLBN3', ledger: 'KLBN3' },
          { evidence: 'KLBN4', ledger: 'KLBN4' },
        ],
      },
    ]);
  });
});
