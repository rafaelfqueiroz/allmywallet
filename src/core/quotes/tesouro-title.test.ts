import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  b3TesouroCode,
  canonicalTesouroCode,
  fullTesouroCode,
  payoutScheduleOf,
  TESOURO_PRODUCTS,
  tesouroCatalogCodes,
  type TesouroTitle,
} from '@/core/quotes/tesouro-title';

const title = (product: string, maturity: string): TesouroTitle => ({
  product,
  maturity: BusinessDate.of(maturity),
});

describe('#152 SPEC-008 BR-008-12 — a Tesouro title’s catalogue code', () => {
  /** The owner's four held titles, and the codes B3's Posição gives them. */
  it.each([
    ['Tesouro Selic', '2027-03-01', 'Tesouro Selic 2027'],
    ['Tesouro Selic', '2029-03-01', 'Tesouro Selic 2029'],
    ['Tesouro Selic', '2031-03-01', 'Tesouro Selic 2031'],
    ['Tesouro IPCA+', '2029-05-15', 'Tesouro IPCA+ 2029'],
  ])('%s maturing %s is B3’s %s', (product, maturity, code) => {
    expect(b3TesouroCode(title(product, maturity))).toBe(code);
  });

  it.each([
    ['Tesouro Prefixado', '2031-01-01', 'Tesouro Prefixado 2031'],
    [
      'Tesouro Prefixado com Juros Semestrais',
      '2035-01-01',
      'Tesouro Prefixado com Juros Semestrais 2035',
    ],
    ['Tesouro IPCA+ com Juros Semestrais', '2050-08-15', 'Tesouro IPCA+ com Juros Semestrais 2050'],
    ['Tesouro IGPM+ com Juros Semestrais', '2031-01-01', 'Tesouro IGPM+ com Juros Semestrais 2031'],
  ])('every year-named product translates — %s', (product, maturity, code) => {
    expect(b3TesouroCode(title(product, maturity))).toBe(code);
  });

  it('ignores case, accents and surrounding whitespace in the published product name', () => {
    expect(b3TesouroCode(title(' tesouro SELIC ', '2029-03-01'))).toBe('Tesouro Selic 2029');
  });

  /**
   * #164: named for the year payments start. Educa+ pays 60 months and
   * matures on 15/12 four years on; Renda+ pays 240 months and matures on
   * 15/12 nineteen years on. The pairs are Tesouro Transparente's own.
   */
  it.each([
    ['Tesouro Educa+', '2030-12-15', 'Tesouro Educa+ 2026'],
    ['Tesouro Educa+', '2048-12-15', 'Tesouro Educa+ 2044'],
    ['Tesouro Renda+ Aposentadoria Extra', '2049-12-15', 'Tesouro Renda+ Aposentadoria Extra 2030'],
    ['Tesouro Renda+ Aposentadoria Extra', '2084-12-15', 'Tesouro Renda+ Aposentadoria Extra 2065'],
  ])('#164: %s maturing %s is %s', (product, maturity, code) => {
    expect(b3TesouroCode(title(product, maturity))).toBe(code);
  });

  /** A maturity off the product's structure is not renamed onto a title that fits it. */
  it.each([
    ['Tesouro Educa+', '2030-06-15'],
    ['Tesouro Renda+ Aposentadoria Extra', '2049-12-01'],
  ])('#164: %s maturing %s does not fit the structure and has no B3 code', (product, maturity) => {
    expect(b3TesouroCode(title(product, maturity))).toBeNull();
  });

  it.each([
    ['Tesouro Novo Produto', '2040-01-01'],
    ['Tesouro IPCA+ Educacional', '2040-05-15'],
    ['Tesouro Selic com Juros Semestrais', '2029-03-01'],
    ['Tesouro IGPM+', '2031-01-01'],
    ['Tesouro Selic IPCA+', '2029-03-01'],
    ['Tesouro Prefixado com', '2029-01-01'],
    ['Tesouro Prefixado Juros', '2029-01-01'],
  ])('%s is no product the table knows, so it has no B3 code', (product, maturity) => {
    expect(b3TesouroCode(title(product, maturity))).toBeNull();
  });

  it('writes the full-date code in the form Tesouro Transparente publishes', () => {
    expect(fullTesouroCode(title('Tesouro Novo ', '2030-12-15'))).toBe('Tesouro Novo 15/12/2030');
  });
});

