import { z } from 'zod';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import type {
  IndexSeriesCode,
  IndexSeriesPointRecord,
  IndexSeriesProvider,
} from '@/core/quotes/ports';

/**
 * SPEC-008 — BCB SGS (Sistema Gerenciador de Séries Temporais). Series 12
 * (CDI), 433 (IPCA), 11 (Selic); IBOV is not a BCB series and is fetched
 * separately (see the dispatch report's IBOV note).
 *
 * AR-06: unlike brapi, the BCB SGS API returns `valor` as a **JSON string**
 * already (`{"data":"16/03/2026","valor":"11.65"}`) — there is no float
 * hazard to route around here, so `Money`/`Quantity.fromString` is called
 * directly on the parsed field, which is itself still a string.
 */
export const BcbSgsErrorCode = {
  UNAVAILABLE: 'BCB_SGS_UNAVAILABLE',
  UNSUPPORTED_SERIES: 'BCB_SGS_UNSUPPORTED_SERIES',
} as const;

const SGS_SERIES_CODES: Record<IndexSeriesCode, number | null> = {
  CDI: 12,
  IPCA: 433,
  SELIC: 11,
  // Not a BCB SGS series — fetched via QuoteProvider instead (dispatch report).
  IBOV: null,
};

const sgsPointSchema = z.object({
  data: z.string(), // 'DD/MM/YYYY'
  valor: z.string(),
});
const sgsResponseSchema = z.array(sgsPointSchema);

function toBusinessDate(brDate: string): BusinessDate {
  const [day, month, year] = brDate.split('/');
  return BusinessDate.of(`${year}-${month}-${day}`);
}

export interface BcbSgsConfig {
  readonly baseUrl?: string;
  readonly source: string;
}

const DEFAULT_BASE_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';

export class BcbSgsIndexSeriesProvider implements IndexSeriesProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: BcbSgsConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async fetchSeries(
    code: IndexSeriesCode,
    since: BusinessDate,
  ): Promise<Result<readonly IndexSeriesPointRecord[], DomainError>> {
    const seriesId = SGS_SERIES_CODES[code];
    if (seriesId === null) {
      return err(domainError(BcbSgsErrorCode.UNSUPPORTED_SERIES, { code }));
    }

    const [year, month, day] = since.split('-');
    const dataInicial = `${day}/${month}/${year}`;
    const url = `${this.baseUrl}.${seriesId}/dados?formato=json&dataInicial=${dataInicial}`;

    let rawBody: string;
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.status >= 500) {
        return err(domainError(BcbSgsErrorCode.UNAVAILABLE, { code, status: response.status }));
      }
      rawBody = await response.text();
    } catch {
      return err(domainError(BcbSgsErrorCode.UNAVAILABLE, { code }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return err(domainError(BcbSgsErrorCode.UNAVAILABLE, { code }));
    }

    const shape = sgsResponseSchema.safeParse(parsed);
    if (!shape.success) {
      return err(domainError(BcbSgsErrorCode.UNAVAILABLE, { code }));
    }

    const points: IndexSeriesPointRecord[] = shape.data.map((point) => ({
      code,
      date: toBusinessDate(point.data),
      value: Quantity.fromString(point.valor),
      source: this.config.source,
    }));
    return ok(points);
  }
}
