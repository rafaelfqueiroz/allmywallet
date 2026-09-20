/**
 * SPEC-005 BR-005-14 (#135) — the explicit, reviewable **asset code** alias
 * table: the codes B3 writes for one instrument, and which of them the ledger
 * keeps.
 *
 * B3 settled the July 2023 Energias do Brasil buyout on `ENBR3L`, its auction
 * ticker for that settlement, and printed the disposal under that code in
 * Negociação. Movimentação never mentions it: both custody legs of the same
 * event are coded `ENBR3`. A position is keyed by `(asset, institution)`
 * (SPEC-007 BR-007-08), so the ledger held `ENBR3L` as an asset of its own
 * with no position behind it, and both sale rows refused
 * `INSUFFICIENT_QUANTITY` for good.
 *
 * **Listed by hand, never inferred.** `ENBR3L` is the listed code with an `L`
 * appended, and a rule reading it that way would silently capture any real
 * ticker ending in `L` — `ALOS3`'s class codes are digits, but B3's code space
 * is not this project's to predict, and a wrong merge joins two instruments'
 * holdings into one position with a plausible average and nothing to say it is
 * wrong. The same bargain `institution-identity.ts` strikes, for the same
 * reason: a code this table does not name creates its own asset, visibly.
 *
 * **Adding an entry here does not repair a ledger that already split.** Rows
 * name an asset by *id*, so an alias added later needs a data migration in the
 * shape of `0025_merge_asset_code_aliases.sql` to move them — a required step
 * of such a change, not an optional one.
 *
 * Deliberately **not** the fractional-market `F` suffix (`PETR4F`), which
 * `adapters/ingestion/xlsx/negociacao.ts` strips: that one names an order
 * book, is mechanical, and holds for every ticker.
 *
 * Pure and total (AR-01).
 */

export interface AssetAlias {
  /** The code the ledger keeps — always the listed ticker B3 trades every other day. */
  readonly canonicalCode: string;
  /** Other codes B3 has written for the same instrument, canonical excluded. */
  readonly codes: readonly string[];
}

/** Codes observed in B3 extracts. Public instrument codes only — no personal data (BR-004-02). */
export const ASSET_ALIASES: readonly AssetAlias[] = [
  {
    // B3's auction ticker for the 2023-07 EDP Energias do Brasil buyout
    // settlement. Negociação prints the disposal under it; Movimentação codes
    // both custody legs of the same event `ENBR3`.
    canonicalCode: 'ENBR3',
    codes: ['ENBR3L'],
  },
];

const CANONICAL_BY_CODE = new Map<string, string>(
  ASSET_ALIASES.flatMap((alias) =>
    alias.codes.map((code) => [normalizeAssetCode(code), alias.canonicalCode] as const),
  ),
);

/** Case and surrounding whitespace only; a code's own characters are never touched. */
function normalizeAssetCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The code an asset is **created and matched** under. An aliased code becomes
 * its canonical one; every other code is returned as it was written, so a
 * `Produto` this table does not know is never reshaped on a guess.
 */
export function canonicalAssetCode(code: string): string {
  return CANONICAL_BY_CODE.get(normalizeAssetCode(code)) ?? code;
}
