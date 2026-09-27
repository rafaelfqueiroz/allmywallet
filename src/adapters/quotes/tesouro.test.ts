import { afterEach, describe, expect, it, vi } from 'vitest';
import { TesouroTransparenteProvider, parseTesouroCsv } from './tesouro';

/**
 * TS-26/TS-20: a synthetic, structurally-faithful CSV fixture — same header
 * and column order Tesouro Transparente publishes, invented rows. Never a
 * captured real download (TS-19's reasoning applies here too, even though
 * this data carries no personal information — fixtures are generated).
 */
const RECORDED_CSV = [
  'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
  'Tesouro Selic;01/03/2029;14/03/2026;0,10;0,05;14.230,50;14.229,80;14.230,10',
  'Tesouro IPCA+;15/05/2035;14/03/2026;5,80;5,85;3.410,22;3.408,90;3.409,50',
  'Tesouro Selic;01/03/2029;16/03/2026;0,10;0,05;14.250,00;14.249,00;14.249,60',
  'Tesouro IPCA+;15/05/2035;16/03/2026;5,79;5,84;3.415,00;3.413,70;3.414,20',
].join('\n');

describe('parseTesouroCsv (BR-008-12; AR-06 comma-decimal parsing)', () => {
  /**
   * #161: the file is every title's whole history, and all of it is returned
   * — keeping only the latest date lost every day the sync did not run on.
   */
  it('returns every published close, every date, converting Brazilian decimals correctly', () => {
    const points = parseTesouroCsv(RECORDED_CSV, 'tesouro_transparente');
    expect(points?.map((p) => [p.ticker, p.date, p.price.toString()])).toEqual([
      // Hand-verified: "14.229,80" -> thousands separator stripped, comma -> dot.
      ['Tesouro Selic 2029', '2026-03-14', '14229.8'],
      ['Tesouro IPCA+ 2035', '2026-03-14', '3408.9'],
      ['Tesouro Selic 2029', '2026-03-16', '14249'],
      ['Tesouro IPCA+ 2035', '2026-03-16', '3413.7'],
    ]);
    expect(points?.every((p) => p.source === 'tesouro_transparente')).toBe(true);
  });

  /**
   * The quarterly Prefixados of 2005–2011: across the whole history, one B3
   * name would cover two maturities, so neither gets it — on any date.
   */
  it('keeps the full date for a B3 name two maturities share anywhere in the history', () => {
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Prefixado;01/01/2010;05/01/2009;11,20;11,30;900,10;899,00;899,50',
      'Tesouro Prefixado;01/07/2010;06/01/2009;11,20;11,30;850,10;849,00;849,50',
    ].join('\n');
    expect(parseTesouroCsv(csv, 'tesouro_transparente')?.map((p) => p.ticker)).toEqual([
      'Tesouro Prefixado 01/01/2010',
      'Tesouro Prefixado 01/07/2010',
    ]);
  });

  it('drops a row whose base date cannot be read, keeping the rest of the file', () => {
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Selic;01/03/2029;16/03/2026;0,10;0,05;14.250,00;14.249,00;14.249,60',
      'Tesouro Selic;01/03/2029;32/03/2026;0,10;0,05;14.250,00;14.249,00;14.249,60',
    ].join('\n');
    expect(parseTesouroCsv(csv, 'tesouro_transparente')?.map((p) => p.date)).toEqual([
      '2026-03-16',
    ]);
  });

  /**
   * SPEC-009 BR-009-06 / DL-009-04 — the sell price is what the holder would
   * realise, so `PU Venda Manhã` is the column that reaches `price_quotes`.
   * This parser originally read `PU Base Manhã`; SPEC-009 is what settled the
   * question, and the assertion lives here because this is where the choice
   * is actually made.
   */
  it('BR-009-06: reads PU Venda Manhã, not PU Compra or PU Base', () => {
    const points = parseTesouroCsv(RECORDED_CSV, 'tesouro_transparente');
    const ipca = points?.find(
      (p) => p.ticker.startsWith('Tesouro IPCA+') && p.date === '2026-03-16',
    );
    // Row for 16/03/2026: compra 3.415,00 | venda 3.413,70 | base 3.414,20
    expect(ipca?.price.toString()).toBe('3413.7');
    expect(ipca?.price.toString()).not.toBe('3415'); // buy price — overstates
    expect(ipca?.price.toString()).not.toBe('3414.2'); // base price — overstates
  });

  /**
   * #152: the price must land on the asset the ledger holds, which B3 names
   * by product and year. A product whose B3 name cannot be derived keeps
   * Tesouro Transparente's product and maturity date.
   */
  it('catalogues each title under B3’s name, and a product with none under its maturity date', () => {
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Selic;01/03/2029;16/03/2026;0,10;0,05;14.250,00;14.249,00;14.249,60',
      'Tesouro IPCA+;15/05/2029;16/03/2026;5,79;5,84;3.415,00;3.413,70;3.414,20',
      'Tesouro Educa+;15/12/2030;16/03/2026;6,10;6,20;3.100,00;3.090,00;3.095,00',
    ].join('\n');
    expect(parseTesouroCsv(csv, 'tesouro_transparente')?.map((p) => p.ticker)).toEqual([
      'Tesouro Selic 2029',
      'Tesouro IPCA+ 2029',
      'Tesouro Educa+ 15/12/2030',
    ]);
  });

  it('drops a title whose maturity date cannot be read, keeping the rest of the day', () => {
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Selic;01/03/2029;16/03/2026;0,10;0,05;14.250,00;14.249,00;14.249,60',
      'Tesouro IPCA+;31/02/2029;16/03/2026;5,79;5,84;3.415,00;3.413,70;3.414,20',
    ].join('\n');
    expect(parseTesouroCsv(csv, 'tesouro_transparente')?.map((p) => p.ticker)).toEqual([
      'Tesouro Selic 2029',
    ]);
  });

  it('falls back to PU Base when a title is no longer offered for redemption', () => {
    // A real shape in the published file: the venda column is blank for a
    // title Tesouro no longer buys back. Dropping the row would silently
    // understate the portfolio (DL-009-05), so the base price is used.
    const csv = [
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha',
      'Tesouro Prefixado;01/01/2031;16/03/2026;11,20;;700,10;;701,55',
    ].join('\n');
    const points = parseTesouroCsv(csv, 'tesouro_transparente');
    expect(points?.[0]?.price.toString()).toBe('701.55');
  });

  it('rejects a CSV missing the expected columns rather than misreading it', () => {
    expect(parseTesouroCsv('a;b;c\n1;2;3', 'tesouro_transparente')).toBeNull();
  });

  it('an empty CSV yields no points, not an error', () => {
    const header =
      'Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha';
    expect(parseTesouroCsv(header, 'tesouro_transparente')).toEqual([]);
  });
});

/** A server that accepts the request and never answers — only the abort signal ends it. */
function stubHangingFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ),
  );
}

describe('TesouroTransparenteProvider (SPEC-008 BR-008-12)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and parses the recorded CSV', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve(RECORDED_CSV) }),
    );
    const provider = new TesouroTransparenteProvider({ source: 'tesouro_transparente' });
    const result = await provider.fetchDailyPrices();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(4);
  });

  it('#161: a server that never answers is UNAVAILABLE after the timeout, not a hang', async () => {
    stubHangingFetch();
    const provider = new TesouroTransparenteProvider({
      source: 'tesouro_transparente',
      timeoutMs: 20,
    });
    const result = await provider.fetchDailyPrices();
    expect(result.ok).toBe(false);
  });

  it('a 5xx response is UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 502, text: () => Promise.resolve('') }),
    );
    const provider = new TesouroTransparenteProvider({ source: 'tesouro_transparente' });
    const result = await provider.fetchDailyPrices();
    expect(result.ok).toBe(false);
  });
});
