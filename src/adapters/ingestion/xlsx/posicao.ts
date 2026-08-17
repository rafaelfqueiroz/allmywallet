import { Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';
import type { NormalizedPositionRecord, ParsedRecord } from '@/core/ingestion/ports';
import type { DetectedStructure } from '@/adapters/ingestion/xlsx/detect';
import {
  cellAt,
  parseBrDate,
  parseBrDecimal,
  parseMoney,
  parseQuantity,
} from '@/adapters/ingestion/xlsx/common';
import { sanitizeCells, sanitizeRow } from '@/adapters/ingestion/xlsx/strip-cpf';

/**
 * SPEC-005 BR-005-01/06/22 — Posição: the point-in-time snapshot, and the
 * only source of contracted fixed-income rates.
 *
 * Real B3 Posição exports are a multi-tab workbook (one tab per asset
 * class). This parser reads a **single consolidated sheet** with a
 * `Categoria` column carrying that same information instead — a documented
 * scope cut (see the dispatch report's Decision log), not a fidelity gap
 * this file tries to hide: BR-005-06's contract extraction and BR-005-22's
 * reconciliation input both work identically either way, since neither
 * depends on which physical tab a row came from.
 */
export function parsePosicao(
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

    const produto = cellAt(row, structure.columns, 'produto');
    const categoria = cellAt(row, structure.columns, 'categoria');
    const quantidadeText = cellAt(row, structure.columns, 'quantidade');
    const asOfText = cellAt(row, structure.columns, 'data de referencia');
    if (produto === null || categoria === null || quantidadeText === null || asOfText === null) {
      continue;
    }

    const assetClass = classifyCategoria(categoria);

    const record: NormalizedPositionRecord = {
      kind: 'position',
      assetCode: produto.trim(),
      assetName: produto.trim(),
      assetClass,
      institutionName: cellAt(row, structure.columns, 'instituicao'),
      quantity: parseQuantity(quantidadeText, 'quantidade'),
      asOf: parseBrDate(asOfText, 'data de referencia'),
      fixedIncome: isFixedIncome(assetClass) ? readFixedIncome(row, structure) : null,
    };

    records.push({ raw: sanitizeRow(rawRowOf(row, structure)), record });
  }

  return records;
}

const CATEGORY_MAP: ReadonlyMap<string, AssetClass> = new Map([
  ['acoes', 'stock'],
  ['acao', 'stock'],
  ['fii', 'fii'],
  ['fiis', 'fii'],
  ['bdr', 'bdr'],
  ['bdrs', 'bdr'],
  ['etf', 'etf'],
  ['tesouro direto', 'tesouro_direto'],
  ['cdb', 'cdb'],
  ['lci', 'lci'],
  ['lca', 'lca'],
]);

function classifyCategoria(categoria: string): AssetClass {
  const normalized = categoria
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
  return CATEGORY_MAP.get(normalized) ?? 'stock';
}

function isFixedIncome(assetClass: AssetClass): boolean {
  return assetClass === 'cdb' || assetClass === 'lci' || assetClass === 'lca';
}

const INDEXER_MAP: ReadonlyMap<string, FixedIncomeIndexer> = new Map([
  ['cdi', 'cdi_percent'],
  ['prefixado', 'prefixado'],
  ['pre', 'prefixado'],
  ['ipca', 'ipca_spread'],
  ['ipca+', 'ipca_spread'],
]);

function readFixedIncome(
  row: readonly (string | null)[],
  structure: DetectedStructure,
): NormalizedPositionRecord['fixedIncome'] {
  const indexadorText = cellAt(row, structure.columns, 'indexador');
  const taxaText = cellAt(row, structure.columns, 'taxa contratada');
  const emissaoText = cellAt(row, structure.columns, 'data de emissao');
  const vencimentoText = cellAt(row, structure.columns, 'vencimento');
  const valorAplicadoText = cellAt(row, structure.columns, 'valor aplicado');

  const indexer =
    indexadorText === null
      ? null
      : (INDEXER_MAP.get(
          indexadorText
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .trim()
            .toLowerCase(),
        ) ?? null);

  return {
    indexer,
    ratePercent:
      taxaText === null || taxaText === ''
        ? null
        : Quantity.fromString(parseBrDecimal(taxaText, 'taxa contratada')),
    // BR-009-13: unreadable rather than assumed — `commit-batch.ts` refuses
    // to create a contract with no issue date at all.
    issueDate:
      emissaoText === null || emissaoText === ''
        ? null
        : parseBrDate(emissaoText, 'data de emissao'),
    maturityDate:
      vencimentoText === null || vencimentoText === ''
        ? null
        : parseBrDate(vencimentoText, 'vencimento'),
    principal:
      valorAplicadoText === null || valorAplicadoText === ''
        ? null
        : parseMoney(valorAplicadoText, 'valor aplicado'),
  };
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
