import type { AssetClass } from '@/core/quotes/ports';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';
import type { NormalizedPositionRecord, ParsedRecord } from '@/core/ingestion/ports';
import { normalizeHeader, type DetectedStructure } from '@/adapters/ingestion/xlsx/detect';
import { cellAt, parseBrDate, parseQuantity } from '@/adapters/ingestion/xlsx/common';
import { sanitizeCells, sanitizeRow } from '@/adapters/ingestion/xlsx/strip-cpf';

/**
 * SPEC-005 BR-005-01/06/22 — Posição: the point-in-time snapshot.
 *
 * Real B3 Posição exports are a multi-tab workbook, one tab per asset class,
 * and `index.ts` calls this once per recognised sheet (#63).
 *
 * **#108 — the asset class comes from the tab.** B3's real export has no
 * `Categoria` column on any tab; the tab name is the only place the class is
 * stated. That is not DL-005-03's filename: the tab is part of the file's
 * structure, and a user renaming the download does not rename its tabs. The
 * layouts below were read from a real export's header row (never its values —
 * DV-24):
 *
 *  - `Acoes` and `Fundo de Investimento` — listed instruments, keyed by
 *    `Código de Negociação`. FIIs (and Fiagros) sit on the funds tab; there is
 *    no FII tab of its own.
 *  - `Tesouro Direto` — keyed by `Produto` (`"Tesouro Selic 2029"`), the code
 *    Movimentação's parser already gives the same title.
 *  - `Renda Fixa` — bank paper, keyed by `Código`; CDB/LCI/LCA is the prefix
 *    of `Produto` (`"CDB - BANCO …"`).
 *
 * **What the real file does not carry.** No reference date (BR-005-22's
 * `asOf` is confirmed by the user at commit — see `commit-batch.ts`), and no
 * contracted rate or amount applied on `Renda Fixa` (BR-005-06 as amended:
 * the rate is typed by the user on `/fixed-income/[assetId]`).
 *
 * A tab whose name is not one of these, and a `Renda Fixa` row that is not a
 * CDB/LCI/LCA, yields no rows rather than a guessed class: a Posição row never
 * reaches the ledger, and a wrong class would put the asset in the catalog
 * under the wrong valuation method.
 */
export function parsePosicao(
  rows: readonly (string | null)[][],
  structure: DetectedStructure,
  sheetName: string,
): readonly ParsedRecord[] {
  const tab = TAB_MAP.get(normalizeHeader(sheetName));
  if (tab === undefined) return [];

  const records: ParsedRecord[] = [];

  for (const rawCells of rows.slice(structure.headerRowIndex + 1)) {
    if (rawCells.every((cell) => cell === null)) continue;

    // BR-005-07: redact before ANY cell is read, so the NormalizedRecord
    // (which becomes parsed_payload and crosses into core/) is built from
    // sanitised text too — not just the raw payload.
    const row = sanitizeCells(rawCells);

    const produto = cellAt(row, structure.columns, 'produto');
    const quantidadeText = cellAt(row, structure.columns, 'quantidade');
    if (produto === null || quantidadeText === null) continue;

    const identity = identify(tab, produto.trim(), row, structure);
    if (identity === null) continue;

    const record: NormalizedPositionRecord = {
      kind: 'position',
      assetCode: identity.code,
      assetName: identity.name,
      assetClass: identity.assetClass,
      institutionName: cellAt(row, structure.columns, 'instituicao'),
      quantity: parseQuantity(quantidadeText, 'quantidade'),
      fixedIncome: tab === 'renda_fixa' ? readFixedIncome(row, structure) : null,
    };

    records.push({ raw: sanitizeRow(rawRowOf(row, structure)), record });
  }

  return records;
}

type Tab = { readonly listed: AssetClass } | 'tesouro' | 'renda_fixa';

/**
 * Normalised tab name → how its rows are read. `bdr`/`etf` are not in the
 * export #108 was read from (an account holding neither gets no such tab), so
 * their names are the expected ones rather than observed ones.
 */
const TAB_MAP: ReadonlyMap<string, Tab> = new Map<string, Tab>([
  ['acoes', { listed: 'stock' }],
  ['fundo de investimento', { listed: 'fii' }],
  ['bdr', { listed: 'bdr' }],
  ['bdrs', { listed: 'bdr' }],
  ['etf', { listed: 'etf' }],
  ['etfs', { listed: 'etf' }],
  ['tesouro direto', 'tesouro'],
  ['renda fixa', 'renda_fixa'],
]);

const BANK_PAPER: ReadonlyMap<string, AssetClass> = new Map([
  ['cdb', 'cdb'],
  ['lci', 'lci'],
  ['lca', 'lca'],
]);

interface Identity {
  readonly code: string;
  readonly name: string;
  readonly assetClass: AssetClass;
}

function identify(
  tab: Tab,
  produto: string,
  row: readonly (string | null)[],
  structure: DetectedStructure,
): Identity | null {
  const { code: productCode, name } = splitProduct(produto);

  if (tab === 'tesouro') {
    // `Produto` as-is, because `AssetResolverPort` keys assets by code and
    // Movimentação's parser codes the same title `"Tesouro Selic 2029"`. A
    // different code here would split one holding into two assets, and
    // reconciliation would report every Tesouro title as missing history.
    // `tesouro.sync` prices under `"Tesouro Selic 01/03/2029"` instead; aligning
    // all three waits on a real Movimentação export (#108, progress item 1).
    return { code: produto, name: produto, assetClass: 'tesouro_direto' };
  }

  if (tab === 'renda_fixa') {
    const assetClass = BANK_PAPER.get(normalizeHeader(productCode));
    if (assetClass === undefined) return null;
    const codigo = cellAt(row, structure.columns, 'codigo');
    return { code: codigo?.trim() || produto, name: produto, assetClass };
  }

  // Listed: `Código de Negociação` is the tradeable ticker, and the same code
  // Movimentação's `Produto` prefix and Negociação's own column resolve to.
  const ticker = cellAt(row, structure.columns, 'codigo de negociacao');
  return { code: ticker?.trim() || productCode, name, assetClass: tab.listed };
}

/** `"PETR4 - PETROBRAS"` → `{ code: "PETR4", name: "PETROBRAS" }`; the whole string for both when there is no separator. */
function splitProduct(produto: string): { code: string; name: string } {
  const separatorIndex = produto.indexOf(' - ');
  if (separatorIndex === -1) return { code: produto, name: produto };
  return {
    code: produto.slice(0, separatorIndex).trim(),
    name: produto.slice(separatorIndex + 3).trim(),
  };
}

const INDEXER_MAP: ReadonlyMap<string, FixedIncomeIndexer> = new Map([
  ['cdi', 'cdi_percent'],
  ['di', 'cdi_percent'],
  ['% cdi', 'cdi_percent'],
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
  const emissaoText = cellAt(row, structure.columns, 'data de emissao');
  const vencimentoText = cellAt(row, structure.columns, 'vencimento');

  return {
    // BR-009-13: an indexer text this map does not know is unreadable rather
    // than guessed — the rate form asks for it alongside the rate.
    indexer:
      indexadorText === null ? null : (INDEXER_MAP.get(normalizeHeader(indexadorText)) ?? null),
    // SPEC-005 BR-005-06 (amended, #108): the real `Renda Fixa` tab carries no
    // contracted rate. It is typed by the user, and `upsertByAsset` keeps a
    // rate already typed when a later Posição arrives with none.
    ratePercent: null,
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
    // No `Valor Aplicado` on the real tab. Accrual reads principal from the
    // ledger, never this field (`core/valuation/accrual.ts`).
    principal: null,
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
