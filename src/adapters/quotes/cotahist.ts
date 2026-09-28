import { createInterface } from 'node:readline';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import {
  OfficialCloseSourceErrorCode,
  type OfficialClose,
  type OfficialCloseSource,
  type OfficialClosesFile,
} from '@/core/quotes/ports';
import { openSingleZipEntry } from '@/adapters/quotes/zip-entry';

/**
 * SPEC-008 BR-008-09/BR-008-30, DL-008-14 (#171) — B3's public COTAHIST
 * files ("SeriesHistoricas"), fetched without credentials (SPEC-003
 * BR-003-08). The daily file (`COTAHIST_DddMMyyyy.ZIP`) serves recent days;
 * the annual file (`COTAHIST_Aaaaa.ZIP`) serves many days of one year in a
 * single request — `quotes.cotahist_annual_min_days` is what decides which
 * one a caller reaches for (see `worker/handlers/composition.ts`), not this
 * file.
 *
 * Each ZIP holds exactly one entry: a fixed-width text file, one 245-char
 * record per line (B3's "SeriesHistoricas_Layout"), CRLF-terminated,
 * latin1-encoded. `zip-entry.ts` unwraps the archive; this file owns the
 * record layout and the HTTP/parse error mapping.
 */

export interface CotahistConfig {
  readonly source: string;
  /** The directory holding `COTAHIST_*.ZIP`; defaults to B3's public server. */
  readonly baseUrl?: string;
  readonly timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://bvmf.bmfbovespa.com.br/InstDados/SerHist';

// ---------------------------------------------------------------------------
// Record layout (1-based, inclusive positions — converted to 0-based slices
// below). B3's "SeriesHistoricas_Layout" document is the source for these.
// ---------------------------------------------------------------------------

const TIPREG_START = 0; // 1–2
const TIPREG_END = 2;
const DATPRE_START = 2; // 3–10, AAAAMMDD
const DATPRE_END = 10;
const CODNEG_START = 12; // 13–24
const CODNEG_END = 24;
const TPMERC_START = 24; // 25–27
const TPMERC_END = 27;
const PREULT_START = 108; // 109–121, 13 digits, 2 implied decimals
const PREULT_END = 121;
const FATCOT_START = 210; // 211–217, 7 digits, integer
const FATCOT_END = 217;

/** The minimum line length that lets every field above be read. */
const MIN_QUOTE_RECORD_LENGTH = FATCOT_END;

const TIPREG_QUOTE = '01';
const TIPREG_TRAILER = '99';
/** BR-008-30: spot market — the only `TPMERC` an official close is read from. */
const TPMERC_SPOT = '010';

/** Real files start `00COTAHIST.` — anything else in the first line is not a COTAHIST file. */
const HEADER_PREFIX = '00COTAHIST.';

/** `"0000000004799"` (13 digits, 2 implied decimals) -> `"47.99"`. AR-06: string slicing only, never `Number()`. */
function preultToDecimalString(raw: string): string {
  const decimals = 2;
  const intPart = raw.slice(0, raw.length - decimals);
  const decPart = raw.slice(raw.length - decimals);
  const trimmedInt = intPart.replace(/^0+(?=\d)/, '');
  return `${trimmedInt}.${decPart}`;
}

/**
 * `"0001000"` -> `"1000"`; `"0000001"` -> `"1"`; `"0000000"` -> `"0"`. The
 * lookahead never strips the final digit, so a fixed-width all-digit field
 * (FATCOT always is) never reduces to the empty string.
 */
function stripLeadingZeros(raw: string): string {
  return raw.replace(/^0+(?=\d)/, '');
}

/** `"20260925"` -> `BusinessDate` `"2026-09-25"`. */
function businessDateFromDatpre(datpre: string): BusinessDate {
  const year = datpre.slice(0, 4);
  const month = datpre.slice(4, 6);
  const day = datpre.slice(6, 8);
  return BusinessDate.of(`${year}-${month}-${day}`);
}

class CotahistParseError extends Error {}

/**
 * Reads every record of a decompressed COTAHIST text stream, keeping only
 * spot-market (`TPMERC` 010) closes for `tickers`.
 *
 * BR-008-30's `lastDate` is the max `DATPRE` over **every** `TIPREG=01` row —
 * any market, any ticker — which is why it is tracked outside the ticker/
 * market filter below rather than derived from `closes`.
 *
 * Throws `CotahistParseError` for a missing/wrong header or a missing
 * trailer (a truncated file); the caller maps this to `UNAVAILABLE`.
 */
async function readCotahistStream(
  stream: NodeJS.ReadableStream,
  tickers: ReadonlySet<string>,
): Promise<OfficialClosesFile> {
  stream.setEncoding('latin1');
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let isFirstLine = true;
  let sawTrailer = false;
  let lastDate: BusinessDate | null = null;
  const closes: OfficialClose[] = [];

  for await (const line of lines) {
    if (isFirstLine) {
      isFirstLine = false;
      if (!line.startsWith(HEADER_PREFIX)) {
        throw new CotahistParseError('missing or invalid header record');
      }
      continue;
    }

    const tipreg = line.slice(TIPREG_START, TIPREG_END);
    if (tipreg === TIPREG_TRAILER) {
      sawTrailer = true;
      continue;
    }
    if (tipreg !== TIPREG_QUOTE || line.length < MIN_QUOTE_RECORD_LENGTH) continue;

    const date = businessDateFromDatpre(line.slice(DATPRE_START, DATPRE_END));
    // BR-008-30: every quote row counts here, not only the requested tickers
    // or the spot market — this is the file's own "as of" date.
    if (lastDate === null || BusinessDate.compare(date, lastDate) > 0) {
      lastDate = date;
    }

    const tpmerc = line.slice(TPMERC_START, TPMERC_END);
    if (tpmerc !== TPMERC_SPOT) continue;

    const ticker = line.slice(CODNEG_START, CODNEG_END).trim();
    if (!tickers.has(ticker)) continue;

    const preult = line.slice(PREULT_START, PREULT_END);
    const fatcot = stripLeadingZeros(line.slice(FATCOT_START, FATCOT_END));
    let close = Money.fromString(preultToDecimalString(preult));
    // SPEC-008 BR-008-09: PREULT is per FATCOT units, not per unit — divide
    // whenever the quote factor is not 1. AR-06: FATCOT stays a string too.
    if (fatcot !== '1') {
      close = close.dividedBy(fatcot);
    }
    closes.push({ ticker, date, close });
  }

  if (isFirstLine) {
    // The stream produced no lines at all — no header either.
    throw new CotahistParseError('empty file: no header record');
  }
  if (!sawTrailer) {
    throw new CotahistParseError('missing trailer record (truncated file)');
  }

  return { closes, lastDate };
}

/** `B3_...` day-file name: `COTAHIST_D${dd}${mm}${yyyy}.ZIP`. */
function dayFileUrl(baseUrl: string, date: BusinessDate): string {
  const [year, month, day] = date.split('-');
  return `${baseUrl}/COTAHIST_D${day}${month}${year}.ZIP`;
}

/** Annual file name: `COTAHIST_A${yyyy}.ZIP`. */
function yearFileUrl(baseUrl: string, year: number): string {
  return `${baseUrl}/COTAHIST_A${year}.ZIP`;
}

export class B3CotahistCloseSource implements OfficialCloseSource {
  readonly source: string;
  private readonly baseUrl: string;

