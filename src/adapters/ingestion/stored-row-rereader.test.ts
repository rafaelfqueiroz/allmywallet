import { describe, expect, it } from 'vitest';
import type { NormalizedTransactionRecord, ParsedRecord } from '@/core/ingestion/ports';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx/index';
import { XlsxImportRowRereader } from '@/adapters/ingestion/stored-row-rereader';
import {
  buildMovimentacaoXlsx,
  type MovimentacaoRowInput,
} from '@/adapters/ingestion/xlsx/test-support/builder';

/**
 * SPEC-022 BR-022-35 (#215) — a stored `raw_payload` read again gives what
 * today's parser gives for the same B3 row. Generated extracts only (DV-24).
 */
async function parsed(row: MovimentacaoRowInput): Promise<ParsedRecord> {
  const result = await new XlsxIngestionPort().parse(await buildMovimentacaoXlsx([row]));
  if (!result.ok) throw new Error(`fixture did not parse: ${result.error.code}`);
  const [record] = result.value.records;
  if (record === undefined) throw new Error('fixture produced no record');
  return record;
}

const rereader = new XlsxImportRowRereader();

describe('XlsxImportRowRereader', () => {
  it('reads a stored row back to the record the parser produced from the file', async () => {
    const { raw, record } = await parsed({
      data: '05/01/2026',
      movimentacao: 'Dividendo',
      produto: 'PETR4 - PETROBRAS PN',
      instituicao: 'CORRETORA SINTÉTICA',
      quantidade: '100',
      precoUnitario: '0,50',
      valorOperacao: '50,00',
    });

    expect(rereader.reread('b3_movimentacao', raw)).toEqual(record);
  });

  it('prices a payment from its stated total, which an earlier parse left price-less (#192)', async () => {
    const { raw } = await parsed({
      data: '20/05/2026',
      movimentacao: 'Dividendo',
      produto: 'GRND3 - GRENDENE ON',
      instituicao: 'CORRETORA SINTÉTICA',
      quantidade: '300',
      precoUnitario: '-',
      valorOperacao: '33,00',
    });

    const current = rereader.reread('b3_movimentacao', raw) as NormalizedTransactionRecord;

    expect(current.priceStated).toBe(true);
    expect(current.priceDerivedFromTotal).toBe(true);
    expect(current.unitPrice.toString()).toBe('0.11');
  });

  it('keeps a blank cell blank, as the parser read it', async () => {
    const { raw } = await parsed({
      data: '20/05/2026',
      movimentacao: 'Transferência',
      produto: 'RECT12 - DIREITO SINTÉTICO',
      instituicao: 'CORRETORA SINTÉTICA',
      quantidade: '10',
      precoUnitario: '',
      valorOperacao: '',
    });

    const current = rereader.reread('b3_movimentacao', raw) as NormalizedTransactionRecord;

    expect(current.priceStated).toBe(false);
  });

  it('has no re-reading for Negociação or Posição', async () => {
    const { raw } = await parsed({
      data: '05/01/2026',
      movimentacao: 'Dividendo',
      produto: 'PETR4 - PETROBRAS PN',
      quantidade: '100',
    });

    expect(rereader.reread('b3_negociacao', raw)).toBeNull();
    expect(rereader.reread('b3_posicao', raw)).toBeNull();
  });

  it('returns null rather than throwing for cells the parser now refuses, or none at all', async () => {
    const { raw } = await parsed({
      data: '05/01/2026',
      movimentacao: 'Dividendo',
      produto: 'PETR4 - PETROBRAS PN',
      quantidade: '100',
    });

    expect(rereader.reread('b3_movimentacao', { ...raw, quantidade: 'cem' })).toBeNull();
    expect(rereader.reread('b3_movimentacao', {})).toBeNull();
  });
});
