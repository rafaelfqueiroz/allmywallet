/**
 * SPEC-008 BR-008-29 / SPEC-005 BR-005-20b (#113) — the B3 **issuer code** a
 * ticker belongs to.
 *
 * B3 publishes share-ratio factors per issuing company (`MGLU`, `KLBN`), not
 * per ticker, and with no class: a ticker is the issuer's four characters
 * followed by a one- or two-digit class code (`3` ON, `4` PN, `11` unit,
 * `34` BDR…). So every class of one issuer maps to the same code, and the
 * factor lookup cannot tell MGLU3's event from a hypothetical MGLU4's — which
 * is why a factor only ever *confirms* a ratio derived from the position
 * (SPEC-007 BR-007-04a), never supplies one.
 *
 * - `MGLU3` → `MGLU`; `KLBN11` → `KLBN`; `KLBN4` → `KLBN`; `B3SA3` → `B3SA`.
 * - `MGLU3F` → `MGLU`: the `F` is the fractional market (*mercado
 *   fracionário*), the same shares on another order book — Negociação states
 *   it that way (`adapters/ingestion/xlsx/negociacao.ts`).
 * - **`AXIA15G` → `null`.** A trailing letter other than `F` is not a lot
 *   market this code knows; guessing `AXIA` would look up factors for a code
 *   whose meaning is unconfirmed (#121 tracks the AXIA conversions). `null`
 *   refuses the event as `no_factor`, which leaves the row for a human rather
 *   than applying a ratio on a guess.
 * - Tesouro Direto titles (`Tesouro IPCA+ 2029`) and bank paper
 *   (`CDB6269CPH4`, `CDB - BANCO EXEMPLO S/A`) → `null`: they have no issuer
 *   on B3's listed-companies data and no share-ratio events.
 *
 * Pure and total; case and surrounding whitespace are ignored.
 */
const TICKER = /^([A-Z][A-Z0-9]{3})\d{1,2}F?$/;

export function issuerCodeOf(ticker: string): string | null {
  return TICKER.exec(ticker.trim().toUpperCase())?.[1] ?? null;
}
