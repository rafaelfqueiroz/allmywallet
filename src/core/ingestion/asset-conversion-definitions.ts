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
 * **v6 (#143)** — four plain ticker renames B3 records only as an
 * `Atualização` on the new code: `wizs3-to-wizc3`, `trpl4-to-isae4`,
 * `odpv3-to-saud3` and `mall11-to-pmll11`. Purely additive.
 *
 * **v7 (#143)** — the BPFF11/HGFF11 → RVBI11 → PSEC11 chain, as two
 * definitions. `bpff11-and-hgff11-to-rvbi11` is the first definition with a
 * **cash component**: B3 records each source's cash as a priced FII
 * `Resgate`, which the definition names explicitly
 * (`pricedRedemptionSourceCodes`) — never a change to the movement map, where
 * every other priced `Resgate` stays v3's sell — and its target receives two
 * same-day `Atualização` credits on the receipt code RVBI15
 * (`repeatedTargetCredits`). `rvbi11-to-psec11` is the rename that follows.
 * Purely additive: no earlier definition gains a field, so no stored group's
 * evidence can complete a wider group than it was written under.
 *
 * The version is part of every `groupKey` (`asset-conversion-resolution.ts`),
 * so a group already written under an older key keeps it: `commit-batch.ts`
 * never re-resolves evidence whose stored transaction is already an active
 * conversion leg, so a re-import is still a no-op rather than a second group
 * under a newer key.
 */
export const ASSET_CONVERSION_DEFINITIONS_VERSION = 7;

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
  /**
   * #143 — source codes whose **priced** `Resgate` is this conversion's
   * outgoing evidence, carrying the cash B3 paid alongside it. The cash is a
   * return of capital (SPEC-007 BR-007-05b): the row becomes the source's
   * `conversion_out` in place, keeps its price, fees and total, and the
   * targets receive the removed cost less that cash.
   *
   * Explicit and per definition because the movement map reads every other
   * priced FII `Resgate` as a sale (BR-005-18 v3), and must go on doing so: a
   * global rule would turn an ordinary fund redemption into a conversion.
   */
  readonly pricedRedemptionSourceCodes?: readonly string[] | undefined;
  /**
   * #143 — the target's same-day `Atualização` rows are **separate credits**,
   * each measured against the balance before that day and summed, rather than
   * two restatements of one balance (which is ambiguous and refuses). B3
   * credits a receipt code once per incorporated fund, on one date, with
   * nothing in either row to say which fund it came from.
   */
  readonly repeatedTargetCredits?: boolean | undefined;
  /**
   * #143 — a source `Atualização` restating exactly the balance the replay
   * already holds is **corroboration**, set aside rather than read as what
   * remains (`corroboratesSourceBalance`). Per definition, not global: for any
   * other definition an unchanged statement still means nothing converted and
   * the group refuses — an ordinary same-day buy excluded from the replay
   * before the statement would otherwise let a guess through (BR-005-20c).
   */
  readonly sourceBalanceRestatements?: boolean | undefined;
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
  // #143: ticker renames, each one-to-one. B3 states a price-less `Atualização`
  // credit on the new code and never debits the old one, so the old position
  // stays open and the new one reads short by exactly that credit. Each is the
  // `bidi11-to-inbr32` shape: target-only evidence, the whole source position
  // converts. Dates are B3's first trading day under the new code.
  //
  // - WIZS3 → WIZC3, Wiz Co, 2023-02-09.
  // - TRPL4 → ISAE4, ISA Energia Brasil (ex-ISA CTEEP), 2024-11-18. TRPL3 →
  //   ISAE3 is the same event and is left out until a position needs it.
  // - ODPV3 → SAUD3, Bradsaúde (ex-Odontoprev), 2026-05-05.
  // - MALL11 → PMLL11, Pátria Malls (ex-Genial Malls), 2025-07-22.
  oneTarget('wizs3-to-wizc3', ['WIZS3'], 'WIZC3'),
  oneTarget('trpl4-to-isae4', ['TRPL4'], 'ISAE4'),
  oneTarget('odpv3-to-saud3', ['ODPV3'], 'SAUD3'),
  oneTarget('mall11-to-pmll11', ['MALL11'], 'PMLL11'),
  // #143 (v7): the incorporation of BPFF11 and HGFF11 into RVBI11, 2025-10.
  // B3 records it at one institution as:
  //
  // - each source's balance restated unchanged by an `Atualização` on
  //   2025-10-06 — corroboration, not conversion evidence (see
  //   `commit-batch.ts`), since nothing has left yet;
  // - a **priced** `Resgate` of the whole source a week later (90 @ 2,239 and
  //   70 @ 1,983 on the owner's extract) — the cash half of the exchange,
  //   which BR-005-18 v3 alone would read as a sale realising a loss on the
  //   whole cost;
  // - two same-day `Atualização` credits on the receipt code RVBI15
  //   (90 × 0,9321 = 83,89 and 70 × 1,0766 = 75,36, the ratios of the
  //   incorporation's fato relevante), with nothing in either row naming its
  //   fund. So the definition has **both** sources and **one** target, and
  //   the two credits share the one target allocation by quantity.
  //
  // The owner's reading: the cash is a **return of capital** — the sources
  // close with no gain or loss, and RVBI11 takes the removed cost less the
  // cash. Its receipt code RVBI15 is B3's evidence code only; the ledger
  // position is RVBI11 from the start, as AXIA15 → AXIA15G.
  {
    id: 'bpff11-and-hgff11-to-rvbi11',
    sourceAssetCodes: ['BPFF11', 'HGFF11'],
    targets: [{ assetCode: 'RVBI11', evidenceAssetCode: 'RVBI15', allocationWeight: null }],
    pricedRedemptionSourceCodes: ['BPFF11', 'HGFF11'],
    repeatedTargetCredits: true,
    sourceBalanceRestatements: true,
  },
  // #143 (v7): RVBI11 → PSEC11, the ticker change of 2025-10-27, 1:1 and
  // target-only like the v6 renames. It must follow the definition above: the
  // planner walks this table in order, so RVBI11's incoming legs are already
  // in its replay when this group measures it. RVBI11's own `Atualização` of
  // 2025-10-17 restates 159,25 unchanged and is dropped as corroboration;
  // measured after its 0,25 `Fração em Ativos` settles (#128 D2), RVBI11
  // holds 159, all of which converts.
  { ...oneTarget('rvbi11-to-psec11', ['RVBI11'], 'PSEC11'), sourceBalanceRestatements: true },
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
