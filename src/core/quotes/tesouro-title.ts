import type { BusinessDate } from '@/core/shared/clock';

/**
 * #152 — the one code a Tesouro Direto title is catalogued under.
 *
 * B3 names a title by product and **year** (`Tesouro Selic 2029`), in both
 * Posição and Movimentação, and that is the code the ledger's asset carries.
 * Tesouro Transparente names it by product and **maturity date**
 * (`Tesouro Selic` / `01/03/2029`). `tesouro.sync` used to catalogue its price
 * under `Tesouro Selic 01/03/2029`, an asset of its own that nothing linked to
 * the held one, so every held title was valued at cost.
 *
 * **The canonical identity is B3's name**, and the sync is what translates:
 * the maturity date is the only fact both sources carry, and B3's year is its
 * year. The ledger, the refusal screen, reconciliation and every report
 * already name the title B3's way, so moving the price series onto that asset
 * touches market data only — never a tenant row.
 *
 * **Only products whose name year is their maturity year** are translated,
 * each listed by hand. Checked against Tesouro Transparente's whole published
 * history on 2026-09-27: every Selic, Prefixado, IPCA+ and IGPM+ title issued
 * since 2014 matures in the year its name says. `Tesouro Educa+` and
 * `Tesouro Renda+ Aposentadoria Extra` are named for the year payments
 * *start*, which is not the maturity (`Educa+` maturing 15/12/2030 is the
 * 2026 title), and no B3 extract has shown how B3 names either — so they are
 * left under their full date rather than guessed. A product this list does not
 * name stays unpriced visibly (DL-009-05's cost floor, flagged) instead of
 * being priced from a different title.
 *
 * Pure and total (AR-01).
 */
export const YEAR_NAMED_TESOURO_PRODUCTS: readonly string[] = [
  'Tesouro Selic',
  'Tesouro Prefixado',
  'Tesouro Prefixado com Juros Semestrais',
  'Tesouro IPCA+',
  'Tesouro IPCA+ com Juros Semestrais',
  'Tesouro IGPM+ com Juros Semestrais',
];

const YEAR_NAMED = new Set(YEAR_NAMED_TESOURO_PRODUCTS);

export interface TesouroTitle {
  /** Tesouro Transparente's `Tipo Titulo`, as published — `Tesouro IPCA+`. */
  readonly product: string;
  /** Tesouro Transparente's `Data Vencimento`. */
  readonly maturity: BusinessDate;
}

/** `2029-03-01` → `01/03/2029`, the form Tesouro Transparente publishes. */
function brDate(date: BusinessDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * The code B3 gives the title, or `null` where this module cannot say it
 * without guessing — a product not on the list above.
 */
export function b3TesouroCode(title: TesouroTitle): string | null {
  const product = title.product.trim();
  if (!YEAR_NAMED.has(product)) return null;
  return `${product} ${title.maturity.slice(0, 4)}`;
}

/** The full-date code a title keeps when it has no B3 name — `Tesouro Educa+ 15/12/2030`. */
export function fullTesouroCode(title: TesouroTitle): string {
  return `${title.product.trim()} ${brDate(title.maturity)}`;
}

/**
 * The catalogue code for each title in one published batch, in order.
 *
 * B3's name where one exists **and no other title in the batch shares it**.
 * Two maturities of one product in one year did happen before 2014 (the
 * quarterly Prefixados of 2005–2011), and pricing one B3 name from whichever
 * of two titles came last would be a wrong price with nothing to say so. Both
 * keep their full-date codes instead, and the held title reads unpriced.
 */
export function tesouroCatalogCodes(titles: readonly TesouroTitle[]): readonly string[] {
  const b3Codes = titles.map(b3TesouroCode);
  // Distinct maturities, not rows: a title repeated in the file is still one title.
  const maturities = new Map<string, Set<BusinessDate>>();
  titles.forEach((title, index) => {
    const code = b3Codes[index];
    if (code === null || code === undefined) return;
    const known = maturities.get(code) ?? new Set<BusinessDate>();
    known.add(title.maturity);
    maturities.set(code, known);
  });
  return titles.map((title, index) => {
    const code = b3Codes[index] ?? null;
    return code !== null && maturities.get(code)?.size === 1 ? code : fullTesouroCode(title);
  });
}
