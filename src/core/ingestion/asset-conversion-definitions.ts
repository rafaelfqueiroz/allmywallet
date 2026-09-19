import { Quantity } from '@/core/shared/money';

/**
 * SPEC-005 BR-005-20c: the explicit, reviewable conversion-definition table.
 *
 * **v2 (#128 D3)** — `axia7-and-axia13-to-axia15g` became `axia7-to-axia15g`,
 * sourced from AXIA7 alone. The version is part of every `groupKey`
 * (`asset-conversion-resolution.ts`), so a group already written under a v1
 * key keeps it: `commit-batch.ts` never re-resolves evidence whose stored
 * transaction is already an active conversion leg, so a re-import is still a
 * no-op rather than a second group under a v2 key.
 */
export const ASSET_CONVERSION_DEFINITIONS_VERSION = 2;

export interface AssetConversionTargetDefinition {
  /** B3 Movimentação code; omitted when it equals the canonical ledger code. */
  readonly evidenceAssetCode?: string | undefined;
  readonly assetCode: string;
  /** Required for every target when a conversion has more than one target. */
  readonly allocationWeight: Quantity | null;
}

export interface AssetConversionDefinition {
  readonly id: string;
  readonly sourceAssetCodes: readonly string[];
  readonly targets: readonly AssetConversionTargetDefinition[];
}

function oneTarget(
  id: string,
  sourceAssetCodes: readonly string[],
  targetAssetCode: string,
  evidenceAssetCode?: string,
): AssetConversionDefinition {
  return {
    id,
    sourceAssetCodes,
    targets: [
      {
        assetCode: targetAssetCode,
        allocationWeight: null,
        ...(evidenceAssetCode === undefined ? {} : { evidenceAssetCode }),
      },
    ],
  };
}

/**
 * Public-code relationships observed in B3 custody history. Definitions carry
 * no personal date, quantity or cost; those come only from a user's replay.
 */
export const ASSET_CONVERSION_DEFINITIONS: readonly AssetConversionDefinition[] = [
  oneTarget('elet3-to-axia3', ['ELET3'], 'AXIA3'),
  oneTarget('cple7-to-cple3', ['CPLE7'], 'CPLE3'),
  oneTarget('axia7-to-axia13', ['AXIA7'], 'AXIA13'),
  // #128 D3: sourced from AXIA7 **alone**. B3's own arithmetic is one-to-one
  // from AXIA7 (64 → 52, with 12 into AXIA15); AXIA13's units were redeemed
  // for cash beforehand (a priced `Resgate`, which map v5 classifies `sell`),
  // so AXIA13 holds nothing on the AXIA15 statement date and a definition
  // sourcing it refused the complete group `insufficient_quantity`.
  oneTarget('axia7-to-axia15g', ['AXIA7'], 'AXIA15G', 'AXIA15'),
  {
    id: 'klbn11-to-klbn3-and-klbn4',
    sourceAssetCodes: ['KLBN11'],
    // One KLBN11 unit contains one KLBN3 and four KLBN4 shares. The explicit
    // weights make the one-to-many cost allocation reviewable (BR-005-20c).
    targets: [
      { assetCode: 'KLBN3', allocationWeight: Quantity.fromString('1') },
      { assetCode: 'KLBN4', allocationWeight: Quantity.fromString('4') },
    ],
  },
];
