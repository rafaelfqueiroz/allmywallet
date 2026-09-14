import { describe, expect, it } from 'vitest';
import { detectExtractType } from '@/adapters/ingestion/xlsx/detect';
import { parseMovimentacao } from '@/adapters/ingestion/xlsx/movimentacao';
import {
  MOVIMENTACAO_HEADERS,
  movimentacaoRow,
} from '@/adapters/ingestion/xlsx/test-support/builder';

function rowsFor(records: readonly Record<string, string>[]): (string | null)[][] {
  return [
    [...MOVIMENTACAO_HEADERS],
    ...records.map((r) => [...MOVIMENTACAO_HEADERS].map((h) => r[h] ?? null)),
  ];
}

function structureOf(rows: (string | null)[][]) {
  const detected = detectExtractType(rows);
  if (!detected.ok) throw new Error('detect failed in test setup');
  return detected.value;
}

describe('SPEC-005 — parseMovimentacao', () => {
  it('parses a buy row into a NormalizedTransactionRecord', () => {
    const row = movimentacaoRow({
      data: '10/01/2026',
      movimentacao: 'Compra',
      produto: 'PETR4 - Petrobras PN',
      quantidade: '100',
      precoUnitario: '32,15',
    });
    const rows = rowsFor([row]);
    const records = parseMovimentacao(rows, structureOf(rows));

    expect(records).toHaveLength(1);
    const record = records[0]?.record;
    if (record?.kind !== 'transaction') throw new Error('expected a transaction record');
    expect(record.b3Type).toBe('Compra');
    expect(record.assetCode).toBe('PETR4');
    expect(record.assetName).toBe('Petrobras PN');
    expect(record.tradeDate).toBe('2026-01-10');
    expect(record.quantity.toString()).toBe('100');
    expect(record.unitPrice.toString()).toBe('32.15');
  });

  it('BR-005-01: direction disambiguates a Transferência row into transfer_in vs transfer_out via credit/debit', () => {
    const rows = rowsFor([
      movimentacaoRow({
        entradaSaida: 'Credito',
        data: '10/01/2026',
        movimentacao: 'Transferência - Liquidação',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '10',
      }),
    ]);
    const records = parseMovimentacao(rows, structureOf(rows));
    const record = records[0]?.record;
    if (record?.kind !== 'transaction') throw new Error('expected a transaction record');
    expect(record.direction).toBe('credit');
  });

  it('BR-005-19: an unrecognised movement type is still parsed (classification happens downstream, in core)', () => {
    const rows = rowsFor([
      movimentacaoRow({
        data: '10/01/2026',
        movimentacao: 'Um Tipo Que a B3 Inventou',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '10',
      }),
    ]);
    const records = parseMovimentacao(rows, structureOf(rows));
    expect(records).toHaveLength(1);
    expect(records[0]?.record.kind).toBe('transaction');
  });

  it('BR-005-16: two genuine identical same-day rows both parse — no dedup at the parser level', () => {
    const row = movimentacaoRow({
      data: '10/01/2026',
      movimentacao: 'Compra',
      produto: 'PETR4 - Petrobras PN',
      quantidade: '100',
      precoUnitario: '32,15',
    });
    const rows = rowsFor([row, row]);
    const records = parseMovimentacao(rows, structureOf(rows));
    expect(records).toHaveLength(2);
  });

  it('skips a fully blank trailing row', () => {
    const rows = rowsFor([
      movimentacaoRow({
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '1',
      }),
    ]);
    rows.push(new Array(MOVIMENTACAO_HEADERS.length).fill(null));
    const records = parseMovimentacao(rows, structureOf(rows));
    expect(records).toHaveLength(1);
  });

  describe('#108 — the real export', () => {
    function parseOne(input: Parameters<typeof movimentacaoRow>[0]) {
      const rows = rowsFor([movimentacaoRow(input)]);
      const record = parseMovimentacao(rows, structureOf(rows))[0]?.record;
      if (record?.kind !== 'transaction') throw new Error('expected a transaction record');
      return record;
    }

    it("an event with no price (B3's `-`) parses with a zero unit price rather than failing the file", () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Desdobro',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '-',
        valorOperacao: '-',
      });
      expect(record.unitPrice.toString()).toBe('0');
    });

    it('a Tesouro title keeps Produto as its code and is guessed as Tesouro Direto', () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'Tesouro Selic 2029',
        quantidade: '1',
      });
      expect(record.assetCode).toBe('Tesouro Selic 2029');
      expect(record.assetClass).toBe('tesouro_direto');
    });

    it('bank paper keeps the whole Produto as its code instead of collapsing into "CDB"', () => {
      const cdb = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'CDB - BANCO EXEMPLO S/A',
        quantidade: '1',
      });
      const lca = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'LCA - BANCO EXEMPLO S/A',
        quantidade: '1',
      });
      expect(cdb.assetCode).toBe('CDB - BANCO EXEMPLO S/A');
      expect(cdb.assetClass).toBe('cdb');
      expect(lca.assetClass).toBe('lca');
    });

    it('a ticker still splits from its name', () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Dividendo',
        produto: 'B3SA3 - B3 S.A.',
        quantidade: '10',
      });
      expect(record.assetCode).toBe('B3SA3');
      expect(record.assetName).toBe('B3 S.A.');
    });
  });
});
