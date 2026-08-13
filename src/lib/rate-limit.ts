/**
 * SPEC-001 BR-001-11: authentication endpoints are rate-limited per IP and
 * per subject.
 *
 * An in-memory token bucket is sufficient at the scale this actually runs at
 * — a single VPS, a single `web` container (ARCHITECTURE §2/§14). It becomes
 * inadequate the moment the app is horizontally scaled: each instance would
 * keep its own independent bucket, so the effective limit multiplies by
 * instance count instead of staying fixed. Revisit with a Postgres- or
 * Redis-backed limiter if that ever happens — noted here rather than only in
 * a comment at the call site, because this is the file whose contract would
 * change.
 */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    /** Maximum tokens a key can hold — the burst allowance. */
    private readonly capacity: number,
    /** Refill rate, in tokens per millisecond. */
    private readonly refillPerMs: number,
  ) {}

  /** Consumes one token for `key` if available. Returns whether it was allowed. */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: now };
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsedMs * this.refillPerMs);

    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, lastRefillMs: now });
      return false;
    }

    this.buckets.set(key, { tokens: refilled - 1, lastRefillMs: now });
    return true;
  }

  /** Test/ops escape hatch — never called from a request path. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Shared across every `/api/auth/*` request in this process. 10 requests
 * burst, refilling to 1 per second (60/min) — generous enough that a normal
 * sign-in flow (which touches the endpoint a handful of times: authorize,
 * callback, session checks) never trips it, tight enough to blunt scripted
 * abuse of an endpoint that exists specifically to establish identity.
 */
export const authRateLimiter = new TokenBucketRateLimiter(10, 1 / 1000);
