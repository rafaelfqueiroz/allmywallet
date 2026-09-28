import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { resetEnvCache } from '@/lib/env';
import { fakeTx } from '@/config/test-support/fake-tx';
import type { Database } from '@/db/client';
import {
  buildIndexSeriesProvider,
  buildOfficialCloseSource,
  buildTesouroProvider,
} from '@/worker/handlers/composition';

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

  /** SPEC-008 BR-008-30, DL-008-14 (#171): same env-override pattern, no deployment database needed for the URL itself. */
  it('COTAHIST defaults to the public B3 archive', async () => {
    // vitest.config.ts points every test at a closed port; unset it here.
    vi.stubEnv('B3_COTAHIST_BASE_URL', undefined);
    resetEnvCache();
    const urls = recordFetch();
    const database = fakeTx({ selectRows: [] }) as unknown as Database;
    const source = await buildOfficialCloseSource(database);
    await source.fetchDay(MARCH_1, new Set(['PETR4']));
    expect(urls[0]).toMatch(/^https:\/\/bvmf\.bmfbovespa\.com\.br\/InstDados\/SerHist\//);
  });

  it('COTAHIST honours B3_COTAHIST_BASE_URL', async () => {
    vi.stubEnv('B3_COTAHIST_BASE_URL', 'http://127.0.0.1:9/cotahist');
    resetEnvCache();
    const urls = recordFetch();
    const database = fakeTx({ selectRows: [] }) as unknown as Database;
    const source = await buildOfficialCloseSource(database);
    await source.fetchDay(MARCH_1, new Set(['PETR4']));
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:9\/cotahist\//);
  });
});