describe('#164 SPEC-005 BR-005-14 — canonicalTesouroCode, B3’s Produto on import', () => {
  it.each([
    ['Tesouro Selic 2029', 'Tesouro Selic 2029'],
    ['TESOURO SELIC 2029', 'Tesouro Selic 2029'],
    ['  Tesouro   IPCA+ 2029 ', 'Tesouro IPCA+ 2029'],
    ['Tesouro IPCA + 2029', 'Tesouro IPCA+ 2029'],
    ['Tesouro IPCA+ com Juros Semestrais 2035', 'Tesouro IPCA+ com Juros Semestrais 2035'],
    ['Tesouro IPCA+ c/ Juros Semestrais 2035', 'Tesouro IPCA+ com Juros Semestrais 2035'],
    ['Tesouro Prefixado JS 2031', 'Tesouro Prefixado com Juros Semestrais 2031'],
    ['Tesouro Educa+ 2026', 'Tesouro Educa+ 2026'],
    ['TESOURO EDUCA+ 2026', 'Tesouro Educa+ 2026'],
    ['Tesouro Renda+ Aposentadoria Extra 2030', 'Tesouro Renda+ Aposentadoria Extra 2030'],
    ['Tesouro Renda+ 2030', 'Tesouro Renda+ Aposentadoria Extra 2030'],
    ['Tesouro RendA+ Aposentadoria 2030', 'Tesouro Renda+ Aposentadoria Extra 2030'],
  ])('%s resolves to %s', (produto, code) => {
    expect(canonicalTesouroCode(produto)).toBe(code);
  });

  /** Keeps its own code and stays unpriced, visibly, rather than borrowing a price. */
  it.each([
    'PETR4',
    'Tesouro Selic',
    'Tesouro Novo Produto 2040',
    'Tesouro IPCA+ Educacional 2040',
    'NTN-B1 2030',
    'CDB - BANCO TESTE S/A',
    '',
  ])('“%s” names no Tesouro title the table knows', (produto) => {
    expect(canonicalTesouroCode(produto)).toBeNull();
  });

  /** The two sides must meet: whatever the sync writes, the importer resolves to it. */
  it('agrees with the sync on every product in the table', () => {
    const maturities: Record<string, string> = {
      'Tesouro Educa+': '2030-12-15',
      'Tesouro Renda+ Aposentadoria Extra': '2049-12-15',
    };
    expect(TESOURO_PRODUCTS).toHaveLength(8);
    for (const { name } of TESOURO_PRODUCTS) {
      const product = name;
      const maturity = maturities[name] ?? '2031-01-01';
      const code = b3TesouroCode(title(product, maturity));
      expect(code).not.toBeNull();
      expect(canonicalTesouroCode(code as string)).toBe(code);
    }
  });
});

