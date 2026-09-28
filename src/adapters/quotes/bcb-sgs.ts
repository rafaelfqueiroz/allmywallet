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
  /** No answer, a timeout, or a 5xx — worth retrying as is. */
  UNAVAILABLE: 'BCB_SGS_UNAVAILABLE',
  /** #123: a 4xx other than 404 — BCB refused this request; retrying it unchanged cannot help. */
  REJECTED: 'BCB_SGS_REJECTED',
  /** A 404: BCB holds no value in the requested range ("Value(s) not found"). */
  NO_DATA: 'BCB_SGS_NO_DATA',
  /** A 2xx whose body is not the series shape. */
  MALFORMED_RESPONSE: 'BCB_SGS_MALFORMED_RESPONSE',
  UNSUPPORTED_SERIES: 'BCB_SGS_UNSUPPORTED_SERIES',
} as const;

/**
 * #123: BCB refuses a window over 10 years on a daily series — HTTP 406, "O
 * sistema aceita uma janela de consulta de, no máximo, 10 anos em séries de
 * periodicidade diária". Probed: 2000-01-01..2010-01-01 is accepted and
 * ..2010-01-02 is not, so a window ending the day before its tenth
 * anniversary is inside the limit with a day to spare.
 */
const MAX_WINDOW_YEARS = 10;

export interface SgsRequestWindow {
  readonly since: BusinessDate;
  readonly until: BusinessDate;
}

function utcDate(date: BusinessDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toIso(date: Date): BusinessDate {
  return BusinessDate.of(date.toISOString().slice(0, 10));
}

/**
 * #123 / SPEC-008 AC "backfill history": `since..until` split into
 * consecutive windows BCB accepts, oldest first, so the caller can persist
 * each before requesting the next. Applied to every SGS series, monthly IPCA
 * included — the limit does not bind a monthly series, but one path for all
 * three is simpler than a periodicity table, and it costs a first backfill
 * two extra requests.
 */
export function sgsRequestWindows(
  since: BusinessDate,
  until: BusinessDate,
): readonly SgsRequestWindow[] {
  const windows: SgsRequestWindow[] = [];
  const end = utcDate(until);
  let start = utcDate(since);
  while (start <= end) {
    const limit = new Date(
      Date.UTC(
        start.getUTCFullYear() + MAX_WINDOW_YEARS,
        start.getUTCMonth(),
        start.getUTCDate() - 1,
      ),
    );
    const windowEnd = limit < end ? limit : end;
    windows.push({ since: toIso(start), until: toIso(windowEnd) });
    start = new Date(windowEnd.getTime() + 86_400_000);
  }
  return windows;
}

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

function toBrDate(date: BusinessDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

const MAX_MESSAGE_LENGTH = 300;

/**
 * #123: BCB explains a refusal in the body — `{"error": …}` on a 406,
 * `{"erro": {"detail": …}}` on a 404. The text is BCB's own and the request
 * carries no personal data, so it is safe to log (AR-39); without it a 406
 * read as an outage for months.
 */
function providerMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const shape = z
    .object({
      error: z.string().optional(),
      erro: z.object({ detail: z.string().optional() }).optional(),
    })
    .safeParse(parsed);
  const message = shape.success ? (shape.data.error ?? shape.data.erro?.detail) : undefined;
  return message === undefined ? null : message.slice(0, MAX_MESSAGE_LENGTH);
}

export interface BcbSgsConfig {
  readonly baseUrl?: string;
  readonly source: string;
  /**
   * #161: worker-start catch-up runs this sync on every start, before any
   * schedule is registered, so an unanswering server must not hold the worker
   * back. Covers the body read too.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';
const DEFAULT_TIMEOUT_MS = 60_000;

export class BcbSgsIndexSeriesProvider implements IndexSeriesProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: BcbSgsConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async fetchSeries(
    code: IndexSeriesCode,
    since: BusinessDate,
    until: BusinessDate,
  ): Promise<Result<readonly IndexSeriesPointRecord[], DomainError>> {
    const seriesId = SGS_SERIES_CODES[code];
    if (seriesId === null) {
      return err(domainError(BcbSgsErrorCode.UNSUPPORTED_SERIES, { code }));
    }

    const url =
      `${this.baseUrl}.${seriesId}/dados?formato=json` +
      `&dataInicial=${toBrDate(since)}&dataFinal=${toBrDate(until)}`;

    let status: number;
    let rawBody: string;
    try {
      const signal = AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const response = await fetch(url, { method: 'GET', signal });
      status = response.status;
      rawBody = await response.text();
    } catch {
      return err(domainError(BcbSgsErrorCode.UNAVAILABLE, { code }));
    }

    // #123: every non-2xx is a failure that keeps its status and BCB's
    // reason, and none of them reaches the series parser.
    if (status < 200 || status >= 300) {
      const errorCode =
        status >= 500
          ? BcbSgsErrorCode.UNAVAILABLE
          : status === 404
            ? BcbSgsErrorCode.NO_DATA
            : BcbSgsErrorCode.REJECTED;
      return err(domainError(errorCode, { code, status, message: providerMessage(rawBody) }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return err(domainError(BcbSgsErrorCode.MALFORMED_RESPONSE, { code, status }));
    }

    const shape = sgsResponseSchema.safeParse(parsed);
    if (!shape.success) {
      return err(domainError(BcbSgsErrorCode.MALFORMED_RESPONSE, { code, status }));
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
