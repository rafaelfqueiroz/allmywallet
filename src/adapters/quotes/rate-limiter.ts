import { TokenBucketRateLimiter } from '@/lib/rate-limit';
import type { UserId } from '@/core/shared/ids';
import type { QuoteRateLimiter } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-17 — on-demand lookups rate-limited per user, via the same
 * in-memory token-bucket primitive `src/lib/rate-limit.ts` already uses for
 * auth (single VPS, single `web` process — ARCHITECTURE §2/§14; the same
 * revisit-if-scaled note applies here).
 *
 * `quotes.ondemand_rate_limit` is requests-per-minute, or `null` for
 * unbounded (the registry's stated meaning, `src/config/registry.ts`) — a
 * refill rate of `Infinity` tokens/ms models "unbounded" without a branch
 * that skips the bucket machinery entirely.
 */
export class TokenBucketQuoteRateLimiter implements QuoteRateLimiter {
  private readonly limiter: TokenBucketRateLimiter | undefined;

  constructor(requestsPerMinute: number | null) {
    if (requestsPerMinute === null) {
      this.limiter = undefined;
      return;
    }
    // Burst allowance equals one minute's worth; refill spreads it evenly.
    this.limiter = new TokenBucketRateLimiter(requestsPerMinute, requestsPerMinute / 60_000);
  }

  tryConsume(userId: UserId): boolean {
    if (!this.limiter) return true; // unbounded
    return this.limiter.tryConsume(userId);
  }
}
