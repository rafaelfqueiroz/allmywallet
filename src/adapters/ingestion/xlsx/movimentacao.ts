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
    // #108: B3 writes a lone `-` where an event carries no price (custody
    // transfers, rights, splits). Read only here, not in `cellAt`: in a
    // required column a `-` must still fail the file rather than drop the row.
    const precoText = cellAt(row, structure.columns, 'preco unitario')?.trim() ?? null;
    const priceStated = precoText !== null && precoText !== '' && precoText !== '-';
    const direction = parseDirection(cellAt(row, structure.columns, 'entrada/saida'));

    const record: NormalizedTransactionRecord = {
      kind: 'transaction',
      b3Type,
      direction,
      assetCode: code,
      assetName: name,
      assetClass: guessAssetClass(code),
      institutionName: cellAt(row, structure.columns, 'instituicao'),
      tradeDate: parseBrDate(dataText, 'data'),
      quantity: parseQuantity(quantidadeText, 'quantidade'),
      unitPrice:
        priceStated && precoText !== null ? parseMoney(precoText, 'preco unitario') : Money.zero(),
      priceStated,
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

/**
 * `"PETR4 - Petrobras PN"` → `{ code: "PETR4", name: "Petrobras PN" }`. Falls back to the whole string when there is no separator.
 *
 * #115: bank paper states its B3 code after the prefix — `"CDB - CDB6269CPH4"`,
 * or `"CDB - CDBA256IQS1 - BANCO INTER S/A"` — and that is the `Código` Posição's
 * `Renda Fixa` tab keys the same paper by. Read whole, the ledger held every
 * application on one asset and every snapshot on another, and reconciliation
 * computed zero. `0020_merge_bank_paper_assets.sql` carries the same pattern.
 *
 * #108: bank paper with no code (`"CDB - BANCO EXEMPLO S/A"`) keeps the whole
 * string. Split like a ticker, every CDB, LCI and LCA at every bank became one
 * asset called `CDB`.
 */
function splitProduct(produto: string): { code: string; name: string } {
  const bankPaper = BANK_PAPER_CODE.exec(produto.trim());
  if (bankPaper !== null) {
    const [, prefix, code, issuer] = bankPaper;
    return {
      code: code as string,
      name: issuer === undefined ? produto.trim() : `${prefix} - ${issuer.trim()}`,
    };
  }
  const separatorIndex = produto.indexOf(' - ');
  if (separatorIndex === -1 || BANK_PAPER_PREFIX.test(produto)) {
    return { code: produto.trim(), name: produto.trim() };
  }
  return {
    code: produto.slice(0, separatorIndex).trim(),
    name: produto.slice(separatorIndex + 3).trim(),
  };
}

/**
 * Neither Movimentação nor Negociação states an asset's class — B3 does not
 * carry it in either extract. This is a documented heuristic, not a lookup:
 * a ticker ending `11` is a FII/unit, an ending like `34`/`35` reads as a
 * BDR, everything else defaults to `stock`. Tesouro titles and bank paper are
 * recognised by their `Produto` shape (#108). Still wrong for an ETF or a unit
 * (`TAEE11` reads as a FII) — acceptable because it is only ever a *guess*:
 * `AssetResolverPort` never lets a guess overwrite a class already stated, and
 * Posição, which states classes, always overwrites a guess (#108).
 */
const BANK_PAPER_PREFIX = /^(CDB|LCI|LCA) - /i;

/**
 * #115: `<PREFIX> - <CODE>[ - <ISSUER>]`, where the code is one word that
 * repeats the prefix (`CDB6269CPH4`). An issuer name has spaces, so
 * `"CDB - BANCO EXEMPLO S/A"` does not match.
 */
const BANK_PAPER_CODE = /^(CDB|LCI|LCA) - ((?:CDB|LCI|LCA)[A-Z0-9]{5,})(?: - (.+))?$/i;

/**
 * A bank-paper code standing alone. Eight characters or more, so a ticker that
 * happens to start the same way (`LCAM3`) still reads as a stock.
 */
const BANK_PAPER_CODE_ALONE = /^(CDB|LCI|LCA)[A-Z0-9]{5,}$/;

function guessAssetClass(code: string): AssetClass {
  const trimmed = code.trim().toUpperCase();
  if (trimmed.startsWith('TESOURO ')) return 'tesouro_direto';
  const bankPaper =
    BANK_PAPER_PREFIX.exec(trimmed)?.[1] ?? BANK_PAPER_CODE_ALONE.exec(trimmed)?.[1];
  if (bankPaper !== undefined) return bankPaper.toLowerCase() as AssetClass;
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
