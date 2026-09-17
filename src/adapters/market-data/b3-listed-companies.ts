import { BusinessDate } from '@/core/shared/clock';
import {
  factorMultiplier,
  type CorporateEventFactor,
  type CorporateEventFactorFetch,
  type CorporateEventFactorKind,
  type CorporateEventFactorSource,
} from '@/core/quotes/corporate-event-factors';

/**
 * SPEC-008 BR-008-29 (#113) — B3's public `GetListedSupplementCompany`
 * listed-companies endpoint. No key, no credential, no user data sent
 * (SPEC-003 BR-003-08): the only outbound datum is the issuer code itself,
 * base64-encoded into the URL path exactly as B3's own front end sends it.
 *
 * The real envelope, observed against live public data while building this
 * adapter (never captured into a fixture — DV-24/TS-19; the test fixture
 * below is hand-written and trimmed):
 *
 * - A listed issuer (e.g. `MGLU`) → HTTP 200, a JSON **array** with one
 *   object carrying `stockDividends: [{ factor, label, approvedOn,
 *   lastDatePrior, ... }]` among other unrelated arrays (`cashDividends`,
 *   `subscriptions`) this adapter ignores. `factor` is always a **quoted
 *   pt-BR decimal string** (`"5,00000000000"`), never a bare JSON number.
 * - A listed issuer with no corporate-event history → the same shape with
 *   `stockDividends: []`.
 * - An issuer B3 does not recognise at all → HTTP 200 with a **completely
 *   empty body** (confirmed via response headers: `content-length: 0`,
 *   `content-type: text/plain`). This is `not_listed`, not a failure.
 *
 * AR-06 — the money-adjacent field (`factor`) never passes through a JS
 * `number`, including via `JSON.parse`: this file never calls `JSON.parse`
 * on the response body at all. Every field is pulled out of the raw response
 * text with the same technique `adapters/quotes/decimal-json.ts` and
 * `adapters/quotes/brapi.ts` use for money fields, extended here to require
 * the JSON *string* quoting a decimal-in-pt-BR-notation field is published
 * in. A `factor` that arrives as a bare JSON number (no quotes) fails the
 * text match and the whole fetch is reported `failed` rather than silently
 * dropping the one row — B3 has never sent this shape, but AR-06 is not
 * "handle what has been observed", it is "never let a number reach here".
 */

const BASE_URL =
  'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany';

const LABEL_KIND_BY_NORMALISED: Readonly<Record<string, CorporateEventFactorKind>> = {
  GRUPAMENTO: 'grupamento',
  DESDOBRAMENTO: 'desdobramento',
  BONIFICACAO: 'bonificacao',
};

/**
 * B3's `label` values arrive with or without the cedilla/tilde depending on
 * the endpoint version observed (`BONIFICAÇÃO` vs `BONIFICACAO` live) — this
 * strips diacritics and case before matching so either form resolves to the
 * same `CorporateEventFactorKind`. Any other label (`DIVIDENDO`,
 * `SUBSCRICAO`, ...) is not in the map and is ignored, per BR-008-29's "the
 * adapter normalises" and this method's own explicit scope: split,
 * reverse-split and bonus only.
 */
function normaliseLabel(rawLabel: string): CorporateEventFactorKind | null {
  const normalised = rawLabel.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
  return LABEL_KIND_BY_NORMALISED[normalised] ?? null;
}

/**
 * B3 publishes the factor in pt-BR notation: `,` is the decimal separator,
 * `.` is a thousands separator that may or may not be present (`"300"`,
 * `"1.000"` meaning one thousand, `"0,10000000000"`). Converting is pure
 * string surgery — no `Number()`, no `parseFloat` — so the digits a `Decimal`
 * eventually sees are exactly the digits B3 published.
 */
function toDotDecimal(ptBr: string): string {
  return ptBr.trim().replace(/\./g, '').replace(',', '.');
}

const BR_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function parseBrDate(raw: string): BusinessDate {
  const match = BR_DATE_PATTERN.exec(raw.trim());
  if (match === null) throw new TypeError(`not a dd/mm/yyyy date: "${raw}"`);
  const [, dd, mm, yyyy] = match;
  return BusinessDate.of(`${yyyy}-${mm}-${dd}`);
}

/**
 * Reads `"fieldName": "..."` — the value **must** be JSON-string-quoted.
 * Returns `null` both when the field is absent and when it is present but
 * unquoted (a bare number or boolean) — the two cases this adapter must
 * treat identically, since either means "not a usable pt-BR decimal string".
 */
