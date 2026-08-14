import { describe, expect, it } from 'vitest';
import { detectExtractType, normalizeHeader } from '@/adapters/ingestion/xlsx/detect';

const MOVIMENTACAO_HEADER = [
  'Entrada/Saída',
  'Data',
  'Movimentação',
  'Produto',
  'Instituição',
  'Quantidade',
  'Preço unitário',
  'Valor da Operação',
];
const NEGOCIACAO_HEADER = [
  'Data do Negócio',
  'Tipo',
  'Mercado',
  'Código de Negociação',
  'Quantidade',
  'Preço',
  'Valor',
];
const POSICAO_HEADER = ['Produto', 'Instituição', 'Categoria', 'Quantidade', 'Data de Referência'];

describe('SPEC-005 BR-005-03/04 — detectExtractType', () => {
  it('identifies Movimentação by structure alone (filename plays no part — DL-005-03)', () => {
    const result = detectExtractType([MOVIMENTACAO_HEADER, ['C', '2026-01-10', 'Compra', 'PETR4']]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_movimentacao');
    expect(result.value.headerRowIndex).toBe(0);
  });

  it('identifies Negociação', () => {
    const result = detectExtractType([NEGOCIACAO_HEADER, ['2026-01-10', 'Compra', 'Bovespa']]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_negociacao');
  });

  it('identifies Posição', () => {
    const result = detectExtractType([POSICAO_HEADER, ['PETR4', 'Corretora', 'Ações', '100']]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_posicao');
  });

  it('BR-005-04: tolerates leading metadata rows before the real header', () => {
    const rows = [
      ['Extrato de Movimentação'],
      ['Titular: Fulano de Tal'],
      ['Período: 01/01/2026 a 31/03/2026'],
      MOVIMENTACAO_HEADER,
      ['C', '2026-01-10', 'Compra', 'PETR4'],
    ];
    const result = detectExtractType(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_movimentacao');
    expect(result.value.headerRowIndex).toBe(3);
  });

  it('BR-005-04: column order does not matter — B3 reordering columns must not break the parser', () => {
    const reordered = [...MOVIMENTACAO_HEADER].reverse();
    const result = detectExtractType([reordered]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extractType).toBe('b3_movimentacao');
    // The column map still resolves each header to its actual (reversed) index.
    expect(result.value.columns.get('produto')).toBe(reordered.indexOf('Produto'));
  });

  it('BR-005-05: an unparseable file names what was expected, not a generic failure', () => {
    const result = detectExtractType([['Random', 'Spreadsheet', 'Columns']]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INGESTION_UNRECOGNIZED_STRUCTURE');
    expect(result.error.context['expected']).toBeDefined();
  });

  it('BR-005-05: a header row matching a schema only partially is still a specific, named error', () => {
    const partial = MOVIMENTACAO_HEADER.slice(0, 4); // missing half the required columns
    const result = detectExtractType([partial]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INGESTION_UNRECOGNIZED_STRUCTURE');
    expect(result.error.context['closestMatch']).toBeDefined();
  });

  it('an empty sheet is unrecognisable', () => {
    const result = detectExtractType([]);
    expect(result.ok).toBe(false);
  });

  it('normalizeHeader folds case, accents and whitespace', () => {
    expect(normalizeHeader('  Preço   Unitário ')).toBe('preco unitario');
  });
});
