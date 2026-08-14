import { describe, expect, it } from 'vitest';
import { detectExtractType } from '@/adapters/ingestion/xlsx/detect';
import { parsePosicao } from '@/adapters/ingestion/xlsx/posicao';
import { POSICAO_HEADERS, posicaoRow } from '@/adapters/ingestion/xlsx/test-support/builder';

function rowsFor(records: readonly Record<string, string>[]): (string | null)[][] {
  return [
    [...POSICAO_HEADERS],
    ...records.map((r) => [...POSICAO_HEADERS].map((h) => r[h] ?? null)),
  ];
}

function structureOf(rows: (string | null)[][]) {
  const detected = detectExtractType(rows);
  if (!detected.ok) throw new Error('detect failed in test setup');
  return detected.value;
}

describe('SPEC-005 — parsePosicao', () => {
  it('parses a stock position with no fixed-income details', () => {
    const rows = rowsFor([
      posicaoRow({
        produto: 'PETR4',
        categoria: 'Ações',
        quantidade: '100',
        dataReferencia: '01/03/2026',
      }),
    ]);
    const records = parsePosicao(rows, structureOf(rows));

    expect(records).toHaveLength(1);
    const record = records[0]?.record;
    if (record?.kind !== 'position') throw new Error('expected a position record');
    expect(record.assetCode).toBe('PETR4');
    expect(record.assetClass).toBe('stock');
    expect(record.quantity.toString()).toBe('100');
    expect(record.asOf).toBe('2026-03-01');
    expect(record.fixedIncome).toBeNull();
  });

  it('BR-005-06: extracts indexer, rate, issue and maturity date for a CDB row', () => {
    const rows = rowsFor([
      posicaoRow({
        produto: 'CDB Banco Teste',
        categoria: 'CDB',
        quantidade: '1',
        dataReferencia: '01/03/2026',
        indexador: 'CDI',
        taxaContratada: '110',
        dataEmissao: '01/01/2024',
        vencimento: '01/01/2027',
        valorAplicado: '10000',
      }),
    ]);
    const records = parsePosicao(rows, structureOf(rows));
    const record = records[0]?.record;
    if (record?.kind !== 'position') throw new Error('expected a position record');
    expect(record.assetClass).toBe('cdb');
    expect(record.fixedIncome).not.toBeNull();
    expect(record.fixedIncome?.indexer).toBe('cdi_percent');
    expect(record.fixedIncome?.ratePercent?.toString()).toBe('110');
    expect(record.fixedIncome?.issueDate).toBe('2024-01-01');
    expect(record.fixedIncome?.maturityDate).toBe('2027-01-01');
    expect(record.fixedIncome?.principal?.toString()).toBe('10000');
  });

  it('BR-009-13: a CDB row missing an issue date still parses, with fixedIncome.issueDate null', () => {
    const rows = rowsFor([
      posicaoRow({
        produto: 'CDB Banco Teste',
        categoria: 'CDB',
        quantidade: '1',
        dataReferencia: '01/03/2026',
        indexador: 'CDI',
        taxaContratada: '110',
      }),
    ]);
    const records = parsePosicao(rows, structureOf(rows));
    const record = records[0]?.record;
    if (record?.kind !== 'position') throw new Error('expected a position record');
    expect(record.fixedIncome?.issueDate).toBeNull();
  });

  it('an unrecognised category falls back to stock rather than failing the whole row', () => {
    const rows = rowsFor([
      posicaoRow({
        produto: 'XYZ',
        categoria: 'Algo Novo',
        quantidade: '1',
        dataReferencia: '01/03/2026',
      }),
    ]);
    const records = parsePosicao(rows, structureOf(rows));
    expect(records[0]?.record.assetClass).toBe('stock');
  });
});
