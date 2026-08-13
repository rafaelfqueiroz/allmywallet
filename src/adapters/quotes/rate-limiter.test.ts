import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { TokenBucketQuoteRateLimiter } from './rate-limiter';

/**
 * SPEC-008 BR-008-17 — on-demand lookups are rate-limited per user. The point
 * is not politeness to the provider: the free tier is 15,000 requests a month
 * shared by everyone, so one user refreshing in a loop spends other users'
 * quota (BR-008-19/20's on-demand reserve is what it eats into).
 */
describe('TokenBucketQuoteRateLimiter', () => {
  const userA = UserId.generate();
  const userB = UserId.generate();

  it('allows requests up to the per-minute allowance, then refuses', () => {
    const limiter = new TokenBucketQuoteRateLimiter(3);
    expect(limiter.tryConsume(userA)).toBe(true);
    expect(limiter.tryConsume(userA)).toBe(true);
    expect(limiter.tryConsume(userA)).toBe(true);
    // Fourth within the same minute: refused.
    expect(limiter.tryConsume(userA)).toBe(false);
  });

  it('meters each user separately', () => {
    // A user exhausting their allowance must not lock anyone else out — the
    // bucket is per-user, and a shared bucket would turn one heavy user into
    // an outage for the rest.
    const limiter = new TokenBucketQuoteRateLimiter(1);
    expect(limiter.tryConsume(userA)).toBe(true);
    expect(limiter.tryConsume(userA)).toBe(false);
    expect(limiter.tryConsume(userB)).toBe(true);
  });

  it('treats a null limit as unbounded', () => {
    // `quotes.ondemand_rate_limit` defaults to null in the registry, meaning
    // "no limit configured" rather than "zero allowed" — the difference between
    // a working feature and one that refuses every request.
    const limiter = new TokenBucketQuoteRateLimiter(null);
    for (let i = 0; i < 1_000; i += 1) {
      expect(limiter.tryConsume(userA)).toBe(true);
    }
  });

  it('refuses everything at a zero allowance rather than treating it as unbounded', () => {
    // The distinction the null case exists to preserve, asserted from the other
    // side: 0 is a deliberate "none", not a missing value.
    const limiter = new TokenBucketQuoteRateLimiter(0);
    expect(limiter.tryConsume(userA)).toBe(false);
  });
});
