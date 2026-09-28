import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { resetEnvCache } from '@/lib/env';
import { buildIndexSeriesProvider, buildTesouroProvider } from '@/worker/handlers/composition';

/**
 * #123 — the market-series endpoints are environment overrides, so the E2E
 * worker can run without reaching BCB or Tesouro. Unset means the public
 * endpoint.
 */
describe('market-series provider endpoints', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  function recordFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve({ status: 200, text: () => Promise.resolve('[]') });
      }),
    );
    return urls;
  }

  const MARCH_1 = BusinessDate.of('2026-03-01');

  it('BCB SGS defaults to the public API', async () => {
    const urls = recordFetch();
    await buildIndexSeriesProvider().fetchSeries('CDI', MARCH_1, MARCH_1);
    expect(urls[0]).toMatch(/^https:\/\/api\.bcb\.gov\.br\/dados\/serie\/bcdata\.sgs\.12\//);
  });

  it('BCB SGS honours BCB_SGS_BASE_URL', async () => {
    vi.stubEnv('BCB_SGS_BASE_URL', 'http://127.0.0.1:9/bcdata.sgs');
    resetEnvCache();
    const urls = recordFetch();
    await buildIndexSeriesProvider().fetchSeries('CDI', MARCH_1, MARCH_1);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:9\/bcdata\.sgs\.12\/dados\?/);
  });

  it('Tesouro defaults to Tesouro Transparente', async () => {
    const urls = recordFetch();
    await buildTesouroProvider().fetchDailyPrices();
    expect(urls[0]).toMatch(/^https:\/\/www\.tesourotransparente\.gov\.br\//);
  });

  it('Tesouro honours TESOURO_PRICES_URL', async () => {
    vi.stubEnv('TESOURO_PRICES_URL', 'http://127.0.0.1:9/PrecoTaxaTesouroDireto.csv');
    resetEnvCache();
    const urls = recordFetch();
    await buildTesouroProvider().fetchDailyPrices();
    expect(urls[0]).toBe('http://127.0.0.1:9/PrecoTaxaTesouroDireto.csv');
  });
});
