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
 * the coupon words (`com juros semestrais`, `c/ juros semestrais`, `js`) and
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
  { ...product('Tesouro Educa+', 'educa+', false), nameYearOffset: 4, maturityMonthDay: '12-15' },
  {
    ...product('Tesouro Renda+ Aposentadoria Extra', 'renda+', false),
    nameYearOffset: 19,
    maturityMonthDay: '12-15',
    nameWords: ['aposentadoria', 'extra'],
  },
];

function product(name: string, indexer: string, coupon: boolean): TesouroProduct {
  return { name, indexer, coupon, nameYearOffset: 0, maturityMonthDay: null, nameWords: [] };
}

const INDEXERS = new Set(TESOURO_PRODUCTS.map((entry) => entry.indexer));
const COUPON_WORDS = new Set(['com', 'c/', 'juros', 'semestrais', 'js']);

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
  const coupon = rest.some((word) => COUPON_WORDS.has(word));
  const match = TESOURO_PRODUCTS.find(
    (entry) => entry.indexer === indexers[0] && entry.coupon === coupon,
  );
  if (match === undefined) return null;
  const known = (word: string) =>
    INDEXERS.has(word) || COUPON_WORDS.has(word) || match.nameWords.includes(word);
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
 * B3's name where one exists **and no other maturity in the file shares it**.
 * Two maturities of one product in one year did happen before 2014 (the
 * quarterly Prefixados of 2005–2011), and pricing one B3 name from both
 * titles would interleave two price series under one asset with nothing to
 * say so. Both keep their full-date codes instead. The sync passes the whole
 * history (#161), so a code means the same maturity on every day.
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
