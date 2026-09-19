import { describe, expect, it } from 'vitest';
import {
  ASSET_CONVERSION_DEFINITIONS,
  ASSET_CONVERSION_DEFINITIONS_VERSION,
} from '@/core/ingestion/asset-conversion-definitions';

describe('SPEC-005 BR-005-20c — public-code conversion definitions', () => {
  it('is explicitly versioned and contains no dates, quantities or personal data', () => {
    // #128 D3: v2 replaced `axia7-and-axia13-to-axia15g` with a definition
    // sourced from AXIA7 alone.
    expect(ASSET_CONVERSION_DEFINITIONS_VERSION).toBe(2);
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
        id: 'cple7-to-cple3',
        sources: ['CPLE7'],
        targets: [{ evidence: 'CPLE3', ledger: 'CPLE3' }],
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
