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
  it('keeps only the most recent Data Base per title, converting Brazilian decimals correctly', () => {
    const points = parseTesouroCsv(RECORDED_CSV, 'tesouro_transparente');
    expect(points).not.toBeNull();
    expect(points).toHaveLength(2); // only 16/03/2026 rows
    const selic = points?.find((p) => p.ticker.startsWith('Tesouro Selic'));
    // Hand-verified: "14.249,00" -> thousands separator stripped, comma -> dot -> "14249.00"
    expect(selic?.price.toString()).toBe('14249');
    expect(selic?.date).toBe('2026-03-16');
    expect(selic?.source).toBe('tesouro_transparente');
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
    const ipca = points?.find((p) => p.ticker.startsWith('Tesouro IPCA+'));
    // Row for 16/03/2026: compra 3.415,00 | venda 3.413,70 | base 3.414,20
    expect(ipca?.price.toString()).toBe('3413.7');
    expect(ipca?.price.toString()).not.toBe('3415'); // buy price — overstates
    expect(ipca?.price.toString()).not.toBe('3414.2'); // base price — overstates
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
    if (result.ok) expect(result.value).toHaveLength(2);
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
