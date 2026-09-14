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
 * #108 — read against B3's real export (header names only, never values):
 * `Data do Negócio · Tipo de Movimentação · Mercado · Prazo/Vencimento ·
 * Instituição · Código de Negociação · Quantidade · Preço · Valor`.
 *
 *  - **Institution is a column**, not implied by the account. Reading it is
 *    what lets BR-005-14's natural key see Movimentação's copy of the same
 *    trade as the same trade, and lets reconciliation line a Negociação
 *    position up with Posição's `(asset, institution)`.
 *  - **Fractional-market trades carry an `F` suffix** (`PETR4F`). It names the
 *    market, not the instrument, so it is stripped: a lot bought on the
 *    fractional market is the same share as one bought on the spot market.
 *  - **Term and auction rows** (`Prazo/Vencimento` set, `Mercado` = `Leilão`)
 *    import as ordinary buys and sells — owner's decision, #108 Decision log.
 *
 * No separate asset name, so the ticker doubles as one; `AssetResolverPort`
 * never lets that overwrite a name an extract that states one already set.
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

    const tipo = cellAt(row, structure.columns, 'tipo de movimentacao') ?? '';
    const ticker = spotTicker(codigo);

    const record: NormalizedTransactionRecord = {
      kind: 'transaction',
      b3Type: tipo,
      direction: null, // Negociação's `Tipo de Movimentação` (Compra/Venda) needs no disambiguation.
      assetCode: ticker,
      assetName: ticker,
      assetClass: guessAssetClass(ticker),
      institutionName: cellAt(row, structure.columns, 'instituicao'),
      tradeDate: parseBrDate(dataText, 'data do negocio'),
      quantity: parseQuantity(quantidadeText, 'quantidade'),
      unitPrice: parseMoney(precoText, 'preco'),
      priceStated: true,
      fees: Money.zero(),
      ratio: null,
    };

    records.push({ raw: sanitizeRow(rawRowOf(row, structure)), record });
  }

  return records;
}

/** `"PETR4F"` → `"PETR4"`, `"B3SA3F"` → `"B3SA3"`; any other code unchanged. */
function spotTicker(codigo: string): string {
  const trimmed = codigo.trim();
  const fractional = /^([A-Z0-9]{4}\d{1,2})F$/.exec(trimmed);
  return fractional?.[1] ?? trimmed;
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
