import type { BusinessDate } from '@/core/shared/clock';

/**
 * #152/#164 — the one code a Tesouro Direto title is catalogued under.
 *
 * B3 names a title by product and **year** (`Tesouro Selic 2029`), in both
 * Posição and Movimentação, and that is the code the ledger's asset carries.
 * Tesouro Transparente names it by product and **maturity date**
 * (`Tesouro Selic` / `01/03/2029`). `tesouro.sync` used to catalogue its price
 * under `Tesouro Selic 01/03/2029`, an asset of its own that nothing linked to
 * the held one, so every held title was valued at cost.
 *
 * **The canonical identity is B3's name**, and both sides resolve to it:
 *
 *  - the sync translates a published product and maturity date
 *    (`b3TesouroCode`, `tesouroCatalogCodes`);
 *  - the importer reads B3's `Produto` (`canonicalTesouroCode`), so whichever
 *    way B3 spells a product it meets the asset the sync prices.
 *
 * **Each product is listed by hand**, with the relation between its name year
 * and its maturity. For Selic, Prefixado, IPCA+ and IGPM+ the name year *is*
 * the maturity year — checked against Tesouro Transparente's whole published
 * history on 2026-09-27: true of every title since 2014. Educa+ and Renda+ are
 * named for the year payments **start** (#164), a fixed product structure:
 *
 *  - `Tesouro Educa+ YYYY` pays 60 monthly instalments from January YYYY and
 *    matures on 15/12/(YYYY+4);
 *  - `Tesouro Renda+ Aposentadoria Extra YYYY` pays 240 from January YYYY and
 *    matures on 15/12/(YYYY+19).
 *
 * Their maturity must fall on 15 December for the rule to apply, so a title
 * that does not fit the structure is never renamed onto one that does.
 *
 * **Reading a name** is by its words, not its exact spelling: case, accents
 * and whitespace are ignored, and a product is recognised by exactly one
 * indexer word (`selic`, `prefixado`, `ipca+`, `igpm+`, `educa+`, `renda+`),
 * the coupon stated as `juros semestrais` (with `com` or `c/`) or `js`, and
 * the words its own name carries (`aposentadoria extra`). **Any other word
 * means no match**: a product this table does not know keeps its own code and
 * stays unpriced visibly (DL-009-05's cost floor, flagged) instead of being
 * priced from a title it merely resembles. No B3 extract holding an Educa+ or
 * a Renda+ has been seen, which is why their spelling is read this way rather
 * than matched exactly.
 *
 * Pure and total (AR-01).
 */
interface TesouroProduct {
  /** The catalogue's spelling of the product. */
  readonly name: string;
  readonly indexer: string;
  /** Pays semi-annual coupons — `com Juros Semestrais`. */
  readonly coupon: boolean;
  /** Maturity year minus the year in the product's name. */
  readonly nameYearOffset: number;
  /** `MM-DD` every maturity falls on, where the offset depends on it; `null` for any date. */
  readonly maturityMonthDay: string | null;
  /**
   * SPEC-007 BR-007-05c — the monthly payments an NTN-B1 title makes from
   * 15 January of the year in its name, the last one on its maturity;
   * `null` for every product that does not pay in instalments.
   */
  readonly monthlyPayments: number | null;
  /** Words of the name beyond `tesouro`, the indexer and the coupon words. */
  readonly nameWords: readonly string[];
}

export const TESOURO_PRODUCTS: readonly TesouroProduct[] = [
  product('Tesouro Selic', 'selic', false),
  product('Tesouro Prefixado', 'prefixado', false),
  product('Tesouro Prefixado com Juros Semestrais', 'prefixado', true),
  product('Tesouro IPCA+', 'ipca+', false),
  product('Tesouro IPCA+ com Juros Semestrais', 'ipca+', true),
  product('Tesouro IGPM+ com Juros Semestrais', 'igpm+', true),
  {
    ...product('Tesouro Educa+', 'educa+', false),
    nameYearOffset: 4,
    maturityMonthDay: '12-15',
    monthlyPayments: 60,
  },
  {
    ...product('Tesouro Renda+ Aposentadoria Extra', 'renda+', false),
    nameYearOffset: 19,
    maturityMonthDay: '12-15',
    nameWords: ['aposentadoria', 'extra'],
    monthlyPayments: 240,
  },
];

function product(name: string, indexer: string, coupon: boolean): TesouroProduct {
  return {
    name,
    indexer,
    coupon,
    nameYearOffset: 0,
    maturityMonthDay: null,
    nameWords: [],
    monthlyPayments: null,
  };
}

const INDEXERS = new Set(TESOURO_PRODUCTS.map((entry) => entry.indexer));
/** A coupon is stated by `juros semestrais` or `js`; `com` / `c/` only join the phrase. */
const COUPON_WORDS = new Set(['com', 'c/', 'juros', 'semestrais', 'js']);

function statesCoupon(words: readonly string[]): boolean {
  return words.includes('js') || (words.includes('juros') && words.includes('semestrais'));
}

/** Case, accents and whitespace carry no meaning; `IPCA +` is `ipca+`. */
function wordsOf(text: string): readonly string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+\+/g, '+')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** The product a name spells, or `null` where any word is not that product's. */
function productOf(text: string): TesouroProduct | null {
  const [first, ...rest] = wordsOf(text);
  if (first !== 'tesouro') return null;
  const indexers = rest.filter((word) => INDEXERS.has(word));
  if (indexers.length !== 1) return null;
  const coupon = statesCoupon(rest);
  const match = TESOURO_PRODUCTS.find(
    (entry) => entry.indexer === indexers[0] && entry.coupon === coupon,
  );
  if (match === undefined) return null;
  // Coupon words on a product without one (`Tesouro Prefixado com 2029`) are
  // not that product's words, so they are no match rather than ignored.
  const known = (word: string) =>
    INDEXERS.has(word) ||
    (match.coupon && COUPON_WORDS.has(word)) ||
    match.nameWords.includes(word);
  return rest.every(known) ? match : null;
}

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
 * The code B3 gives a published title, or `null` where this module cannot say
 * it without guessing — a product not in the table, or a maturity that does
 * not fit its product's structure.
 */
