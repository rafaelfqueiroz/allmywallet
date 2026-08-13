import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limit';

describe('TokenBucketRateLimiter (SPEC-001 BR-001-11)', () => {
  it('allows up to capacity requests in a burst, then refuses', () => {
    const limiter = new TokenBucketRateLimiter(3, 1 / 1000);
    const now = 0;
    expect(limiter.tryConsume('ip-1', now)).toBe(true);
    expect(limiter.tryConsume('ip-1', now)).toBe(true);
    expect(limiter.tryConsume('ip-1', now)).toBe(true);
    expect(limiter.tryConsume('ip-1', now)).toBe(false);
  });

  it('refills over time, at the configured rate', () => {
    const limiter = new TokenBucketRateLimiter(1, 1 / 1000); // 1 token/sec
    expect(limiter.tryConsume('ip-1', 0)).toBe(true);
    expect(limiter.tryConsume('ip-1', 500)).toBe(false); // half a second later, not refilled yet
    expect(limiter.tryConsume('ip-1', 1000)).toBe(true); // a full second later, refilled
  });

  it('tracks distinct keys independently', () => {
    const limiter = new TokenBucketRateLimiter(1, 1 / 1000);
    expect(limiter.tryConsume('ip-1', 0)).toBe(true);
    expect(limiter.tryConsume('ip-1', 0)).toBe(false);
    // A different key (a different caller IP) has its own, unaffected bucket.
    expect(limiter.tryConsume('ip-2', 0)).toBe(true);
  });

  it('reset() clears every bucket (test/ops escape hatch)', () => {
    const limiter = new TokenBucketRateLimiter(1, 1 / 1000);
    expect(limiter.tryConsume('ip-1', 0)).toBe(true);
    expect(limiter.tryConsume('ip-1', 0)).toBe(false);
    limiter.reset();
    expect(limiter.tryConsume('ip-1', 0)).toBe(true);
  });

  it('never exceeds capacity even after a long idle period', () => {
    const limiter = new TokenBucketRateLimiter(2, 1 / 1000);
    expect(limiter.tryConsume('ip-1', 0)).toBe(true);
    // A huge gap must not let the bucket accumulate beyond capacity.
    expect(limiter.tryConsume('ip-1', 1_000_000)).toBe(true);
    expect(limiter.tryConsume('ip-1', 1_000_000)).toBe(true);
    expect(limiter.tryConsume('ip-1', 1_000_000)).toBe(false);
  });
});
