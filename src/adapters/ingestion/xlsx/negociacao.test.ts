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
});
