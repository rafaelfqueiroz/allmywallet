import { Money } from '@/core/shared/money';
import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import type { TesouroPricePoint, TesouroPriceProvider } from '@/core/quotes/ports';
import { tesouroCatalogCodes } from '@/core/quotes/tesouro-title';

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
 * SPEC-009 BR-009-06 governs **which** column is read: `PU Venda Manhã`, the
 * sell price. See the comment at the extraction site.
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

function tryBusinessDate(brDate: string): BusinessDate | null {
  try {
    return toBusinessDate(brDate);
  } catch {
    return null;
  }
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
  /**
   * #161: worker-start catch-up now runs this sync on every start, before any
   * schedule is registered, so a server that accepts the connection and never
   * answers must not hold the worker back. Covers the body read too — the
   * file is the whole history, several megabytes.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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
      const signal = AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const response = await fetch(this.url, { method: 'GET', signal });
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
 * Parses the CSV into **every** published close, for every title and every
 * `Data Base` the file carries — its whole history. #161: keeping only the
 * latest date lost for good every day the sync did not run on, and never
 * loaded anything before its first run. `tesouro.sync` writes only the closes
 * not already stored, so the whole file is cheap to offer every time.
 * Exported for the contract test (TS-26).
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
    puVenda: header.indexOf('PU Venda Manha'),
    puBase: header.indexOf('PU Base Manha'),
  };

  type Row = { product: string; maturity: BusinessDate; date: BusinessDate; price: string };
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(';');
    const titulo = cols[idx.titulo]?.trim();
    const vencimento = cols[idx.vencimento]?.trim();
    const dataBase = cols[idx.dataBase]?.trim();
    /**
     * SPEC-009 BR-009-06 / DL-009-04: **the sell price**, `PU Venda Manhã` —
     * what the holder would actually realise. This column feeds
     * `price_quotes`, which is the only price `core/valuation/tesouro.ts`
     * ever sees, so the rule is enforced here or it is not enforced at all.
     *
     * Using `PU Base Manhã` (as this parser originally did, before SPEC-009
     * existed to say otherwise) or `PU Compra Manhã` would overstate every
     * Tesouro holding by roughly half the spread or the whole of it — small
     * per title, in the same direction every day, across every position.
     *
     * `PU Base Manhã` remains the fallback for the real case the published
     * file contains: a title no longer offered for redemption leaves the
     * venda column blank. A stale-but-observed base price beats dropping the
     * title and understating the portfolio silently (DL-009-05).
     */
    const puVenda = cols[idx.puVenda]?.trim();
    const puBase = cols[idx.puBase]?.trim();
    const price = puVenda || puBase;
    if (!titulo || !vencimento || !dataBase || !price) continue;
    // #152/#161: both dates name what is stored — the maturity the asset, the
    // base date the close — so an unreadable one drops that row rather than
    // throwing away the whole file.
    const maturity = tryBusinessDate(vencimento);
    const date = tryBusinessDate(dataBase);
    if (maturity === null || date === null) continue;
    rows.push({ product: titulo, maturity, date, price });
  }

  // #152: catalogued under B3's name (`Tesouro Selic 2029`) — the asset the
  // ledger already holds — rather than Tesouro Transparente's product and
  // maturity date, which named an asset nothing held. The rule, and the
  // products it declines to translate, live in `core/quotes/tesouro-title.ts`.
  // Applied to the whole history at once, so a code means one maturity on
  // every day it was ever published.
  const codes = tesouroCatalogCodes(
    rows.map((row) => ({ product: row.product, maturity: row.maturity })),
  );
  return rows.map((row, index) => ({
    ticker: codes[index] as string,
    date: row.date,
    price: Money.fromString(toDecimalString(row.price)),
    source,
  }));
}
