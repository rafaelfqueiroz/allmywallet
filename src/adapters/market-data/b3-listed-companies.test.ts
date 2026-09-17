import { describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import { B3ListedCompaniesFactorSource, b3ListedCompaniesUrl } from './b3-listed-companies';

/**
 * TS-26/DV-24/TS-19 — hand-written, trimmed fixtures. **Never a captured
 * response**: the real envelope was observed live while building this
 * adapter (see the class docstring) but no live body is reproduced here.
 * Unrelated arrays (`cashDividends`, `subscriptions`) and fields B3 sends
 * but this adapter ignores (`assetIssued`, `isinCode`, `remarks`) are
 * trimmed out entirely rather than copied — only what the parser reads.
 */
function envelope(stockDividendsJson: string): string {
  return `[{"code":"TEST","cashDividends":[],"stockDividends":${stockDividendsJson},"subscriptions":[]}]`;
}

function fetchReturning(status: number, body: string): typeof fetch {
  return vi
    .fn()
    .mockResolvedValue({ status, text: () => Promise.resolve(body) }) as unknown as typeof fetch;
}

describe('B3ListedCompaniesFactorSource (SPEC-008 BR-008-29, #113)', () => {
  it('requests exactly base64({"issuingCompany":"<CODE>","language":"pt-br"})', async () => {
    const fetchMock = fetchReturning(200, envelope('[]'));
    const source = new B3ListedCompaniesFactorSource(10_000, fetchMock);

    await source.fetchIssuer('MGLU');

    expect(b3ListedCompaniesUrl('MGLU')).toBe(
      'https://sistemaswebb3-listados.b3.com.br/listedCompaniesProxy/CompanyCall/GetListedSupplementCompany/eyJpc3N1aW5nQ29tcGFueSI6Ik1HTFUiLCJsYW5ndWFnZSI6InB0LWJyIn0=',
    );
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      b3ListedCompaniesUrl('MGLU'),
    );
  });

  it('normalises all three kinds and ignores an unrelated label (DIVIDENDO)', async () => {
    const body = envelope(`[
      {"factor":"0,1","label":"GRUPAMENTO","approvedOn":"24/04/2024","lastDatePrior":"24/05/2024"},
      {"factor":"300","label":"DESDOBRAMENTO","approvedOn":"07/10/2020","lastDatePrior":"13/10/2020"},
      {"factor":"5","label":"BONIFICACAO","approvedOn":"22/12/2025","lastDatePrior":"29/12/2025"},
      {"factor":"1,25","label":"DIVIDENDO","approvedOn":"01/01/2024","lastDatePrior":"01/01/2024"}
    ]`);
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, body));

    const result = await source.fetchIssuer('MGLU');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.factors).toHaveLength(3); // DIVIDENDO excluded

    const grupamento = result.factors.find((f) => f.kind === 'grupamento');
    expect(grupamento?.factorPublished).toBe('0.1');
    expect(grupamento?.multiplier.equals(Quantity.fromString('0.1'))).toBe(true);
    expect(grupamento?.lastDatePrior).toBe(BusinessDate.of('2024-05-24'));
    expect(grupamento?.approvedOn).toBe(BusinessDate.of('2024-04-24'));

    const desdobramento = result.factors.find((f) => f.kind === 'desdobramento');
    expect(desdobramento?.factorPublished).toBe('300');
    expect(desdobramento?.multiplier.equals(Quantity.fromString('4'))).toBe(true);

    const bonificacao = result.factors.find((f) => f.kind === 'bonificacao');
    expect(bonificacao?.factorPublished).toBe('5');
    expect(bonificacao?.multiplier.equals(Quantity.fromString('1.05'))).toBe(true);
  });

  it('a thousands-separated pt-BR factor ("1.000") publishes as "1000"', async () => {
    const body = envelope(
      `[{"factor":"1.000","label":"DESDOBRAMENTO","approvedOn":"01/01/2024","lastDatePrior":"01/01/2024"}]`,
    );
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, body));

    const result = await source.fetchIssuer('MGLU');

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.factors[0]?.factorPublished).toBe('1000');
  });

  it('empty stockDividends is ok with no factors — a listed issuer with no corporate-event history', async () => {
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, envelope('[]')));

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'ok', factors: [] });
  });

  it('an unlisted issuer — HTTP 200 with a completely empty body — is not_listed', async () => {
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, ''));

    const result = await source.fetchIssuer('ZQXW');

    expect(result).toEqual({ outcome: 'not_listed' });
  });

  it('a non-2xx status is failed with an http_<status> code, never the body', async () => {
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(500, 'oops'));

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'failed', failureCode: 'http_500' });
  });

  it('AR-06: a numeric (unquoted) JSON factor is rejected, never wrapped in a number', async () => {
    const body = envelope(
      `[{"factor":0.1,"label":"GRUPAMENTO","approvedOn":"24/04/2024","lastDatePrior":"24/05/2024"}]`,
    );
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, body));

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'failed', failureCode: 'invalid_factor' });
  });

  it('an unparseable lastDatePrior is failed with a code, never the body', async () => {
    const body = envelope(
      `[{"factor":"5","label":"BONIFICACAO","approvedOn":"01/01/2024","lastDatePrior":"31/02/2024"}]`,
    );
    const source = new B3ListedCompaniesFactorSource(10_000, fetchReturning(200, body));

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'failed', failureCode: 'invalid_date' });
  });

  it('an unreadable body (no stockDividends key at all) is failed, never the body', async () => {
    const source = new B3ListedCompaniesFactorSource(
      10_000,
      fetchReturning(200, '<html>error</html>'),
    );

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'failed', failureCode: 'unreadable_body' });
  });

  it('a request past the timeout is failed with code "timeout" — a fake fetch that honours the abort signal', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    const source = new B3ListedCompaniesFactorSource(20, fetchMock as unknown as typeof fetch);

    const result = await source.fetchIssuer('MGLU');

    expect(result).toEqual({ outcome: 'failed', failureCode: 'timeout' });
  });
});
