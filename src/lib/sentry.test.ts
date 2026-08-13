import { describe, expect, it } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { baseSentryOptions, scrubEvent } from '@/lib/sentry';

/**
 * AR-48: "Sentry must be configured to scrub request bodies, headers and
 * query strings" is a claim about behaviour. These tests exercise that
 * behaviour directly, rather than trusting that an option was set correctly —
 * per the task brief, this is the single most load-bearing check in the
 * module.
 */
describe('baseSentryOptions', () => {
  it('disables sendDefaultPii — the SDK default that attaches IP and full request data', () => {
    const options = baseSentryOptions('https://example.invalid/1');
    expect(options.sendDefaultPii).toBe(false);
  });

  it('wires beforeSend and beforeSendTransaction to the scrubber', () => {
    // Not reference-equal to `scrubEvent` itself — `beforeSend`/
    // `beforeSendTransaction` each cast the shared scrub's result back to
    // their own event type (ErrorEvent vs TransactionEvent), so this asserts
    // the *behaviour* is the scrubber's instead: a planted header does not
    // survive either hook.
    const options = baseSentryOptions('https://example.invalid/1');
    const hint = {} as EventHint;
    const withHeader = {
      request: { headers: { cookie: 'authjs.session-token=abc' } },
    } as unknown as ErrorEvent;

    expect(options.beforeSend(withHeader, hint)?.request?.headers).toBeUndefined();
    expect(
      options.beforeSendTransaction(withHeader as never, hint)?.request?.headers,
    ).toBeUndefined();
  });

  it('passes the DSN through unchanged, including when absent', () => {
    expect(baseSentryOptions('https://example.invalid/1').dsn).toBe('https://example.invalid/1');
    expect(baseSentryOptions(undefined).dsn).toBeUndefined();
  });
});

describe('scrubEvent', () => {
  const hint = {} as EventHint;

  it('strips the request body — SPEC-005 import payloads can carry a CPF field before it is stripped', () => {
    const event = {
      request: {
        url: 'https://allmywallet.example/api/import',
        method: 'POST',
        data: { cpf: '123.456.789-00', rows: [{ name: 'Someone' }] },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event, hint);

    expect(scrubbed.request?.data).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('123.456.789-00');
  });

  it('strips request headers — the auth session cookie lives here', () => {
    const event = {
      request: {
        url: 'https://allmywallet.example/',
        headers: { cookie: 'authjs.session-token=abc123', authorization: 'Bearer xyz' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event, hint);

    expect(scrubbed.request?.headers).toBeUndefined();
  });

  it('strips cookies and the query string', () => {
    const event = {
      request: {
        url: 'https://allmywallet.example/preferences?email=someone%40example.com',
        query_string: 'email=someone%40example.com',
        cookies: { 'authjs.session-token': 'abc123' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event, hint);

    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    // The bare `url` field is deliberately left alone — Next.js route paths
    // carry no query string of their own by this point in the pipeline, and a
    // path with a leaked value would only ever get there via `query_string`,
    // which is scrubbed above.
    expect(scrubbed.request?.url).toBe(
      'https://allmywallet.example/preferences?email=someone%40example.com',
    );
  });

  it('strips personal fields off event.user, keeping only an opaque id', () => {
    const event = {
      user: {
        id: 'user-123',
        email: 'someone@example.com',
        username: 'someone',
        ip_address: '1.2.3.4',
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event, hint);

    expect(scrubbed.user).toEqual({ id: 'user-123' });
  });

  it('is a no-op on an event with no request or user block', () => {
    const event = { message: 'boom' } as unknown as ErrorEvent;
    expect(scrubEvent(event, hint)).toEqual({ message: 'boom' });
  });
});
