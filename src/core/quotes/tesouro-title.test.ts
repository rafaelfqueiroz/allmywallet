import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  b3TesouroCode,
  fullTesouroCode,
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

  it('ignores surrounding whitespace in the published product name', () => {
    expect(b3TesouroCode(title(' Tesouro Selic ', '2029-03-01'))).toBe('Tesouro Selic 2029');
  });

  /**
   * Named for the year payments start, not the year they mature: the Educa+
   * maturing 15/12/2030 is the 2026 title. Reading the maturity year would
   * price one title from another.
   */
  it.each([
    ['Tesouro Educa+', '2030-12-15'],
    ['Tesouro Renda+ Aposentadoria Extra', '2049-12-15'],
    ['Tesouro Novo Produto', '2040-01-01'],
    ['tesouro selic', '2029-03-01'],
  ])('%s has no B3 code it can derive', (product, maturity) => {
    expect(b3TesouroCode(title(product, maturity))).toBeNull();
  });

  it('writes the full-date code in the form Tesouro Transparente publishes', () => {
    expect(fullTesouroCode(title('Tesouro Educa+ ', '2030-12-15'))).toBe(
      'Tesouro Educa+ 15/12/2030',
    );
  });
});

describe('#152 — tesouroCatalogCodes over one published batch', () => {
  it('gives each title its B3 code, and a product with none its full-date code, in order', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Selic', '2029-03-01'),
        title('Tesouro Educa+', '2030-12-15'),
        title('Tesouro IPCA+', '2029-05-15'),
      ]),
    ).toEqual(['Tesouro Selic 2029', 'Tesouro Educa+ 15/12/2030', 'Tesouro IPCA+ 2029']);
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

  it('a title repeated in the file is still one title', () => {
    expect(
      tesouroCatalogCodes([
        title('Tesouro Selic', '2029-03-01'),
        title('Tesouro Selic', '2029-03-01'),
      ]),
    ).toEqual(['Tesouro Selic 2029', 'Tesouro Selic 2029']);
  });

  it('an empty batch has no codes', () => {
    expect(tesouroCatalogCodes([])).toEqual([]);
  });
});