export function b3TesouroCode(title: TesouroTitle): string | null {
  const entry = productOf(title.product);
  if (entry === null) return null;
  if (entry.maturityMonthDay !== null && title.maturity.slice(5) !== entry.maturityMonthDay) {
    return null;
  }
  const nameYear = Number(title.maturity.slice(0, 4)) - entry.nameYearOffset;
  return `${entry.name} ${nameYear}`;
}

/**
 * Import side: the catalogue code for a B3 `Produto` naming a Tesouro title
 * (`TESOURO RENDA+ 2030` → `Tesouro Renda+ Aposentadoria Extra 2030`), or
 * `null` where it names none this table knows. The year is B3's, as written.
 */
export function canonicalTesouroCode(produto: string): string | null {
  const match = /^(.*\S)\s+(\d{4})$/.exec(produto.trim());
  if (match === null) return null;
  const [, name = '', year = ''] = match;
  const entry = productOf(name);
  return entry === null ? null : `${entry.name} ${year}`;
}

/** The full-date code a title keeps when it has no B3 name — `Tesouro Novo 15/12/2030`. */
export function fullTesouroCode(title: TesouroTitle): string {
  return `${title.product.trim()} ${brDate(title.maturity)}`;
}

/**
 * The catalogue code for each row of the published file, in order.
 *
 * B3's name where one exists **and no other title in the file shares it** —
 * another maturity, or another published product read to the same one. Two
 * maturities of one product in one year did happen before 2014 (the quarterly
 * Prefixados of 2005–2011), and a product published under a second name
 * (#164 review: a `Tesouro Renda+` beside `Tesouro Renda+ Aposentadoria
 * Extra`) would read the same way; pricing one B3 name from both would
 * interleave two price series under one asset with nothing to say so. Both
 * keep their full-date codes instead. The sync passes the whole history
 * (#161), so a code means the same title on every day.
 */
export function tesouroCatalogCodes(titles: readonly TesouroTitle[]): readonly string[] {
  const b3Codes = titles.map(b3TesouroCode);
  // Distinct titles, not rows: a title repeated in the file is still one title.
  const sources = new Map<string, Set<string>>();
  titles.forEach((title, index) => {
    const code = b3Codes[index];
    if (code === null || code === undefined) return;
    const known = sources.get(code) ?? new Set<string>();
    known.add(fullTesouroCode(title));
    sources.set(code, known);
  });
  return titles.map((title, index) => {
    const code = b3Codes[index] ?? null;
    return code !== null && sources.get(code)?.size === 1 ? code : fullTesouroCode(title);
  });
}

/**
 * SPEC-007 BR-007-05c — the payment schedule of a Tesouro Educa+ or Renda+
 * title (NTN-B1).
 */
export interface PayoutSchedule {
  /** 15 January of the year in the title's name. */
  readonly firstPayment: BusinessDate;
  /** Monthly payments in all, the last on the maturity: Educa+ 60, Renda+ 240. */
  readonly installments: number;
}

/**
 * SPEC-007 BR-007-05c — the payout schedule of the title a catalogue code
 * names, or `null` for any code that is not an NTN-B1 title this table knows.
 *
 * Both forms a catalogue code takes are read (`tesouroCatalogCodes`): B3's
 * name (`Tesouro Educa+ 2026`), whose year is the year payments start, and
 * the full-date code a title keeps when its B3 name is ambiguous
 * (`Tesouro Educa+ 15/12/2030`), whose date is the maturity and is turned
 * back into B3's name by the same rule the sync uses (`b3TesouroCode`) — so a
 * maturity that does not fit the product's structure has no schedule either.
 *
 * Worked example (DV-17): `Tesouro Educa+ 2026` pays 60 instalments, the
 * first on 2026-01-15, the sixtieth on 2030-12-15 — its maturity, 4 years
 * after the name year (`nameYearOffset`), which is 5 × 12 = 60 months.
 * `Tesouro Renda+ Aposentadoria Extra 2030` pays 240 from 2030-01-15 to
 * 2049-12-15, 20 × 12 months.
 */
export function payoutScheduleOf(code: string): PayoutSchedule | null {
  const trimmed = code.trim();
  const byName = /^(.*\S)\s+(\d{4})$/.exec(trimmed);
  if (byName !== null) {
    const [, name = '', year = ''] = byName;
    const entry = productOf(name);
    if (entry === null || entry.monthlyPayments === null) return null;
    return {
      // 15 January exists in every year, so the date is built rather than
      // parsed: `BusinessDate.of`'s probe reads a year below 100 as 19xx.
      firstPayment: `${year}-01-15` as BusinessDate,
      installments: entry.monthlyPayments,
    };
  }
  const byMaturity = /^(.*\S)\s+(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (byMaturity === null) return null;
  const [, name = '', day = '', month = '', year = ''] = byMaturity;
  // `b3TesouroCode` reads the maturity as text only (its `MM-DD` and year),
  // so an impossible calendar date here is simply no match, never a throw.
  const b3Name = b3TesouroCode({
    product: name,
    maturity: `${year}-${month}-${day}` as BusinessDate,
  });
  return b3Name === null ? null : payoutScheduleOf(b3Name);
}
