import { Quantity } from '@/core/shared/money';

/**
 * SPEC-005 BR-005-20c: the explicit, reviewable conversion-definition table.
 *
 * **v2 (#128 D3)** — `axia7-and-axia13-to-axia15g` became `axia7-to-axia15g`,
 * sourced from AXIA7 alone.
 *
 * **v3 (#129 D2)** — `cple7-to-cple3` became `cple6-to-cple3`, for the same
 * reason: CPLE7 never holds a position.
 *
 * **v4 (#129 D3)** — CPLE7 joined that definition as a **zero-cost** target,
 * so B3's priced redemption of it is recorded as the sale B3 says it is.
 *
 * **v5 (#120)** — `bidi11-to-inbr32`, Banco Inter's 2022 migration to Nasdaq.
 *
 * The version is part of every `groupKey` (`asset-conversion-resolution.ts`),
 * so a group already written under an older key keeps it: `commit-batch.ts`
 * never re-resolves evidence whose stored transaction is already an active
 * conversion leg, so a re-import is still a no-op rather than a second group
 * under a newer key.
 */
export const ASSET_CONVERSION_DEFINITIONS_VERSION = 5;

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
  // #129 D2/D3: sourced from **CPLE6**, the only CPLE code that ever holds a
  // position. A definition sourcing CPLE7 refused the complete group
  // `insufficient_quantity` and CPLE3 stayed at 0; the 175 shares B3 actually
  // converted are the CPLE6 ones, whose position goes to zero on that date.
  //
  // B3 states both target quantities and **no cost split**: an `Atualização`
  // carries no price. CPLE7 is the redeemable class B3 cashes out a week later
  // at a stated 0,775, so it is a target at weight **zero** — the same reading
  // a bonificação takes of a quantity B3 states without a value — and its
  // priced `Resgate` becomes the real sale B3 recorded. A value-weighted split
  // would fill B3's deliberate blank with a market price found nowhere in the
  // extract, and would only move *when* the same total gain is realised.
  {
    id: 'cple6-to-cple3-and-cple7',
    sourceAssetCodes: ['CPLE6'],
    targets: [
      { assetCode: 'CPLE3', allocationWeight: Quantity.fromString('1') },
      { assetCode: 'CPLE7', allocationWeight: Quantity.zero() },
    ],
  },
  oneTarget('axia7-to-axia13', ['AXIA7'], 'AXIA13'),
  // #128 D3: sourced from AXIA7 **alone**. B3's own arithmetic is one-to-one
  // from AXIA7 (64 → 52, with 12 into AXIA15); AXIA13's units were redeemed
  // for cash beforehand (a priced `Resgate`, which map v5 classifies `sell`),
  // so AXIA13 holds nothing on the AXIA15 statement date and a definition
  // sourcing it refused the complete group `insufficient_quantity`.
  oneTarget('axia7-to-axia15g', ['AXIA7'], 'AXIA15G', 'AXIA15'),
  // #120: Banco Inter's 2022 migration to Nasdaq. B3's custody record walks
  // three codes — BIDI11 stops, an `Incorporação` credits INHF12 on the same
  // day an `Atualização` states INBR31, and a second `Atualização` states
  // INBR32 ten weeks later — but **cost passes through none of the
  // intermediates**: the same quantity stands at every step, so one leg pair
  // from BIDI11 to INBR32 reproduces the end state exactly.
  //
  // Modelling the chain instead would need two definitions, and the second
  // cannot resolve: its source evidence would be the INHF12 `Incorporação`,
  // whose statement quantity `resolveAssetConversion` reads as what *remains*,
  // leaving nothing removed. The 70 days from 21/06/2022 to 30/08/2022 also
  // exceed `import.asset_conversion_window_days` (45), so the two rows can
  // never share one group. Anchored on the INBR32 statement alone, this
  // definition's evidence spans a single day and BIDI11 contributes its whole
  // position, which is what B3's record says happened.
  //
  // INHF12 and INBR31 are deliberately left undefined: both state the same
  // quantity on the same day and both end at INBR32, so either routing
  // conserves cost identically, and their rows stay `unclassified` rather
  // than inventing a cost step B3 never priced.
  oneTarget('bidi11-to-inbr32', ['BIDI11'], 'INBR32'),
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
