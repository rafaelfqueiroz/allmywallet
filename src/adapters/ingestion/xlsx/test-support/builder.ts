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
  return buildMultiSheetXlsx([options]);
}

/**
 * A workbook with one tab per entry — B3's real Posição shape (#63).
 *
 * TS-19/DV-24: generated, never a captured export. Every tab is built from the
 * same synthetic rows the single-sheet builder uses, so a multi-tab fixture
 * carries no more real data than a single-tab one does — which is none.
 *
 * `names` is deliberately positional rather than part of `BuildSheetOptions`:
 * nothing in the parser reads a sheet name (detection is structural, BR-005-03),
 * so a name is a fixture-readability affordance and not a behaviour under test.
 */
export async function buildMultiSheetXlsx(
  sheets: readonly BuildSheetOptions[],
  names: readonly string[] = [],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();

  sheets.forEach((options, index) => {
    const sheet = workbook.addWorksheet(names[index] ?? `Extrato ${index + 1}`);

    for (const line of options.metadataRows ?? defaultMetadataRows()) {
      sheet.addRow([line]);
    }

    const headerOrder = options.headerOrder ?? options.headers;
    sheet.addRow([...headerOrder]);

    for (const row of options.rows) {
      sheet.addRow(headerOrder.map((header) => row[header] ?? ''));
    }
  });

  return workbook.xlsx.writeBuffer().then((buffer) => new Uint8Array(buffer));
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

/**
 * #108 — B3's **real** Negociação header row (names only, read off a real
 * export; never its values — DV-24). The invented version had `Tipo` and no
 * `Instituição` or `Prazo/Vencimento`.
 */
export const NEGOCIACAO_HEADERS = [
  'Data do Negócio',
  'Tipo de Movimentação',
  'Mercado',
  'Prazo/Vencimento',
  'Instituição',
  'Código de Negociação',
  'Quantidade',
  'Preço',
  'Valor',
] as const;

export interface NegociacaoRowInput {
  readonly data: string;
  /** Written to `Tipo de Movimentação`. */
  readonly tipo: string;
  readonly mercado?: string;
  readonly prazo?: string;
  readonly instituicao?: string;
  readonly codigo: string;
  readonly quantidade: string;
  readonly preco: string;
  readonly valor?: string;
}

export function negociacaoRow(input: NegociacaoRowInput): Record<string, string> {
  return {
    'Data do Negócio': input.data,
    'Tipo de Movimentação': input.tipo,
    Mercado: input.mercado ?? 'Mercado à Vista',
    'Prazo/Vencimento': input.prazo ?? '-',
    // The same default `movimentacaoRow` uses, so one trade in both extracts
    // shares a natural key, as it does in a real account.
    Instituição: input.instituicao ?? 'Corretora Teste',
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

/**
 * #108 — B3's **real** Posição layout: one tab per asset class, header on row
 * 1, no metadata block. Header names only were read off a real export (never
 * its values — DV-24); the first version of this builder emitted an invented
 * `Categoria`/`Data de Referência` layout, which is why CI never caught that
 * real imports failed detection.
 */
export const POSICAO_TAB_HEADERS = {
  Acoes: [
    'Produto',
    'Instituição',
    'Conta',
    'Código de Negociação',
    'CNPJ da Empresa',
    'Código ISIN / Distribuição',
    'Tipo',
    'Escriturador',
    'Quantidade',
    'Quantidade Disponível',
    'Quantidade Indisponível',
    'Motivo',
    'Preço de Fechamento',
    'Valor Atualizado',
  ],
  'Fundo de Investimento': [
    'Produto',
    'Instituição',
    'Conta',
    'Código de Negociação',
    'CNPJ do Fundo',
    'Código ISIN / Distribuição',
    'Tipo',
    'Administrador',
    'Quantidade',
    'Quantidade Disponível',
    'Quantidade Indisponível',
    'Motivo',
    'Preço de Fechamento',
    'Valor Atualizado',
  ],
  'Renda Fixa': [
    'Produto',
    'Instituição',
    'Emissor',
    'Código',
    'Indexador',
    'Tipo de regime',
    'Data de Emissão',
    'Vencimento',
    'Quantidade',
    'Quantidade Disponível',
    'Quantidade Indisponível',
    'Motivo',
    'Contraparte',
    'Preço Atualizado MTM',
    'Valor Atualizado MTM',
    'Preço Atualizado CURVA',
    'Valor Atualizado CURVA',
    'Preço Atualizado FECHAMENTO',
    'Valor Atualizado FECHAMENTO',
  ],
  'Tesouro Direto': [
    'Produto',
    'Instituição',
    'Código ISIN',
    'Indexador',
    'Vencimento',
    'Quantidade',
    'Quantidade Disponível',
    'Quantidade Indisponível',
    'Motivo',
    'Valor Aplicado',
    'Valor bruto',
    'Valor líquido',
    'Valor Atualizado',
  ],
} as const;

export type PosicaoTab = keyof typeof POSICAO_TAB_HEADERS;

export interface PosicaoRowInput {
  /** `"PETR4 - PETROBRAS"`, `"CDB - BANCO TESTE S/A"`, `"Tesouro Selic 2029"` — B3's own shapes. */
  readonly produto: string;
  readonly instituicao?: string;
  /** `Código de Negociação` on listed tabs, `Código` on Renda Fixa, `Código ISIN` on Tesouro. */
  readonly codigo?: string;
  readonly tipo?: string;
  readonly quantidade: string;
  readonly indexador?: string;
  readonly dataEmissao?: string;
  readonly vencimento?: string;
}

export function posicaoRow(tab: PosicaoTab, input: PosicaoRowInput): Record<string, string> {
  const values: Record<string, string> = {
    Produto: input.produto,
    Instituição: input.instituicao ?? 'Corretora Teste',
    Conta: '123456',
    'Código de Negociação': input.codigo ?? '',
    Código: input.codigo ?? '',
    'Código ISIN': input.codigo ?? '',
    Tipo: input.tipo ?? '',
    Quantidade: input.quantidade,
    'Quantidade Disponível': input.quantidade,
    'Quantidade Indisponível': '0',
    Indexador: input.indexador ?? '',
    'Data de Emissão': input.dataEmissao ?? '',
    Vencimento: input.vencimento ?? '',
  };
  return Object.fromEntries(
    POSICAO_TAB_HEADERS[tab].map((header) => [header, values[header] ?? '']),
  );
}

export function posicaoSheet(tab: PosicaoTab, rows: readonly PosicaoRowInput[]): BuildSheetOptions {
  return {
    headers: [...POSICAO_TAB_HEADERS[tab]],
    rows: rows.map((row) => posicaoRow(tab, row)),
    metadataRows: [],
  };
}

/** A Posição workbook with one tab per key, in the order given — the real export's shape. */
export async function buildPosicaoXlsx(
  tabs: Partial<Record<PosicaoTab, readonly PosicaoRowInput[]>>,
): Promise<Uint8Array> {
  const entries = Object.entries(tabs) as [PosicaoTab, readonly PosicaoRowInput[]][];
  return buildMultiSheetXlsx(
    entries.map(([tab, rows]) => posicaoSheet(tab, rows)),
    entries.map(([tab]) => tab),
  );
}
