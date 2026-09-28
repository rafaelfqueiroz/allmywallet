import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { BcbSgsErrorCode, BcbSgsIndexSeriesProvider, sgsRequestWindows } from './bcb-sgs';

/** TS-26: contract-tested against a recorded (synthetic) BCB SGS response shape. */
const RECORDED_CDI_RESPONSE = `[
  {"data":"14/03/2026","valor":"11.65"},
  {"data":"15/03/2026","valor":"11.65"},
  {"data":"16/03/2026","valor":"11.70"}
]`;

/**
 * #123: BCB's refusal bodies, transcribed from live probes of the public SGS
 * API on 2026-09-28 — public data, not an extract.
 */
const WINDOW_TOO_WIDE_406 = `{"error":"O sistema aceita uma janela de consulta de, no máximo, 10 anos em séries de periodicidade diária","message":"Para acessar uma série de periodicidade diária, informe os parâmetros dataInicial e dataFinal."}`;
const VALUES_NOT_FOUND_404 = `{"erro":{"statusCode":404,"detail":"br.gov.bcb.pec.sgs.comum.excecoes.SGSNegocioException: Value(s) not found"}}`;

function stubFetch(status: number, body: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ status, text: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MARCH_1 = BusinessDate.of('2026-03-01');
const MARCH_31 = BusinessDate.of('2026-03-31');

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
    const result = await provider.fetchSeries('CDI', MARCH_1, MARCH_31);
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
    const result = await provider.fetchSeries('IBOV', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
  });

  it('#123: asks for a bounded range — dataInicial and dataFinal, both DD/MM/YYYY', async () => {
    const fetchMock = stubFetch(200, RECORDED_CDI_RESPONSE);
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    await provider.fetchSeries('CDI', MARCH_1, MARCH_31);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=01/03/2026&dataFinal=31/03/2026',
    );
  });

  it('a 5xx response is a fault, not silently empty', async () => {
    stubFetch(500, 'error');
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('IPCA', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: BcbSgsErrorCode.UNAVAILABLE,
        context: { code: 'IPCA', status: 500, message: null },
      });
    }
  });

  it('#123: a 406 is REJECTED with its status and BCB’s reason, not UNAVAILABLE', async () => {
    stubFetch(406, WINDOW_TOO_WIDE_406);
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('CDI', BusinessDate.of('2000-01-01'), MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: BcbSgsErrorCode.REJECTED,
        context: {
          code: 'CDI',
          status: 406,
          message:
            'O sistema aceita uma janela de consulta de, no máximo, 10 anos em séries de periodicidade diária',
        },
      });
    }
  });

  it('#123: a 404 is NO_DATA, carrying BCB’s detail', async () => {
    stubFetch(404, VALUES_NOT_FOUND_404);
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('SELIC', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(BcbSgsErrorCode.NO_DATA);
      expect(result.error.context).toMatchObject({ code: 'SELIC', status: 404 });
      expect(result.error.context.message).toContain('Value(s) not found');
    }
  });

  it('#123: a refusal body that is not BCB’s shape still keeps the status', async () => {
    stubFetch(400, '<html>Bad Request</html>');
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('CDI', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: BcbSgsErrorCode.REJECTED,
        context: { code: 'CDI', status: 400, message: null },
      });
    }
  });

  it('#123: a 2xx carrying an error object is MALFORMED_RESPONSE, distinct from a refusal', async () => {
    stubFetch(200, WINDOW_TOO_WIDE_406);
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('CDI', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: BcbSgsErrorCode.MALFORMED_RESPONSE,
        context: { code: 'CDI', status: 200 },
      });
    }
  });

  it('#161: a server that never answers is UNAVAILABLE after the timeout, not a hang', async () => {
    stubHangingFetch();
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs', timeoutMs: 20 });
    const result = await provider.fetchSeries('CDI', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
  });

  it('malformed JSON does not crash', async () => {
    stubFetch(200, 'not json');
    const provider = new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
    const result = await provider.fetchSeries('SELIC', MARCH_1, MARCH_31);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(BcbSgsErrorCode.MALFORMED_RESPONSE);
  });
});

describe('sgsRequestWindows (#123 — BCB’s 10-year daily-series limit)', () => {
  const windows = (since: string, until: string) =>
    sgsRequestWindows(BusinessDate.of(since), BusinessDate.of(until));

  it('splits a 26-year backfill into consecutive windows, oldest first', () => {
    expect(windows('2000-01-01', '2026-09-28')).toEqual([
      { since: '2000-01-01', until: '2009-12-31' },
      { since: '2010-01-01', until: '2019-12-31' },
      { since: '2020-01-01', until: '2026-09-28' },
    ]);
  });

  it('a range inside the limit is one window', () => {
    expect(windows('2026-09-25', '2026-09-28')).toEqual([
      { since: '2026-09-25', until: '2026-09-28' },
    ]);
  });

  it('a single day is one window', () => {
    expect(windows('2026-09-28', '2026-09-28')).toEqual([
      { since: '2026-09-28', until: '2026-09-28' },
    ]);
  });

  it('nothing to fetch when since is after until', () => {
    expect(windows('2026-09-29', '2026-09-28')).toEqual([]);
  });

  it('a window starting on a leap day ends the day before its tenth anniversary', () => {
    expect(windows('2000-02-29', '2011-01-01')[0]).toEqual({
      since: '2000-02-29',
      until: '2010-02-28',
    });
  });
});
