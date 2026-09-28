import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { OfficialCloseSourceErrorCode } from '@/core/quotes/ports';
import { B3CotahistCloseSource } from './cotahist';
import { buildCotahistZip, buildSingleEntryZip, type QuoteRecordFields } from './cotahist-fixture';

function stubFetch(status: number, body: Buffer | string = Buffer.alloc(0)): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    status,
    arrayBuffer: () => Promise.resolve(typeof body === 'string' ? Buffer.from(body) : body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A server that accepts the request and never answers — only the abort signal ends it (mirrors bcb-sgs.test.ts). */
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

const SEP_25 = BusinessDate.of('2026-09-25');

describe('B3CotahistCloseSource (SPEC-008 BR-008-09/BR-008-30, DL-008-14, #171)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('parsing', () => {
    it("returns a requested ticker's close as a Money divided per FATCOT", async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes).toEqual([
          { ticker: 'PETR4', date: '2026-09-25', close: expect.anything() },
        ]);
        expect(result.value.closes[0]?.close.toString()).toBe('47.99');
        expect(result.value.lastDate).toBe('2026-09-25');
      }
    });

    it('omits a ticker that was not requested', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99' },
        { datpre: '2026-09-25', codneg: 'VALE3', preult: '70.77' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes.map((c) => c.ticker)).toEqual(['PETR4']);
      }
    });

    it('excludes a TPMERC 020 (fractional market) row for the same ticker', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'SAUD3', preult: '13.46', tpmerc: '010' },
        { datpre: '2026-09-25', codneg: 'SAUD3F', preult: '13.40', tpmerc: '020' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['SAUD3', 'SAUD3F']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes.map((c) => c.ticker)).toEqual(['SAUD3']);
      }
    });

    it('excludes other non-spot markets (012, 030…)', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99', tpmerc: '010' },
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '48.50', tpmerc: '012' },
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '49.00', tpmerc: '030' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes).toHaveLength(1);
        expect(result.value.closes[0]?.close.toString()).toBe('47.99');
      }
    });

    it('divides PREULT by a FATCOT other than 1', async () => {
      // A quote factor of 1000 with PREULT '0000000123450' -> 1234.50 / 1000 = 1.2345.
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'XPTO3', preult: '1234.50', fatcot: '1000' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['XPTO3']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes[0]?.close.toString()).toBe('1.2345');
      }
    });

    it('lastDate reflects rows of a ticker that was not requested', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-24', codneg: 'PETR4', preult: '47.00' },
        { datpre: '2026-09-25', codneg: 'VALE3', preult: '70.77' }, // not requested, but newer
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes.map((c) => c.ticker)).toEqual(['PETR4']);
        expect(result.value.lastDate).toBe('2026-09-25');
      }
    });

    it('computes lastDate as the max DATPRE even when annual rows are not in date order', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-05-10', codneg: 'PETR4', preult: '40.00' },
        { datpre: '2026-01-02', codneg: 'PETR4', preult: '38.00' },
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99' },
        { datpre: '2026-03-15', codneg: 'PETR4', preult: '41.50' },
      ];
      stubFetch(200, buildCotahistZip(rows));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchYear(2026, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes).toHaveLength(4);
        expect(result.value.closes.map((c) => c.date).sort()).toEqual([
          '2026-01-02',
          '2026-03-15',
          '2026-05-10',
          '2026-09-25',
        ]);
        expect(result.value.lastDate).toBe('2026-09-25');
      }
    });

    it('returns lastDate null for a file with no quote rows', async () => {
      stubFetch(200, buildCotahistZip([]));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.closes).toEqual([]);
        expect(result.value.lastDate).toBeNull();
      }
    });
  });

  describe('errors', () => {
    it('maps HTTP 404 to NOT_PUBLISHED', async () => {
      stubFetch(404);
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.NOT_PUBLISHED);
    });

    it('maps HTTP 500 to UNAVAILABLE', async () => {
      stubFetch(500);
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a rejected fetch to UNAVAILABLE', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a timeout (a server that never answers) to UNAVAILABLE, not a hang', async () => {
      stubHangingFetch();
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 20 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a corrupt ZIP (no End Of Central Directory) to UNAVAILABLE', async () => {
      stubFetch(200, Buffer.from('not a zip file at all'));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a ZIP whose entry does not inflate (corrupted deflate stream) to UNAVAILABLE', async () => {
      const zip = buildCotahistZip([{ datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99' }]);
      // Flip bytes inside the compressed payload — after the 30-byte local
      // header and its filename — so the deflate stream fails to inflate.
      const corrupted = Buffer.from(zip);
      const entryNameLength = 'COTAHIST_D25092026.TXT'.length;
      const dataStart = 30 + entryNameLength;
      for (let i = dataStart; i < dataStart + 8 && i < corrupted.length; i += 1) {
        corrupted[i] = 0xff;
      }
      stubFetch(200, corrupted);
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a missing/wrong header record to UNAVAILABLE', async () => {
      const zip = buildSingleEntryZip('not a cotahist header\r\n01whatever\r\n99trailer\r\n');
      stubFetch(200, zip);
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });

    it('maps a missing trailer record (truncated file) to UNAVAILABLE', async () => {
      const rows: QuoteRecordFields[] = [
        { datpre: '2026-09-25', codneg: 'PETR4', preult: '47.99' },
      ];
      stubFetch(200, buildCotahistZip(rows, { omitTrailer: true }));
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      const result = await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(OfficialCloseSourceErrorCode.UNAVAILABLE);
    });
  });

  describe('URL construction', () => {
    function recordFetchUrl(): { urls: string[] } {
      const urls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          urls.push(url);
          return Promise.resolve({ status: 404, arrayBuffer: () => Promise.resolve(Buffer.alloc(0)) });
        }),
      );
      return { urls };
    }

    it('builds the daily-file URL with zero-padded day and month', async () => {
      const { urls } = recordFetchUrl();
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      await source.fetchDay(BusinessDate.of('2026-01-05'), new Set(['PETR4']));
      expect(urls[0]).toBe(
        'https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_D05012026.ZIP',
      );
    });

    it('builds the annual-file URL', async () => {
      const { urls } = recordFetchUrl();
      const source = new B3CotahistCloseSource({ source: 'b3_cotahist', timeoutMs: 5000 });
      await source.fetchYear(2026, new Set(['PETR4']));
      expect(urls[0]).toBe('https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A2026.ZIP');
    });

    it('honours a configured baseUrl', async () => {
      const { urls } = recordFetchUrl();
      const source = new B3CotahistCloseSource({
        source: 'b3_cotahist',
        timeoutMs: 5000,
        baseUrl: 'http://127.0.0.1:9/cotahist',
      });
      await source.fetchDay(SEP_25, new Set(['PETR4']));
      expect(urls[0]).toBe('http://127.0.0.1:9/cotahist/COTAHIST_D25092026.ZIP');
    });
  });
});
