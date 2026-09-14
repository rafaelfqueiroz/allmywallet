import { describe, expect, it } from 'vitest';
import { detectExtractType } from '@/adapters/ingestion/xlsx/detect';
import { parseNegociacao } from '@/adapters/ingestion/xlsx/negociacao';
import { NEGOCIACAO_HEADERS, negociacaoRow } from '@/adapters/ingestion/xlsx/test-support/builder';

function rowsFor(records: readonly Record<string, string>[]): (string | null)[][] {
  return [
    [...NEGOCIACAO_HEADERS],
    ...records.map((r) => [...NEGOCIACAO_HEADERS].map((h) => r[h] ?? null)),
  ];
}

function structureOf(rows: (string | null)[][]) {
  const detected = detectExtractType(rows);
  if (!detected.ok) throw new Error('detect failed in test setup');
  return detected.value;
}

describe('SPEC-005 — parseNegociacao', () => {
  it('parses a trade row with the ticker already in tradeable form', () => {
    const rows = rowsFor([
      negociacaoRow({
        data: '10/01/2026',
        tipo: 'Compra',
        codigo: 'PETR4',
        quantidade: '100',
        preco: '32,15',
      }),
    ]);
    const records = parseNegociacao(rows, structureOf(rows));

    expect(records).toHaveLength(1);
    const record = records[0]?.record;
    if (record?.kind !== 'transaction') throw new Error('expected a transaction record');
    expect(record.b3Type).toBe('Compra');
    expect(record.assetCode).toBe('PETR4');
    expect(record.tradeDate).toBe('2026-01-10');
    expect(record.quantity.toString()).toBe('100');
    expect(record.unitPrice.toString()).toBe('32.15');
    expect(record.direction).toBeNull();
  });

  it('BR-005-16: two genuine identical same-day trades both parse', () => {
    const row = negociacaoRow({
      data: '10/01/2026',
      tipo: 'Compra',
      codigo: 'PETR4',
      quantidade: '100',
      preco: '32,15',
    });
    const rows = rowsFor([row, row]);
    const records = parseNegociacao(rows, structureOf(rows));
    expect(records).toHaveLength(2);
  });

  describe('#108 — the real layout', () => {
    function parseOne(input: Parameters<typeof negociacaoRow>[0]) {
      const rows = rowsFor([negociacaoRow(input)]);
      const record = parseNegociacao(rows, structureOf(rows))[0]?.record;
      if (record?.kind !== 'transaction') throw new Error('expected a transaction record');
      return record;
    }

    it('reads the trade type from Tipo de Movimentação and the institution from its column', () => {
      const record = parseOne({
        data: '10/01/2026',
        tipo: 'Venda',
        codigo: 'PETR4',
        quantidade: '10',
        preco: '32.15',
        instituicao: 'CORRETORA EXEMPLO',
      });
      expect(record.b3Type).toBe('Venda');
      expect(record.institutionName).toBe('CORRETORA EXEMPLO');
    });

    it('a fractional-market ticker is the same asset as its spot ticker', () => {
      const record = parseOne({
        data: '10/01/2026',
        tipo: 'Compra',
        mercado: 'Mercado Fracionário',
        codigo: 'PETR4F',
        quantidade: '7',
        preco: '32.15',
      });
      expect(record.assetCode).toBe('PETR4');
      expect(record.assetClass).toBe('stock');
    });

    it('strips the F from a ticker whose root carries a digit (B3SA3F)', () => {
      expect(
        parseOne({
          data: '10/01/2026',
          tipo: 'Compra',
          codigo: 'B3SA3F',
          quantidade: '1',
          preco: '1',
        }).assetCode,
      ).toBe('B3SA3');
    });

    it('leaves a unit ticker alone (TAEE11 has no F)', () => {
      expect(
        parseOne({
          data: '10/01/2026',
          tipo: 'Compra',
          codigo: 'TAEE11',
          quantidade: '1',
          preco: '1',
        }).assetCode,
      ).toBe('TAEE11');
    });

    it('a term trade (Prazo/Vencimento set) and an auction row parse as ordinary trades', () => {
      const term = parseOne({
        data: '10/01/2026',
        tipo: 'Compra',
        prazo: '10/02/2026',
        codigo: 'VALE3',
        quantidade: '5',
        preco: '60',
      });
      const auction = parseOne({
        data: '10/01/2026',
        tipo: 'Compra',
        mercado: 'Leilão',
        codigo: 'VALE3',
        quantidade: '5',
        preco: '60',
      });
      expect(term.b3Type).toBe('Compra');
      expect(auction.b3Type).toBe('Compra');
    });
  });
});
