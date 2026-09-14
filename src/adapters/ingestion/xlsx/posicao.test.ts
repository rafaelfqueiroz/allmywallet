import { describe, expect, it } from 'vitest';
import { detectExtractType } from '@/adapters/ingestion/xlsx/detect';
import { parsePosicao } from '@/adapters/ingestion/xlsx/posicao';
import {
  POSICAO_TAB_HEADERS,
  posicaoRow,
  type PosicaoRowInput,
  type PosicaoTab,
} from '@/adapters/ingestion/xlsx/test-support/builder';

/** One tab of the real layout (#108), reduced to the `(string | null)[][]` a parser reads. */
function rowsFor(tab: PosicaoTab, inputs: readonly PosicaoRowInput[]): (string | null)[][] {
  const headers = [...POSICAO_TAB_HEADERS[tab]];
  return [
    headers,
    ...inputs.map((input) => {
      const row = posicaoRow(tab, input);
      return headers.map((header) => row[header] || null);
    }),
  ];
}

function parse(tab: PosicaoTab, inputs: readonly PosicaoRowInput[], sheetName: string = tab) {
  const rows = rowsFor(tab, inputs);
  const detected = detectExtractType(rows);
  if (!detected.ok) throw new Error('detect failed in test setup');
  return parsePosicao(rows, detected.value, sheetName).map((parsed) => {
    if (parsed.record.kind !== 'position') throw new Error('expected a position record');
    return parsed.record;
  });
}

