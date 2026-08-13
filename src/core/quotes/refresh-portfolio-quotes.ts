import type { UserId } from '@/core/shared/ids';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import { QuotesErrorCode } from './errors';
import { getQuote, type QuoteReadThroughPorts, type QuoteView } from './read-through';
import type { Asset } from './ports';

export interface RefreshPortfolioResult {
  readonly refreshed: boolean;
  /** BR-008-28: present when outside session hours — no provider call was made, and why. */
  readonly reason?: 'MARKET_CLOSED';
  readonly quotes: readonly QuoteView[];
}

export interface RefreshPortfolioOptions {
  readonly cadenceMinutes: number;
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
}

/**
 * SPEC-008 BR-008-28: a user can manually refresh their portfolio's
 * valuation, rate-limited. Outside session hours this recomputes from stored
 * quotes with **no provider call**, and says so rather than appearing to do
 * nothing — the one rate-limiter check below covers the whole batch, so
 * refreshing a 40-asset portfolio does not cost 40x the limit.
 */
export async function refreshPortfolioQuotes(
  ports: QuoteReadThroughPorts,
  assets: readonly Asset[],
  userId: UserId,
  options: RefreshPortfolioOptions,
): Promise<Result<RefreshPortfolioResult, DomainError>> {
  if (!ports.rateLimiter.tryConsume(userId)) {
    return err(domainError(QuotesErrorCode.RATE_LIMITED, {}));
  }

  const sessionOpen = ports.calendar.isSessionOpen(ports.clock.now());
  const quotes: QuoteView[] = [];

  for (const asset of assets) {
    // BR-008-28: outside the session, `allowFetch: false` guarantees zero
    // provider calls even for an asset with no stored quote yet — this loop
    // recomputes from storage alone when the market is closed, exactly as
    // the rule requires. During an open session, `forceFetch: true` bypasses
    // cadence-age staleness so "refresh" actually means something.
    const result = await getQuote(ports, asset.code, {
      cadenceMinutes: options.cadenceMinutes,
      monthlyQuota: options.monthlyQuota,
      ondemandReservePct: options.ondemandReservePct,
      onDemand: true,
      userId,
      forceFetch: sessionOpen,
      allowFetch: sessionOpen,
      skipRateLimit: true,
    });
    if (result.ok) quotes.push(result.value);
  }

  const result: RefreshPortfolioResult = sessionOpen
    ? { refreshed: true, quotes }
    : { refreshed: false, reason: 'MARKET_CLOSED', quotes };
  return ok(result);
}
