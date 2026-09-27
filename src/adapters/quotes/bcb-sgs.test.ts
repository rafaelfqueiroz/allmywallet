import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { BcbSgsIndexSeriesProvider } from './bcb-sgs';

/** TS-26: contract-tested against a recorded (synthetic) BCB SGS response shape. */
const RECORDED_CDI_RESPONSE = `[
  {"data":"14/03/2026","valor":"11.65"},
  {"data":"15/03/2026","valor":"11.65"},
  {"data":"16/03/2026","valor":"11.70"}
]`;

function stubFetch(status: number, body: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status, text: () => Promise.resolve(body) }));
}

/** A server that accepts the request and never answers — only the abort signal ends it. */
function stubHangingFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ),
  );
}

describe('BcbSgsIndexSeriesProvider (SPEC-008 — CDI/IPCA/Selic)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a recorded CDI series response into ordered points', async () => {
    stubFetch(200, RECORDED_CDI_RESPONSE);
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('CDI', BusinessDate.of('2026-03-01'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value[0]?.date).toBe('2026-03-14');
      expect(result.value[0]?.value.toString()).toBe('11.65');
      expect(result.value[2]?.date).toBe('2026-03-16');
      expect(result.value[2]?.value.toString()).toBe('11.7');
      expect(result.value.every((p) => p.code === 'CDI' && p.source === 'bcb_sgs')).toBe(true);
    }
  });

  it('rejects IBOV — not a BCB SGS series', async () => {
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('IBOV', BusinessDate.of('2026-03-01'));
    expect(result.ok).toBe(false);
  });

  it('a 5xx response is a fault, not silently empty', async () => {
    stubFetch(500, 'error');
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('IPCA', BusinessDate.of('2026-03-01'));
    expect(result.ok).toBe(false);
  });

  it('#161: a server that never answers is UNAVAILABLE after the timeout, not a hang', async () => {
    stubHangingFetch();
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs', timeoutMs: 20 });
    const result = await provider.fetchSeries('CDI', BusinessDate.of('2026-03-01'));
    expect(result.ok).toBe(false);
  });

  it('malformed JSON does not crash', async () => {
    stubFetch(200, 'not json');
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('SELIC', BusinessDate.of('2026-03-01'));
    expect(result.ok).toBe(false);
  });
});
