import { Money } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedRecord } from '@/core/ingestion/ports';
import type { DetectedStructure } from '@/adapters/ingestion/xlsx/detect';
import { cellAt, parseBrDate, parseMoney, parseQuantity } from '@/adapters/ingestion/xlsx/common';
import { sanitizeCells, sanitizeRow } from '@/adapters/ingestion/xlsx/strip-cpf';
import { guessAssetClass } from '@/adapters/ingestion/xlsx/movimentacao';

/**
 * SPEC-005 BR-005-01 — Negociação: the authoritative trade record, with the
 * ticker already in tradeable form (`codigo de negociacao`) rather than
 * Movimentação's free-text `"CODE - Name"` product string.
 *
 * Negociação carries no institution column (trades are scoped to the
 * account the extract was exported for, not stated per row) and no separate
 * asset name — both are documented simplifications, not B3 fidelity gaps
 * this parser tries to paper over.
 */
export function parseNegociacao(
  rows: readonly (string | null)[][],
  structure: DetectedStructure,
): readonly ParsedRecord[] {
  const records: ParsedRecord[] = [];

  for (const rawCells of rows.slice(structure.headerRowIndex + 1)) {
    if (rawCells.every((cell) => cell === null)) continue;

    // BR-005-07: redact before ANY cell is read, so the NormalizedRecord
    // (which becomes parsed_payload and crosses into core/) is built from
    // sanitised text too — not just the raw payload.
    const row = sanitizeCells(rawCells);

    const codigo = cellAt(row, structure.columns, 'codigo de negociacao');
    const dataText = cellAt(row, structure.columns, 'data do negocio');
    const quantidadeText = cellAt(row, structure.columns, 'quantidade');
    const precoText = cellAt(row, structure.columns, 'preco');
    if (codigo === null || dataText === null || quantidadeText === null || precoText === null) {
      continue;
    }

    const tipo = cellAt(row, structure.columns, 'tipo') ?? '';

    const record: NormalizedTransactionRecord = {
      kind: 'transaction',
      b3Type: tipo,
      direction: null, // Negociação's `Tipo` (Compra/Venda) needs no disambiguation.
      assetCode: codigo.trim(),
      assetName: codigo.trim(),
      assetClass: guessAssetClass(codigo),
      institutionName: null,
      tradeDate: parseBrDate(dataText),
      quantity: parseQuantity(quantidadeText),
      unitPrice: parseMoney(precoText),
      fees: Money.zero(),
      ratio: null,
    };

    records.push({ raw: sanitizeRow(rawRowOf(row, structure)), record });
  }

  return records;
}

function rawRowOf(
  row: readonly (string | null)[],
  structure: DetectedStructure,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [header, index] of structure.columns) {
    raw[header] = row[index] ?? '';
  }
  return raw;
}
