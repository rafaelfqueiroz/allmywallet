import { Money } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { NormalizedTransactionRecord, ParsedRecord } from '@/core/ingestion/ports';
import type { DetectedStructure } from '@/adapters/ingestion/xlsx/detect';
import { cellAt, parseBrDate, parseMoney, parseQuantity } from '@/adapters/ingestion/xlsx/common';
import { sanitizeCells, sanitizeRow } from '@/adapters/ingestion/xlsx/strip-cpf';

/**
 * SPEC-005 BR-005-01 — Movimentação: the richest source (earnings, splits,
 * subscriptions, transfers, amortisations) but the one with the least
 * structured product/type information, which is what `core/ingestion/
 * movement-map.ts` and the asset-class heuristic below exist to interpret.
 *
 * BR-005-07: `sanitizeRow` runs on every cell **before** `raw` is built —
 * the row that reaches `import_rows.raw_payload` is already CPF-free.
 */
export function parseMovimentacao(
  rows: readonly (string | null)[][],
  structure: DetectedStructure,
): readonly ParsedRecord[] {
  const records: ParsedRecord[] = [];

  for (const rawCells of rows.slice(structure.headerRowIndex + 1)) {
    if (rawCells.every((cell) => cell === null)) continue; // a trailing blank row

    // BR-005-07: redact before ANY cell is read, so the NormalizedRecord
    // (which becomes parsed_payload and crosses into core/) is built from
    // sanitised text too — not just the raw payload.
    const row = sanitizeCells(rawCells);

    const produto = cellAt(row, structure.columns, 'produto');
    const dataText = cellAt(row, structure.columns, 'data');
    const quantidadeText = cellAt(row, structure.columns, 'quantidade');
    if (produto === null || dataText === null || quantidadeText === null) continue;

    const { code, name } = splitProduct(produto);
    const b3Type = cellAt(row, structure.columns, 'movimentacao') ?? '';
    const precoText = cellAt(row, structure.columns, 'preco unitario');
    const direction = parseDirection(cellAt(row, structure.columns, 'entrada/saida'));

    const record: NormalizedTransactionRecord = {
      kind: 'transaction',
      b3Type,
      direction,
      assetCode: code,
      assetName: name,
      assetClass: guessAssetClass(code),
      institutionName: cellAt(row, structure.columns, 'instituicao'),
      tradeDate: parseBrDate(dataText),
      quantity: parseQuantity(quantidadeText),
      unitPrice: precoText === null || precoText === '' ? Money.zero() : parseMoney(precoText),
      // Movimentação carries no distinct fee column — see `negociacao.ts` for
      // where B3 actually states fees (BR-005-01's "authoritative trade
      // record"). Corretagem/nota-de-corretagem parsing is explicitly out of
      // scope (SPEC-005 "Out of Scope").
      fees: Money.zero(),
      ratio: null,
    };

    records.push({ raw: sanitizeRow(rawRowOf(row, structure)), record });
  }

  return records;
}

function parseDirection(text: string | null): 'credit' | 'debit' | null {
  if (text === null) return null;
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith('cred')) return 'credit';
  if (normalized.startsWith('deb')) return 'debit';
  return null;
}

/** `"PETR4 - Petrobras PN"` → `{ code: "PETR4", name: "Petrobras PN" }`. Falls back to the whole string when there is no separator. */
function splitProduct(produto: string): { code: string; name: string } {
  const separatorIndex = produto.indexOf(' - ');
  if (separatorIndex === -1) return { code: produto.trim(), name: produto.trim() };
  return {
    code: produto.slice(0, separatorIndex).trim(),
    name: produto.slice(separatorIndex + 3).trim(),
  };
}

/**
 * Neither Movimentação nor Negociação states an asset's class — B3 does not
 * carry it in either extract. This is a documented heuristic, not a lookup:
 * a ticker ending `11` is a FII/unit, an ending like `34`/`35` reads as a
 * BDR, everything else defaults to `stock`. Wrong for an ETF or Tesouro
 * Direto row (which this heuristic reads as `stock`) — acceptable because
 * `AssetResolverPort.resolve` is an upsert (BR-005-06), so a later, more
 * informed write (or a manual correction) can still fix the classification
 * without this parser needing to be a full B3 instrument reference.
 */
function guessAssetClass(code: string): AssetClass {
  const trimmed = code.trim().toUpperCase();
  if (/\d{2}$/.test(trimmed) && trimmed.endsWith('11')) return 'fii';
  if (/3[2-9]$/.test(trimmed)) return 'bdr';
  return 'stock';
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

export { guessAssetClass, splitProduct };
