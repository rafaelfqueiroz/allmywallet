import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteProviderErrorCode } from '@/core/quotes/ports';
import { BrapiQuoteProvider } from './brapi';

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
