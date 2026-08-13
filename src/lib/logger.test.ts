import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS, hashUserId } from '@/lib/logger';

describe('hashUserId', () => {
  const userId = '0195f3a0-8b2c-7c4a-9f1e-2d3c4b5a6978';

  it('is stable, so a user’s requests can be correlated', () => {
    expect(hashUserId(userId)).toBe(hashUserId(userId));
  });

  it('is not reversible to the id it came from', () => {
    // AR-49: logs carry a *hashed* user id — never an email, a name or a CPF,
    // and never the raw id either, which is a join key into everything.
    const hashed = hashUserId(userId);
    expect(hashed).not.toContain(userId);
    expect(userId).not.toContain(hashed);
  });

  it('separates two users', () => {
    expect(hashUserId(userId)).not.toBe(hashUserId('0195f3a0-8b2c-7c4a-9f1e-2d3c4b5a6979'));
  });

  it('is short enough that nobody mistakes it for an id', () => {
    expect(hashUserId(userId)).toHaveLength(16);
    expect(hashUserId(userId)).toMatch(/^[0-9a-f]{16}$/);
  });
});

/**
 * SPEC-016 BR-016-12/AR-48: "application logging is structured and contains
 * no personal data." Asserted against `LOGGER_OPTIONS` — the exact
 * configuration `logger` and every `childLogger(...)` ships with — by
 * planting known PII values and scanning the real serialized output for
 * them, rather than trusting that `redact.paths` lists the right keys.
 *
 * Scope note for the SPEC-016 #19 report: the acceptance criterion asks for
 * this scan "across a full import, valuation and report cycle" — none of
 * those flows exist yet (SPEC-005/006/009/011 are separate, not-yet-built
 * specs). This proves the *mechanism* those flows will all inherit works
 * correctly today; it is not itself the full-cycle scan the AC ultimately
 * wants, which can only exist once those flows do.
 */
describe('logger redaction (SPEC-016 BR-016-12, AR-48)', () => {
  function loggerToBuffer(): { logger: pino.Logger; output: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    return { logger: pino(LOGGER_OPTIONS, stream), output: () => chunks.join('') };
  }

  const SEEDED_EMAIL = 'investidor.teste@example.com';
  const SEEDED_NAME = 'Fulano de Tal';
  const SEEDED_CPF = '123.456.789-00';
  const SEEDED_PASSWORD = 'never-log-this-secret';

  it('strips a top-level email/name/cpf/password from a log line', () => {
    const { logger: probe, output } = loggerToBuffer();

    probe.info(
      { email: SEEDED_EMAIL, name: SEEDED_NAME, cpf: SEEDED_CPF, password: SEEDED_PASSWORD },
      'seeded PII scan — top level',
    );

    const serialized = output();
    expect(serialized).not.toContain(SEEDED_EMAIL);
    expect(serialized).not.toContain(SEEDED_NAME);
    expect(serialized).not.toContain(SEEDED_CPF);
    expect(serialized).not.toContain(SEEDED_PASSWORD);
  });

  it('strips the same fields one level deep — the `*.field` wildcard paths', () => {
    const { logger: probe, output } = loggerToBuffer();

    probe.info(
      {
        user: { email: SEEDED_EMAIL, name: SEEDED_NAME, cpf: SEEDED_CPF },
        importRow: { raw_payload: { cpf: SEEDED_CPF } },
      },
      'seeded PII scan — nested one level',
    );

    const serialized = output();
    expect(serialized).not.toContain(SEEDED_EMAIL);
    expect(serialized).not.toContain(SEEDED_NAME);
    expect(serialized).not.toContain(SEEDED_CPF);
  });

  it('a child logger (the shape every real call site uses) inherits the same redaction', () => {
    const { logger: probe, output } = loggerToBuffer();
    const child = probe.child({ component: 'test' });

    child.warn(
      { email: SEEDED_EMAIL, name: SEEDED_NAME, cpf: SEEDED_CPF },
      'seeded PII scan — via child logger',
    );

    const serialized = output();
    expect(serialized).not.toContain(SEEDED_EMAIL);
    expect(serialized).not.toContain(SEEDED_NAME);
    expect(serialized).not.toContain(SEEDED_CPF);
  });

  it('does not redact unrelated fields — the point is scrubbing PII, not disabling logging', () => {
    const { logger: probe, output } = loggerToBuffer();
    probe.info({ requestId: 'req-123', route: '/api/example' }, 'ordinary log line');
    const serialized = output();
    expect(serialized).toContain('req-123');
    expect(serialized).toContain('/api/example');
  });
});
