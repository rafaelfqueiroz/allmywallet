import ExcelJS from 'exceljs';

/**
 * TS-19/TS-20/TS-21 — a builder that emits **structurally faithful,
 * synthetic** `.xlsx` files: real column names and layout, invented data.
 *
 * A real B3 extract must never enter this repository (DV-24) — it carries a
 * real CPF and real holdings. Every fixture used by this feature's tests is
 * generated here, including a CPF field so BR-005-07's stripping is
 * testable, and covers the awkward cases deliberately: leading metadata
 * rows, reordered columns, an unknown movement type, and two genuine
 * identical same-day trades.
 */

export interface BuildSheetOptions {
  /** Column headers, in display case — normalisation happens in `detect.ts`, not here. */
  readonly headers: readonly string[];
  /** Row values keyed by header text; a row is written in `headers`' order. */
  readonly rows: readonly Readonly<Record<string, string>>[];
  /**
   * Leading rows before the header row — B3 extracts open with an
   * account-holder block. Each entry is written into column A of its own
   * row. Defaults to a synthetic holder block **including a CPF**, so a test
   * asserting BR-005-07 without opting out still exercises stripping.
   */
  readonly metadataRows?: readonly string[];
  /** When set, headers are written in this order instead of `headers`' own — BR-005-04's reordering case. */
  readonly headerOrder?: readonly string[];
}

/** A checksum-valid, synthetic CPF — see `strip-cpf.test.ts` for the same value's provenance. */
export const SYNTHETIC_CPF = '111.444.777-35';

export function defaultMetadataRows(): readonly string[] {
  return ['Extrato B3 — Área do Investidor', `Titular: Fulano de Tal — CPF: ${SYNTHETIC_CPF}`, ''];
}

export async function buildXlsx(options: BuildSheetOptions): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Extrato');

  for (const line of options.metadataRows ?? defaultMetadataRows()) {
    sheet.addRow([line]);
  }

  const headerOrder = options.headerOrder ?? options.headers;
  sheet.addRow([...headerOrder]);

  for (const row of options.rows) {
    sheet.addRow(headerOrder.map((header) => row[header] ?? ''));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export const MOVIMENTACAO_HEADERS = [
  'Entrada/Saída',
  'Data',
  'Movimentação',
  'Produto',
  'Instituição',
  'Quantidade',
  'Preço unitário',
  'Valor da Operação',
] as const;

export interface MovimentacaoRowInput {
  readonly entradaSaida?: string;
  readonly data: string;
  readonly movimentacao: string;
  readonly produto: string;
  readonly instituicao?: string;
  readonly quantidade: string;
  readonly precoUnitario?: string;
  readonly valorOperacao?: string;
}

export function movimentacaoRow(input: MovimentacaoRowInput): Record<string, string> {
  return {
    'Entrada/Saída': input.entradaSaida ?? 'Credito',
    Data: input.data,
    Movimentação: input.movimentacao,
    Produto: input.produto,
    Instituição: input.instituicao ?? 'Corretora Teste',
    Quantidade: input.quantidade,
    'Preço unitário': input.precoUnitario ?? '0',
    'Valor da Operação': input.valorOperacao ?? '0',
  };
}

export async function buildMovimentacaoXlsx(
  rows: readonly MovimentacaoRowInput[],
  options: Partial<BuildSheetOptions> = {},
): Promise<Uint8Array> {
  return buildXlsx({
    headers: [...MOVIMENTACAO_HEADERS],
    rows: rows.map(movimentacaoRow),
    ...options,
  });
}

export const NEGOCIACAO_HEADERS = [
  'Data do Negócio',
  'Tipo',
  'Mercado',
  'Código de Negociação',
  'Quantidade',
  'Preço',
  'Valor',
] as const;

export interface NegociacaoRowInput {
  readonly data: string;
  readonly tipo: string;
  readonly mercado?: string;
  readonly codigo: string;
  readonly quantidade: string;
  readonly preco: string;
  readonly valor?: string;
}

export function negociacaoRow(input: NegociacaoRowInput): Record<string, string> {
  return {
    'Data do Negócio': input.data,
    Tipo: input.tipo,
    Mercado: input.mercado ?? 'Bovespa',
    'Código de Negociação': input.codigo,
    Quantidade: input.quantidade,
    Preço: input.preco,
    Valor: input.valor ?? '0',
  };
}

export async function buildNegociacaoXlsx(
  rows: readonly NegociacaoRowInput[],
  options: Partial<BuildSheetOptions> = {},
): Promise<Uint8Array> {
  return buildXlsx({
    headers: [...NEGOCIACAO_HEADERS],
    rows: rows.map(negociacaoRow),
    ...options,
  });
}

export const POSICAO_HEADERS = [
  'Produto',
  'Instituição',
  'Categoria',
  'Quantidade',
  'Data de Referência',
  'Indexador',
  'Taxa Contratada',
  'Data de Emissão',
  'Vencimento',
  'Valor Aplicado',
] as const;

export interface PosicaoRowInput {
  readonly produto: string;
  readonly instituicao?: string;
  readonly categoria: string;
  readonly quantidade: string;
  readonly dataReferencia: string;
  readonly indexador?: string;
  readonly taxaContratada?: string;
  readonly dataEmissao?: string;
  readonly vencimento?: string;
  readonly valorAplicado?: string;
}

export function posicaoRow(input: PosicaoRowInput): Record<string, string> {
  return {
    Produto: input.produto,
    Instituição: input.instituicao ?? 'Corretora Teste',
    Categoria: input.categoria,
    Quantidade: input.quantidade,
    'Data de Referência': input.dataReferencia,
    Indexador: input.indexador ?? '',
    'Taxa Contratada': input.taxaContratada ?? '',
    'Data de Emissão': input.dataEmissao ?? '',
    Vencimento: input.vencimento ?? '',
    'Valor Aplicado': input.valorAplicado ?? '',
  };
}

export async function buildPosicaoXlsx(
  rows: readonly PosicaoRowInput[],
  options: Partial<BuildSheetOptions> = {},
): Promise<Uint8Array> {
  return buildXlsx({
    headers: [...POSICAO_HEADERS],
    rows: rows.map(posicaoRow),
    ...options,
  });
}
