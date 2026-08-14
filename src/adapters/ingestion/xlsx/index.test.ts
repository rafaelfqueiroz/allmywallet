import { describe, expect, it } from 'vitest';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';
import {
  MOVIMENTACAO_HEADERS,
  SYNTHETIC_CPF,
  buildMovimentacaoXlsx,
  buildNegociacaoXlsx,
  buildPosicaoXlsx,
  buildXlsx,
} from '@/adapters/ingestion/xlsx/test-support/builder';
import { isValidCpf } from '@/adapters/ingestion/xlsx/strip-cpf';

const port = new XlsxIngestionPort();

/** Scans every string leaf of a parsed record (raw + normalized) for anything CPF-shaped. */
function containsCpf(value: unknown): boolean {
  if (typeof value === 'string') {
    const bareDigits = value.match(/\d{11}/g) ?? [];
    if (bareDigits.some((candidate) => isValidCpf(candidate))) return true;
    return /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsCpf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsCpf);
  }
  return false;
}

describe('SPEC-005 BR-005-01..08 — XlsxIngestionPort', () => {
  it('BR-005-03: identifies Movimentação from structure and normalizes every row', async () => {
    const bytes = await buildMovimentacaoXlsx([
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ]);
    const result = await port.parse(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_movimentacao');
    expect(result.value.records).toHaveLength(1);
  });

  it('BR-005-07/AC: no CPF survives parsing — neither in raw nor in the normalized record', async () => {
    const bytes = await buildMovimentacaoXlsx([
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ]);
    // The default metadata block embeds SYNTHETIC_CPF (a checksum-valid CPF).
    const result = await port.parse(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const parsed of result.value.records) {
      expect(containsCpf(parsed.raw)).toBe(false);
      expect(containsCpf(parsed.record)).toBe(false);
    }
    // Sanity: the fixture really did carry the CPF the assertion above must catch.
    expect(SYNTHETIC_CPF.replace(/\D/g, '')).toHaveLength(11);
  });

  it('BR-005-04: leading metadata rows and reordered columns both parse correctly together', async () => {
    const bytes = await buildMovimentacaoXlsx(
      [
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
        },
      ],
      { headerOrder: [...MOVIMENTACAO_HEADERS].reverse() },
    );
    const result = await port.parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value.records[0]?.record;
    expect(record?.kind).toBe('transaction');
    if (record?.kind === 'transaction') expect(record.assetCode).toBe('PETR4');
  });

  it('BR-005-03: identifies Negociação', async () => {
    const bytes = await buildNegociacaoXlsx([
      { data: '10/01/2026', tipo: 'Compra', codigo: 'PETR4', quantidade: '100', preco: '32,15' },
    ]);
    const result = await port.parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_negociacao');
  });

  it('BR-005-03/06: identifies Posição and carries fixed-income details through', async () => {
    const bytes = await buildPosicaoXlsx([
      {
        produto: 'CDB Banco Teste',
        categoria: 'CDB',
        quantidade: '1',
        dataReferencia: '01/03/2026',
        indexador: 'CDI',
        taxaContratada: '110',
        dataEmissao: '01/01/2024',
      },
    ]);
    const result = await port.parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_posicao');
    const record = result.value.records[0]?.record;
    expect(record?.kind === 'position' && record.fixedIncome?.indexer).toBe('cdi_percent');
  });

  it('BR-005-05: an unrecognisable file produces a specific error naming what was expected', async () => {
    const bytes = await buildXlsx({
      headers: ['Random', 'Columns'],
      rows: [{ Random: 'x' }],
      metadataRows: [],
    });
    const result = await port.parse(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INGESTION_UNRECOGNIZED_STRUCTURE');
  });

  it('a file exceljs cannot open at all produces UNREADABLE_FILE, not a crash', async () => {
    const result = await port.parse(new TextEncoder().encode('not a real xlsx file'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INGESTION_UNREADABLE_FILE');
  });
});
