import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/unsubscribe-token';
import { resetEnvCache } from '@/lib/env';
import { UserId } from '@/core/shared/ids';

/**
 * SPEC-018 BR-018-26 — the link in the email is the only proof of identity an
 * unsubscribe request carries, so these tests are about what a *stranger* can
 * do with one, not about the happy path.
 */
describe('unsubscribe token', () => {
  const userId = UserId.generate();
  const issuedAt = new Date('2026-08-27T14:00:00Z');

  const configuredSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    resetEnvCache();
  });

  // TS-03: one test below swaps the signing secret. Vitest keeps `process.env`
  // for the whole file, so restoring it here is what stops that test from
  // deciding the outcome of whichever one runs after it.
  afterEach(() => {
    process.env.AUTH_SECRET = configuredSecret;
    resetEnvCache();
  });

  it('round-trips the account it names', () => {
    expect(verifyUnsubscribeToken(signUnsubscribeToken(userId, issuedAt))).toBe(userId);
  });

  it('names one account and not another', () => {
    const other = UserId.generate();
    expect(verifyUnsubscribeToken(signUnsubscribeToken(other, issuedAt))).not.toBe(userId);
  });

  it('refuses a token whose payload was edited to name a different account', () => {
    const victim = UserId.generate();
    const token = signUnsubscribeToken(userId, issuedAt);
    const [body, mac] = token.split('.');
    if (!body || !mac) throw new Error('token shape changed');

    // The forgery an unsigned token would allow: swap the account, keep the tag.
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      p: string;
      u: string;
      t: number;
    };
    const forged = Buffer.from(JSON.stringify({ ...payload, u: victim }), 'utf8').toString(
      'base64url',
    );

    expect(verifyUnsubscribeToken(`${forged}.${mac}`)).toBeNull();
  });

  it('refuses a token signed under a different secret', () => {
    const token = signUnsubscribeToken(userId, issuedAt);
    process.env.AUTH_SECRET = 'a-different-secret-of-at-least-32-characters-long';
    resetEnvCache();
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no separator', 'not-a-token'],
    ['empty signature', 'eyJhIjoxfQ.'],
    ['signature of the wrong length', 'eyJhIjoxfQ.AAAA'],
    ['payload that is not JSON', `${Buffer.from('{{{', 'utf8').toString('base64url')}.AAAA`],
  ])('refuses a malformed token (%s)', (_label, token) => {
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it('refuses a correctly signed token issued for another purpose', () => {
    // The scenario the `p` field exists for: a second signed-link feature
    // reusing this key would otherwise mint tokens this verifier accepts.
    const token = signUnsubscribeToken(userId, issuedAt);
    const [, mac] = token.split('.');
    const body = Buffer.from(JSON.stringify({ p: 'export', u: userId, t: 0 }), 'utf8').toString(
      'base64url',
    );
    expect(verifyUnsubscribeToken(`${body}.${mac}`)).toBeNull();
  });

  it('does not expire — an old link still stops the email it came with', () => {
    const ancient = signUnsubscribeToken(userId, new Date('2020-01-01T00:00:00Z'));
    expect(verifyUnsubscribeToken(ancient)).toBe(userId);
  });
});
