import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { UserId, isUuid } from '@/core/shared/ids';

/**
 * SPEC-018 BR-018-26 — "unsubscribe is honoured **without requiring sign-in**".
 *
 * That single clause is why this file exists. Every other write in the product
 * proves who is asking by resolving an Auth.js session (AR-12); an unsubscribe
 * link cannot, because the person clicking it is in their mail client and the
 * whole point is that they do not have to go and sign in first. So the link
 * itself has to carry proof, and a *signed* token is that proof: the account it
 * names was named by this deployment, not by whoever typed the URL.
 *
 * **A capability, not a credential.** The token authorises exactly one act —
 * revoking the `email_reminders` consent for one account — and nothing else. It
 * grants no read, names no holdings, and cannot be exchanged for a session. If
 * one leaks, the worst a stranger can do is stop email the account owner can
 * turn back on from `/privacy`. That asymmetry is what makes the design below
 * acceptable; it would not be acceptable for anything that reads data.
 *
 * **AR-43** — the key comes from the environment (`AUTH_SECRET`), never from
 * the SPEC-002 registry, and never appears in a log, an error or the effective
 * config view. It is derived through HKDF with a fixed `info` string rather
 * than used raw, so a token signed here can never be confused with, or
 * substituted for, anything else `AUTH_SECRET` protects — Auth.js's own
 * session cookies above all.
 */

const HKDF_INFO = 'allmywallet/spec-018/unsubscribe/v1';
const KEY_BYTES = 32;

/**
 * The only purpose a token may carry today, embedded in the payload rather
 * than assumed by the verifier.
 *
 * A token that says nothing about what it is for is a token a future feature
 * can accidentally accept: add a second signed link later — "confirm this
 * address", "approve this export" — and without this field the two are the
 * same bytes with the same signature, so either link performs either act. The
 * field costs nine characters and closes that off permanently.
 */
const PURPOSE = 'unsubscribe' as const;

interface TokenPayload {
  readonly p: typeof PURPOSE;
  readonly u: string;
  /** Seconds since the epoch. Recorded, deliberately not enforced — see below. */
  readonly t: number;
}

function signingKey(): Buffer {
  const secret = env().AUTH_SECRET;
  if (!secret) {
    // The same failure shape as `requireAuthEnv()` in src/auth.ts: loud, named,
    // and pointing at the setup step (AR-40/AR-41 — a missing secret must not
    // degrade into an unsigned or differently-signed token).
    throw new Error('AUTH_SECRET is required to sign unsubscribe links (DEVELOPMENT.md §5).');
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, KEY_BYTES),
  );
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function signature(body: string): Buffer {
  return createHmac('sha256', signingKey()).update(body).digest();
}

/**
 * Builds the token that goes in the email's unsubscribe link.
 *
 * `issuedAt` is an argument rather than read from a clock here so the caller —
 * which already has one, a `Clock` port (TS-20) — decides what "now" is, and so
 * the token for a given account and instant is reproducible in a test.
 */
export function signUnsubscribeToken(userId: UserId, issuedAt: Date): string {
  const payload: TokenPayload = {
    p: PURPOSE,
    u: userId,
    t: Math.floor(issuedAt.getTime() / 1000),
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${base64url(signature(body))}`;
}

/**
 * Verifies a token and returns the account it names, or `null`.
 *
 * `null` for **every** failure — malformed, wrong purpose, bad signature, not a
 * UUID. The caller renders one message for all of them: telling an anonymous
 * visitor *which* part of a token failed tells an attacker the same thing, and
 * there is nothing an honest recipient of a broken link could do with the
 * distinction anyway.
 *
 * **There is no expiry, and that is a decision rather than an omission.** An
 * unsubscribe link sits in an inbox for as long as the message does, and a
 * person who finds a year-old email and wants the mail to stop is exactly the
 * person this link exists for; expiring it would send them to a sign-in page
 * to accomplish something they already asked for. The issuance time is signed
 * into the payload regardless, so a decision to start refusing old tokens is a
 * change to this function alone and needs no new token format.
 */
export function verifyUnsubscribeToken(token: string): UserId | null {
  const [body, provided] = token.split('.');
  if (!body || !provided) return null;

  const expected = signature(body);
  const received = Buffer.from(provided, 'base64url');
  // Length must match before `timingSafeEqual`, which throws on a mismatch
  // rather than returning false.
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<TokenPayload>;
  if (candidate.p !== PURPOSE) return null;
  if (typeof candidate.u !== 'string' || !isUuid(candidate.u)) return null;

  return UserId.of(candidate.u);
}
