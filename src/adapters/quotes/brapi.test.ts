import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { QuoteProviderErrorCode } from '@/core/quotes/ports';
import { BrapiQuoteProvider, extractHistoricalCloses, historyRangeFor } from './brapi';

/**
 * SPEC-021 BR-021-29 — a recorded (synthetic) `?range=1mo&interval=1d` body.
 * Each `date` is 10:00 São Paulo (13:00Z) on the trading day, as brapi stamps
 * daily candles: 1773320400 = 2026-03-12T13:00:00Z, and each later entry is
 * +86.400 per calendar day (13th = 1773406800, 16th = 1773666000).
 *
 * Every candle carries an `adjustedClose` that differs from `close`, so a
 * parser reading the wrong field fails loudly. The 13th's close is `null` (a
 * halted day) and has to come back absent, not zero.
 */
const RECORDED_HISTORY_RESPONSE = `{
  "results": [
    {
      "symbol": "PETR4",
      "regularMarketPrice": 32.40,
      "historicalDataPrice": [
        { "date": 1773320400, "open": 30.9, "high": 31.4, "low": 30.8, "close": 31.10, "volume": 1, "adjustedClose": 30.55 },
        { "date": 1773406800, "open": 31.0, "high": 31.3, "low": 30.9, "close": null, "volume": 0, "adjustedClose": null },
        { "date": 1773666000, "open": 31.9, "high": 32.6, "low": 31.8, "close": 32.12345678, "volume": 1, "adjustedClose": 31.9 }
      ]
    }
  ]
}`;

/**
 * TS-26: contract-tested against a **recorded** (synthetic, representative)
 * response shape — no test here depends on a live brapi.dev call.
 */
const RECORDED_QUOTE_RESPONSE = `{
  "results": [
    {
      "symbol": "PETR4",
      "shortName": "PETROBRAS PN",
      "regularMarketPrice": 38.42,
      "regularMarketTime": "2026-03-16T13:30:00.000Z",
      "currency": "BRL"
    }
  ],
  "requestedAt": "2026-03-16T14:00:12.000Z"
}`;

const RECORDED_EMPTY_RESULTS = `{ "results": [] }`;

function stubFetch(status: number, body: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status, text: () => Promise.resolve(body) }));
}

describe('BrapiQuoteProvider (SPEC-008 BR-008-01/19/26)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a recorded 200 response into a Money price, never through Number()', async () => {
    stubFetch(200, RECORDED_QUOTE_RESPONSE);
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('PETR4');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price.toString()).toBe('38.42');
      expect(result.value.ticker).toBe('PETR4');
      expect(result.value.source).toBe('brapi_free');
      expect(result.value.quotedAt).toEqual(new Date('2026-03-16T13:30:00.000Z'));
    }
  });

  it('BR-008-18: an empty results array (ticker the provider does not have) is NOT_FOUND, not a fault', async () => {
    stubFetch(200, RECORDED_EMPTY_RESULTS);
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('NOTATICKER');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.NOT_FOUND);
  });

  it('BR-008-27: a 5xx response is UNAVAILABLE — a transient fault, retried by the caller', async () => {
    stubFetch(503, 'Service Unavailable');
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('PETR4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.UNAVAILABLE);
  });

  it('a network failure is UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('PETR4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.UNAVAILABLE);
  });

  it('malformed JSON is UNAVAILABLE, not a crash', async () => {
    stubFetch(200, '{not json');
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('PETR4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.UNAVAILABLE);
  });

  it('preserves precision a float64 round-trip could distort (adversarial fixture)', async () => {
    // A price with more decimal digits than a naive Number() parse would keep
    // stable — proves the raw-text regex extraction, not JSON.parse's number,
    // is what actually feeds Money.
    stubFetch(
      200,
      `{"results":[{"symbol":"TEST3","regularMarketPrice":1234.98765432,"regularMarketTime":"2026-03-16T13:30:00.000Z"}]}`,
    );
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchQuote('TEST3');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.price.toString()).toBe('1234.98765432');
  });
});