function extractJsonStringField(text: string, fieldName: string): string | null {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"([^"]*)"`);
  return pattern.exec(text)?.[1] ?? null;
}

/**
 * Slices out the text of a top-level JSON array field, the same
 * find-the-brackets technique `brapi.ts`'s `extractHistoricalCloses` uses for
 * `historicalDataPrice`. Safe here because `stockDividends` entries are flat
 * objects with no nested arrays or braces.
 */
function extractJsonArrayBlock(rawBody: string, fieldName: string): string | null {
  const start = new RegExp(`"${fieldName}"\\s*:\\s*\\[`).exec(rawBody);
  if (start === null) return null;
  const afterStart = rawBody.slice(start.index + start[0].length);
  const end = afterStart.indexOf(']');
  return end === -1 ? afterStart : afterStart.slice(0, end);
}

function encodeIssuerToken(issuerCode: string): string {
  const payload = JSON.stringify({ issuingCompany: issuerCode, language: 'pt-br' });
  return Buffer.from(payload, 'utf-8').toString('base64');
}

export function b3ListedCompaniesUrl(issuerCode: string): string {
  return `${BASE_URL}/${encodeIssuerToken(issuerCode)}`;
}

/**
 * SPEC-008 BR-008-29 — one issuer per call, matching B3's own front end.
 * AR-02/AR-03: implements the `CorporateEventFactorSource` port declared in
 * `core/quotes/corporate-event-factors.ts`.
 */
export class B3ListedCompaniesFactorSource implements CorporateEventFactorSource {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchIssuer(issuerCode: string): Promise<CorporateEventFactorFetch> {
    const url = b3ListedCompaniesUrl(issuerCode);

    let rawBody: string;
    let status: number;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetchImpl(url, { method: 'GET', signal });
      status = response.status;
      rawBody = await response.text();
    } catch (error) {
      const isTimeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { outcome: 'failed', failureCode: isTimeout ? 'timeout' : 'network_error' };
    }

    if (status < 200 || status >= 300) {
      return { outcome: 'failed', failureCode: `http_${status}` };
    }

    // Confirmed live: B3 answers an unrecognised issuer with HTTP 200 and a
    // completely empty body — never a 404. Nothing else observed produces an
    // empty body, so this check is unambiguous.
    if (rawBody.trim().length === 0) {
      return { outcome: 'not_listed' };
    }

    const arrayText = extractJsonArrayBlock(rawBody, 'stockDividends');
    if (arrayText === null) {
      return { outcome: 'failed', failureCode: 'unreadable_body' };
    }

    const factors: CorporateEventFactor[] = [];
    for (const entryText of arrayText.match(/\{[^{}]*\}/g) ?? []) {
      const rawLabel = extractJsonStringField(entryText, 'label');
      if (rawLabel === null) continue;
      const kind = normaliseLabel(rawLabel);
      if (kind === null) continue; // BR-008-29: only these three kinds are in scope.

      const rawFactor = extractJsonStringField(entryText, 'factor');
      if (rawFactor === null) {
        return { outcome: 'failed', failureCode: 'invalid_factor' };
      }
      const factorPublished = toDotDecimal(rawFactor);
      let multiplier;
      try {
        multiplier = factorMultiplier(kind, factorPublished);
      } catch {
        return { outcome: 'failed', failureCode: 'invalid_factor' };
      }

      const rawLastDatePrior = extractJsonStringField(entryText, 'lastDatePrior');
      if (rawLastDatePrior === null) {
        return { outcome: 'failed', failureCode: 'invalid_date' };
      }
      let lastDatePrior: BusinessDate;
      try {
        lastDatePrior = parseBrDate(rawLastDatePrior);
      } catch {
        return { outcome: 'failed', failureCode: 'invalid_date' };
      }

      const rawApprovedOn = extractJsonStringField(entryText, 'approvedOn');
      let approvedOn: BusinessDate | null = null;
      if (rawApprovedOn !== null && rawApprovedOn.trim().length > 0) {
        try {
          approvedOn = parseBrDate(rawApprovedOn);
        } catch {
          return { outcome: 'failed', failureCode: 'invalid_date' };
        }
      }

      factors.push({ issuerCode, kind, factorPublished, multiplier, lastDatePrior, approvedOn });
    }

    return { outcome: 'ok', factors };
  }
}
