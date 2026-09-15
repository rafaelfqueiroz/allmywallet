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

    it("an event with no price (B3's `-`) parses, flagged as priceless, rather than failing the file", () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Transferência',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '-',
        valorOperacao: '-',
      });
      // A placeholder, not a price: stage-batch keeps a priceless transfer out
      // of the ledger instead of opening a lot at zero cost.
      expect(record.unitPrice.toString()).toBe('0');
      expect(record.priceStated).toBe(false);
    });

    it('a stated price is flagged as stated', () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Dividendo',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '0,50',
      });
      expect(record.priceStated).toBe(true);
    });

    it('a `-` in a required column still fails loudly instead of dropping the row', () => {
      const rows = rowsFor([
        movimentacaoRow({
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '-',
        }),
      ]);
      expect(() => parseMovimentacao(rows, structureOf(rows))).toThrow(/quantidade/);
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

    it("#115: bank paper that states its code is coded as Posição's `Código`", () => {
      const bare = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'CDB - CDB0000TESTE',
        quantidade: '1',
      });
      const withIssuer = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'CDB - CDBA000TESTE - BANCO TESTE S/A',
        quantidade: '1',
      });
      const lci = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'LCI - LCI00TESTE1 - BANCO TESTE S/A',
        quantidade: '1',
      });
      const lca = parseOne({
        data: '10/01/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'LCA - LCA00TESTE1',
        quantidade: '1',
      });

      expect(bare.assetCode).toBe('CDB0000TESTE');
      expect(bare.assetName).toBe('CDB - CDB0000TESTE');
      expect(bare.assetClass).toBe('cdb');
      expect(withIssuer.assetCode).toBe('CDBA000TESTE');
      expect(withIssuer.assetName).toBe('CDB - BANCO TESTE S/A');
      expect(withIssuer.assetClass).toBe('cdb');
      expect(lci.assetCode).toBe('LCI00TESTE1');
      expect(lci.assetClass).toBe('lci');
      expect(lca.assetCode).toBe('LCA00TESTE1');
      expect(lca.assetClass).toBe('lca');
    });

    it('#115: a ticker that starts like bank paper is still a stock', () => {
      const record = parseOne({
        data: '10/01/2026',
        movimentacao: 'Dividendo',
        produto: 'LCAM3 - LOCAMERICA',
        quantidade: '10',
      });
      expect(record.assetCode).toBe('LCAM3');
      expect(record.assetClass).toBe('stock');

      const option = parseOne({
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'LCAMA120 - LOCAMERICA',
        quantidade: '100',
      });
      expect(option.assetCode).toBe('LCAMA120');
      expect(option.assetClass).toBe('stock');
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
