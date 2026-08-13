import { Money } from '@/core/shared/money';
import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import type { TesouroPricePoint, TesouroPriceProvider } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-12 — Tesouro Transparente publishes one semicolon-delimited
 * CSV covering every Tesouro Direto title's whole price history for the day,
 * Brazilian-locale decimals (`,` not `.`). Structurally a batch fetch (every
 * title at once), which is why this is its own port rather than reusing
 * `QuoteProvider`'s one-ticker-per-call shape — see the ports.ts doc comment
 * and the dispatch report.
 *
 * AR-06: the decimal separator is swapped (`,` -> `.`) on the raw CSV field
 * — a string operation — before `Money.fromString`; the value never passes
 * through a JS `number`.
 *
 * Expected columns (header row, semicolon-delimited):
 *   Tipo Titulo;Data Vencimento;Data Base;Taxa Compra Manha;Taxa Venda Manha;PU Compra Manha;PU Venda Manha;PU Base Manha
 */
const EXPECTED_COLUMNS = [
  'Tipo Titulo',
  'Data Vencimento',
  'Data Base',
  'Taxa Compra Manha',
  'Taxa Venda Manha',
  'PU Compra Manha',
  'PU Venda Manha',
  'PU Base Manha',
];

function toBusinessDate(brDate: string): BusinessDate {
  const [day, month, year] = brDate.split('/');
  return BusinessDate.of(`${year}-${month}-${day}`);
}

function toDecimalString(brNumber: string): string {
  return brNumber.trim().replace(/\./g, '').replace(',', '.');
}

export const TesouroErrorCode = {
  UNAVAILABLE: 'TESOURO_UNAVAILABLE',
} as const;

export interface TesouroConfig {
  readonly url?: string;
  readonly source: string;
}

const DEFAULT_URL =
  'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';

export class TesouroTransparenteProvider implements TesouroPriceProvider {
  private readonly url: string;

  constructor(private readonly config: TesouroConfig) {
    this.url = config.url ?? DEFAULT_URL;
  }

  async fetchDailyPrices(): Promise<Result<readonly TesouroPricePoint[], DomainError>> {
    let csv: string;
    try {
      const response = await fetch(this.url, { method: 'GET' });
      if (response.status >= 500) {
        return err(domainError(TesouroErrorCode.UNAVAILABLE, { status: response.status }));
      }
      csv = await response.text();
    } catch {
      return err(domainError(TesouroErrorCode.UNAVAILABLE, {}));
    }

    const points = parseTesouroCsv(csv, this.config.source);
    if (points === null) {
      return err(domainError(TesouroErrorCode.UNAVAILABLE, {}));
    }
    return ok(points);
  }
}

/**
 * Parses the CSV and keeps only rows for the **most recent `Data Base`**
 * present — the file otherwise carries the entire history, and BR-008-12
 * only wants "today's" batch. Exported for the contract test (TS-26).
 */
export function parseTesouroCsv(csv: string, source: string): readonly TesouroPricePoint[] | null {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const header = (lines[0] ?? '').split(';').map((h) => h.trim());
  if (!EXPECTED_COLUMNS.every((col) => header.includes(col))) return null;

  const idx = {
    titulo: header.indexOf('Tipo Titulo'),
    vencimento: header.indexOf('Data Vencimento'),
    dataBase: header.indexOf('Data Base'),
    puBase: header.indexOf('PU Base Manha'),
  };

  type Row = { ticker: string; date: string; price: string };
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(';');
    const titulo = cols[idx.titulo]?.trim();
    const vencimento = cols[idx.vencimento]?.trim();
    const dataBase = cols[idx.dataBase]?.trim();
    const puBase = cols[idx.puBase]?.trim();
    if (!titulo || !vencimento || !dataBase || !puBase) continue;
    rows.push({ ticker: `${titulo} ${vencimento}`, date: dataBase, price: puBase });
  }
  if (rows.length === 0) return [];

  // "Most recent" compared as BusinessDate strings (lexicographic, per
  // BusinessDate.compare) after normalising DD/MM/YYYY -> YYYY-MM-DD.
  let latest: BusinessDate | null = null;
  for (const row of rows) {
    const date = toBusinessDate(row.date);
    if (!latest || BusinessDate.isAfter(date, latest)) latest = date;
  }
  if (!latest) return [];
  const latestDate: BusinessDate = latest;

  return rows
    .filter((row) => toBusinessDate(row.date) === latestDate)
    .map((row) => ({
      ticker: row.ticker,
      date: latestDate,
      price: Money.fromString(toDecimalString(row.price)),
      source,
    }));
}