describe('BrapiQuoteProvider.fetchHistoricalCloses (SPEC-021 BR-021-29)', () => {
  const d = (value: string): BusinessDate => BusinessDate.of(value);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads each day’s official close from the raw text, skips a null close, and asks for one daily range', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ status: 200, text: () => Promise.resolve(RECORDED_HISTORY_RESPONSE) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BrapiQuoteProvider({ source: 'brapi_free', apiToken: 'tok' });

    const result = await provider.fetchHistoricalCloses('PETR4', d('2026-03-12'), d('2026-03-16'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('brapi_free');
    expect(result.value.closes.map((c) => [c.date, c.close.toString()])).toEqual([
      ['2026-03-12', '31.1'],
      // 13th: close is null → absent, so catch-up records a gap.
      ['2026-03-16', '32.12345678'],
    ]);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/quote/PETR4');
    expect(url.searchParams.get('range')).toBe('1mo');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.get('token')).toBe('tok');
  });

  it('never returns a close outside the requested window', () => {
    const closes = extractHistoricalCloses(
      RECORDED_HISTORY_RESPONSE,
      d('2026-03-13'),
      d('2026-03-13'),
    );
    expect(closes).toEqual([]);
  });

  it('a body with no history array yields no closes (every requested day becomes a gap)', () => {
    expect(
      extractHistoricalCloses('{"results":[{"symbol":"PETR4"}]}', d('2026-03-12'), d('2026-03-16')),
    ).toEqual([]);
  });

  it('keeps the first candle when the provider repeats a date', () => {
    const body = `{"historicalDataPrice":[{"date":1773320400,"close":31.10},{"date":1773324000,"close":99.99}]`;
    const closes = extractHistoricalCloses(body, d('2026-03-12'), d('2026-03-12'));
    expect(closes.map((c) => c.close.toString())).toEqual(['31.1']);
  });

  it.each([
    [400, 'a plan that refuses the range'],
    [503, 'a 5xx'],
  ])('%s (%s) is UNAVAILABLE — a provider failure, not a missing close', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status, text: () => Promise.resolve('{}') }),
    );
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchHistoricalCloses('PETR4', d('2026-03-12'), d('2026-03-16'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.UNAVAILABLE);
  });

  it('a network failure or malformed JSON is UNAVAILABLE', async () => {
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const network = await provider.fetchHistoricalCloses('PETR4', d('2026-03-12'), d('2026-03-16'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('{nope') }),
    );
    const malformed = await provider.fetchHistoricalCloses(
      'PETR4',
      d('2026-03-12'),
      d('2026-03-16'),
    );
    for (const result of [network, malformed]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.UNAVAILABLE);
    }
  });

  it('an empty results array is NOT_FOUND', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('{"results":[]}') }),
    );
    const provider = new BrapiQuoteProvider({ source: 'brapi_free' });
    const result = await provider.fetchHistoricalCloses('PETR4', d('2026-03-12'), d('2026-03-16'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(QuoteProviderErrorCode.NOT_FOUND);
  });

  it.each([
    // span = calendar days (to − from) + 7 margin
    ['2026-03-12', '2026-03-16', '1mo'], //  4 + 7 = 11 ≤ 28
    ['2026-02-01', '2026-03-16', '3mo'], // 43 + 7 = 50 ≤ 89
    ['2025-12-01', '2026-03-16', '6mo'], // 105 + 7 = 112 ≤ 180
    ['2025-06-01', '2026-03-16', '1y'], // 288 + 7 = 295 ≤ 364
    ['2024-06-01', '2026-03-16', '2y'], // 653 + 7 = 660 ≤ 729
    ['2022-01-01', '2026-03-16', '5y'], // 1535 + 7 = 1542 ≤ 1826
    ['2015-01-01', '2026-03-16', 'max'],
  ])('historyRangeFor(%s, %s) = %s', (from, to, expected) => {
    expect(historyRangeFor(d(from), d(to))).toBe(expected);
  });
});