describe('#152 — tesouroCatalogCodes over the published file', () => {
  it('gives each title its B3 code, and a product with none its full-date code, in order', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Selic', '2029-03-01'),
        title('Tesouro Novo', '2030-12-15'),
        title('Tesouro Educa+', '2030-12-15'),
      ]),
    ).toEqual(['Tesouro Selic 2029', 'Tesouro Novo 15/12/2030', 'Tesouro Educa+ 2026']);
  });

  /**
   * The Prefixados of 2005–2011 matured quarterly — four titles, one year. A
   * B3 name shared by two maturities cannot be priced from either.
   */
  it('keeps the full date for every title whose B3 code another maturity shares', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Prefixado', '2010-01-01'),
        title('Tesouro Prefixado', '2010-07-01'),
        title('Tesouro Prefixado', '2011-01-01'),
      ]),
    ).toEqual([
      'Tesouro Prefixado 01/01/2010',
      'Tesouro Prefixado 01/07/2010',
      'Tesouro Prefixado 2011',
    ]);
  });

  /** Two published products read to one: neither is priced from the other. */
  it('keeps the full date for both where two published products read to one B3 code', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Renda+ Aposentadoria Extra', '2049-12-15'),
        title('Tesouro Renda+', '2049-12-15'),
      ]),
    ).toEqual(['Tesouro Renda+ Aposentadoria Extra 15/12/2049', 'Tesouro Renda+ 15/12/2049']);
  });

  it('a title repeated in the file is still one title', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Selic', '2029-03-01'),
        title('Tesouro Selic', '2029-03-01'),
      ]),
    ).toEqual(['Tesouro Selic 2029', 'Tesouro Selic 2029']);
  });

  it('an empty file has no codes', () => {
    expect(tesouroCatalogCodes([])).toEqual([]);
  });
});

describe('#166 SPEC-007 BR-007-05c — payoutScheduleOf, an NTN-B1 title’s payments', () => {
  it.each([
    // Name year = first payment year; 60 payments for Educa+, 240 for Renda+.
    ['Tesouro Educa+ 2026', '2026-01-15', 60],
    ['Tesouro Educa+ 2035', '2035-01-15', 60],
    ['Tesouro Renda+ Aposentadoria Extra 2030', '2030-01-15', 240],
    ['Tesouro Renda+ Aposentadoria Extra 2065', '2065-01-15', 240],
    // Spelled the way B3's Produto may spell it: words, not exact text.
    ['TESOURO EDUCA+ 2026', '2026-01-15', 60],
    ['  Tesouro Renda+  Aposentadoria Extra 2030 ', '2030-01-15', 240],
  ])('%s pays from %s, %i times', (code, firstPayment, installments) => {
    expect(payoutScheduleOf(code)).toEqual({ firstPayment, installments });
  });

  it.each([
    // The full-date code a title keeps when its B3 name is ambiguous: the date
    // is the maturity, 15/12 of name year + 4 (Educa+) or + 19 (Renda+).
    ['Tesouro Educa+ 15/12/2030', '2026-01-15', 60],
    ['Tesouro Renda+ Aposentadoria Extra 15/12/2049', '2030-01-15', 240],
  ])('the full-date code %s pays from %s, %i times', (code, firstPayment, installments) => {
    expect(payoutScheduleOf(code)).toEqual({ firstPayment, installments });
  });

  it.each([
    'Tesouro IPCA+ 2029',
    'Tesouro Selic 2031',
    'Tesouro IPCA+ com Juros Semestrais 2035',
    'Tesouro Prefixado 01/01/2031',
    'Tesouro Selic 31/02/2029', // an impossible date is no match, never a throw
    'Tesouro Educa+ 01/06/2030', // a maturity that does not fit the product
    'Tesouro Educa+', // no year
    'Tesouro Novo 2030',
    'VIVT3',
    'HGLG11',
    '',
  ])('%s has no payout schedule', (code) => {
    expect(payoutScheduleOf(code)).toBeNull();
  });

  it('every product that pays in instalments pays monthly up to its 15 December maturity', () => {
    // The schedule and the maturity rule describe one structure: n monthly
    // payments from January of the name year end in December of name year +
    // offset, so n = (offset + 1) × 12 — Educa+ (4 + 1) × 12 = 60, Renda+
    // (19 + 1) × 12 = 240.
    const paying = TESOURO_PRODUCTS.filter((entry) => entry.monthlyPayments !== null);
    expect(paying.map((entry) => entry.name)).toEqual([
      'Tesouro Educa+',
      'Tesouro Renda+ Aposentadoria Extra',
    ]);
    for (const entry of paying) {
      expect(entry.monthlyPayments).toBe((entry.nameYearOffset + 1) * 12);
      expect(entry.maturityMonthDay).toBe('12-15');
    }
  });
});