  constructor(private readonly config: CotahistConfig) {
    this.source = config.source;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async fetchDay(
    date: BusinessDate,
    tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    return this.fetch(dayFileUrl(this.baseUrl, date), tickers);
  }

  async fetchYear(
    year: number,
    tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    return this.fetch(yearFileUrl(this.baseUrl, year), tickers);
  }

  /**
   * GET, `AbortSignal.timeout` covering the body read too — worker-start
   * catch-up (SPEC-021 BR-021-28) can run this before any schedule is
   * registered, so a server that accepts the connection and never answers
   * must not hold the worker back (mirrors `tesouro.ts`/`bcb-sgs.ts`).
   *
   * BR-008-09: HTTP 404 means the file is not published yet — never a gap,
   * always retried later. Every other failure (non-2xx, network error,
   * timeout, a ZIP or record stream that does not parse) is `UNAVAILABLE`;
   * nothing here ever throws out of `fetchDay`/`fetchYear`.
   */
  private async fetch(
    url: string,
    tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    let buffer: Buffer;
    try {
      const signal = AbortSignal.timeout(this.config.timeoutMs);
      const response = await fetch(url, { method: 'GET', signal });
      if (response.status === 404) {
        return err(domainError(OfficialCloseSourceErrorCode.NOT_PUBLISHED, { url }));
      }
      if (response.status < 200 || response.status >= 300) {
        return err(
          domainError(OfficialCloseSourceErrorCode.UNAVAILABLE, { url, status: response.status }),
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch {
      return err(domainError(OfficialCloseSourceErrorCode.UNAVAILABLE, { url }));
    }

    try {
      const entry = openSingleZipEntry(buffer);
      const file = await readCotahistStream(entry.stream, tickers);
      return ok(file);
    } catch {
      // A corrupt/undecodable ZIP, a missing or wrong header, a missing
      // trailer (truncated file), or a record whose DATPRE does not parse —
      // all of these are "the file does not parse" (ARCHITECTURE §9: a
      // malformed external file is an expected domain outcome, not a bug),
      // so all of them are `UNAVAILABLE` rather than left to throw.
      return err(domainError(OfficialCloseSourceErrorCode.UNAVAILABLE, { url }));
    }
  }
}