describe('SPEC-005 #108 — parsePosicao against the real per-tab layout', () => {
  it('Acoes: the ticker is Código de Negociação and the class comes from the tab', () => {
    const [record] = parse('Acoes', [
      { produto: 'PETR4 - PETROBRAS', codigo: 'PETR4', tipo: 'PN', quantidade: '100' },
    ]);

    expect(record?.assetCode).toBe('PETR4');
    expect(record?.assetName).toBe('PETROBRAS');
    expect(record?.assetClass).toBe('stock');
    expect(record?.institutionName).toBe('Corretora Teste');
    expect(record?.quantity.toString()).toBe('100');
    expect(record?.fixedIncome).toBeNull();
  });

  it('Fundo de Investimento: FIIs live on the funds tab', () => {
    const [record] = parse('Fundo de Investimento', [
      { produto: 'HGLG11 - FII TESTE LOG', codigo: 'HGLG11', tipo: 'Cotas', quantidade: '50' },
    ]);

    expect(record?.assetCode).toBe('HGLG11');
    expect(record?.assetClass).toBe('fii');
  });

  it('a listed row with no Código de Negociação falls back to the Produto prefix', () => {
    const [record] = parse('Acoes', [{ produto: 'VALE3 - VALE', quantidade: '10' }]);
    expect(record?.assetCode).toBe('VALE3');
  });

  it('BDR and ETF tabs map to their classes by name', () => {
    const [bdr] = parse('Acoes', [{ produto: 'AAPL34 - APPLE', quantidade: '1' }], 'BDR');
    const [etf] = parse('Acoes', [{ produto: 'BOVA11 - ISHARES', quantidade: '1' }], 'ETF');
    expect(bdr?.assetClass).toBe('bdr');
    expect(etf?.assetClass).toBe('etf');
  });

  it('the tab name is matched case- and accent-insensitively', () => {
    const [record] = parse('Acoes', [{ produto: 'PETR4 - PETROBRAS', quantidade: '1' }], 'Ações');
    expect(record?.assetClass).toBe('stock');
  });

  it('a tab whose name is not a known asset class yields no rows rather than a guessed class', () => {
    expect(parse('Acoes', [{ produto: 'XYZ3 - XYZ', quantidade: '1' }], 'Outros')).toEqual([]);
  });

  it('Tesouro Direto: the code is Produto, the same one Movimentação resolves the title to', () => {
    const [record] = parse('Tesouro Direto', [
      { produto: 'Tesouro Selic 2029', quantidade: '1,5', vencimento: '01/03/2029' },
    ]);

    expect(record?.assetCode).toBe('Tesouro Selic 2029');
    expect(record?.assetName).toBe('Tesouro Selic 2029');
    expect(record?.assetClass).toBe('tesouro_direto');
    expect(record?.quantity.toString()).toBe('1.5');
    expect(record?.fixedIncome).toBeNull();
  });

  it('BR-005-06 (amended): a CDB carries indexer, issue and maturity — and no rate, which the user types', () => {
    const [record] = parse('Renda Fixa', [
      {
        produto: 'CDB - BANCO TESTE S/A',
        codigo: 'CDB0000TESTE',
        quantidade: '1',
        indexador: 'DI',
        dataEmissao: '01/01/2024',
        vencimento: '01/01/2027',
      },
    ]);

    expect(record?.assetCode).toBe('CDB0000TESTE');
    expect(record?.assetName).toBe('CDB - BANCO TESTE S/A');
    expect(record?.assetClass).toBe('cdb');
    expect(record?.fixedIncome).toEqual({
      indexer: 'cdi_percent',
      ratePercent: null,
      issueDate: '2024-01-01',
      maturityDate: '2027-01-01',
      principal: null,
    });
  });

  it('LCI and LCA are read from the Produto prefix', () => {
    const records = parse('Renda Fixa', [
      { produto: 'LCI - BANCO TESTE S/A', codigo: 'LCI1', quantidade: '1', indexador: 'IPCA' },
      { produto: 'LCA - BANCO TESTE S/A', codigo: 'LCA1', quantidade: '1', indexador: 'PRÉ' },
    ]);

    expect(records.map((r) => r.assetClass)).toEqual(['lci', 'lca']);
    expect(records.map((r) => r.fixedIncome?.indexer)).toEqual(['ipca_spread', 'prefixado']);
  });

  it('a Renda Fixa product that is not CDB/LCI/LCA yields no row', () => {
    expect(parse('Renda Fixa', [{ produto: 'DEB - EMPRESA TESTE', quantidade: '1' }])).toEqual([]);
  });

  it('a Renda Fixa row with no Código keeps Produto as the code', () => {
    const [record] = parse('Renda Fixa', [{ produto: 'CDB - BANCO TESTE S/A', quantidade: '1' }]);
    expect(record?.assetCode).toBe('CDB - BANCO TESTE S/A');
  });

  it('BR-009-13: an unknown indexer and a missing issue date stay unreadable rather than assumed', () => {
    const [record] = parse('Renda Fixa', [
      { produto: 'CDB - BANCO TESTE S/A', codigo: 'CDB1', quantidade: '1', indexador: 'IGP-M' },
    ]);

    expect(record?.fixedIncome?.indexer).toBeNull();
    expect(record?.fixedIncome?.issueDate).toBeNull();
    expect(record?.fixedIncome?.maturityDate).toBeNull();
  });

  it('a Renda Fixa row with no Indexador at all has a null indexer', () => {
    const [record] = parse('Renda Fixa', [
      { produto: 'CDB - BANCO TESTE S/A', codigo: 'CDB1', quantidade: '1' },
    ]);
    expect(record?.fixedIncome?.indexer).toBeNull();
  });

  it('skips blank rows and rows with no Produto or Quantidade (totals, footers)', () => {
    const rows = rowsFor('Acoes', [{ produto: 'PETR4 - PETROBRAS', quantidade: '100' }]);
    const headers = rows[0] ?? [];
    const valorIndex = headers.indexOf('Valor Atualizado');
    const produtoIndex = headers.indexOf('Produto');
    const footer = headers.map((_, i) => (i === valorIndex ? '1.000,00' : null));
    const noQuantity = headers.map((_, i) => (i === produtoIndex ? 'VALE3 - VALE' : null));
    rows.push(
      headers.map(() => null),
      footer,
      noQuantity,
    );

    const detected = detectExtractType(rows);
    if (!detected.ok) throw new Error('detect failed in test setup');
    expect(parsePosicao(rows, detected.value, 'Acoes')).toHaveLength(1);
  });
});
