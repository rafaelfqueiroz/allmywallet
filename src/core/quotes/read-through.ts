import type { Money } from '@/core/shared/money';
import type { AssetId, UserId } from '@/core/shared/ids';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import { QuotesErrorCode } from './errors';
import { isQuoteStale } from './staleness';
import { hasOndemandBudget } from './budget';
import type {
  AssetCatalogPort,
  BudgetCounterPort,
  Clock,
  LatestQuote,
  QuoteProvider,
  QuoteRateLimiter,
  QuoteRepositoryPort,
  TradingCalendar,
} from './ports';

/**
 * SPEC-008 BR-008-13..18/24 — on-demand read-through. "The database is the
 * system of record; the provider is consulted only when the database cannot
 * answer" (spec Description) is this function.
 */
export interface QuoteReadThroughPorts {
  readonly catalog: AssetCatalogPort;
  readonly repository: QuoteRepositoryPort;
  readonly provider: QuoteProvider;
  readonly calendar: TradingCalendar;
  readonly clock: Clock;
  readonly budgetCounter: BudgetCounterPort;
  readonly rateLimiter: QuoteRateLimiter;
}

export interface QuoteView {
  readonly assetId: AssetId;
  readonly ticker: string;
  readonly price: Money;
  /** BR-008-04: the quote timestamp — when the provider says this price is as-of. */
  readonly quotedAt: Date;
  readonly fetchedAt: Date;
  readonly source: string;
  /** BR-008-04: the delay tier, in plain terms a UI can render — "quotes.cadence_minutes" as resolved for this call. */
  readonly delayTierMinutes: number;
  readonly sessionOpen: boolean;
  /** BR-008-24: never shown as current when it is not. */
  readonly isStale: boolean;
}

export interface GetQuoteOptions {
  /** The effective `quotes.cadence_minutes` (may be runtime-degraded, BR-008-22) — read by the caller, since core/ cannot read config. */
  readonly cadenceMinutes: number;
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
  readonly onDemand: boolean;
  /** Required when `onDemand` is true and `skipRateLimit` is not set. */
  readonly userId?: UserId;
  /** BR-008-28: manual refresh forces an attempt during an open session, bypassing cadence-age staleness — never outside one. */
  readonly forceFetch?: boolean;
  /** Set by a caller (e.g. `refreshPortfolioQuotes`) that already checked the limiter once for a whole batch. */
  readonly skipRateLimit?: boolean;
  /**
   * Default `true`. BR-008-28: `refreshPortfolioQuotes` sets this to
   * `sessionOpen` so a manual refresh outside market hours makes **no**
   * provider call even for an asset with no stored quote yet — overriding
   * BR-008-13's ordinary "a miss always fetches" behaviour, which is correct
   * for a plain on-demand lookup but not for a bulk refresh gated on the
   * session being open.
   */
  readonly allowFetch?: boolean;
}

function yearMonthOf(clock: Clock): string {
  return clock.today().slice(0, 7);
}

/**
 * SPEC-008 BR-008-13: a lookup for an asset with no stored quote fetches
 * once, persists it, and serves it — every subsequent lookup, by any user, is
 * answered from the database (quotes are shared, BR-008-25).
 *
 * SPEC-008 BR-008-14: a fetch reached through this function never joins the
 * scheduled polling set — that set is derived solely from held positions
 * (`polling-set.ts`), and nothing here writes to it.
 */
export async function getQuote(
  ports: QuoteReadThroughPorts,
  ticker: string,
  options: GetQuoteOptions,
): Promise<Result<QuoteView, DomainError>> {
  // BR-008-16: catalog validation before any provider call — a typo cannot spend budget.
  const asset = await ports.catalog.findByCode(ticker);
  if (!asset) {
    return err(domainError(QuotesErrorCode.UNKNOWN_TICKER, { ticker }));
  }

  // BR-008-17: on-demand lookups are rate-limited per user.
  if (options.onDemand && !options.skipRateLimit) {
    if (!options.userId) {
      // A caller bug, not a domain outcome — every real on-demand call site
      // has an authenticated user (AR-12).
      throw new Error('getQuote: onDemand lookups require a userId');
    }
    if (!ports.rateLimiter.tryConsume(options.userId)) {
      return err(domainError(QuotesErrorCode.RATE_LIMITED, { ticker }));
    }
  }

  const now = ports.clock.now();
  const sessionOpen = ports.calendar.isSessionOpen(now);
  let stored = await ports.repository.getLatestQuote(asset.id);

  const staleByAge = stored
    ? isQuoteStale(sessionOpen, options.cadenceMinutes, now, stored.fetchedAt)
    : false;
  // BR-008-15/DL-008-03: outside the session a stored value is never stale,
  // however old — but a genuine miss (no stored value at all) still needs one
  // fetch regardless of session state, since there is nothing to serve otherwise.
  // `allowFetch: false` (BR-008-28's closed-market refresh) overrides even that.
  let needsFetch =
    options.allowFetch === false
      ? false
      : !stored || (sessionOpen && (staleByAge || Boolean(options.forceFetch)));

  // BR-008-20: on-demand spend cannot dip into the scheduled share.
  let budgetExhausted = false;
  if (needsFetch) {
    const usage = await ports.budgetCounter.getUsage(yearMonthOf(ports.clock));
    if (!hasOndemandBudget(usage, options.monthlyQuota, options.ondemandReservePct)) {
      budgetExhausted = true;
      needsFetch = false;
    }
  }

  if (needsFetch) {
    const fetched = await ports.provider.fetchQuote(asset.code);
    if (!fetched.ok) {
      // BR-008-18/BR-008-27: a provider failure does not loop-retry here — the
      // caller (or a later scheduled poll) gets the next attempt. If nothing
      // is stored, there is genuinely nothing to serve.
      if (!stored) {
        return err(
          domainError(QuotesErrorCode.NOT_AVAILABLE, { ticker, providerError: fetched.error.code }),
        );
      }
    } else {
      const fresh: LatestQuote = {
        assetId: asset.id,
        price: fetched.value.price,
        quotedAt: fetched.value.quotedAt,
        fetchedAt: now,
        source: fetched.value.source,
      };
      await ports.repository.upsertLatestQuote(fresh);
      await ports.budgetCounter.increment(yearMonthOf(ports.clock), 'ondemand');
      stored = fresh;
    }
  }

  if (!stored) {
    // Outside session, no stored value, and (per the loop above) either no
    // fetch was attempted or it failed — nothing to serve.
    return err(domainError(QuotesErrorCode.NOT_AVAILABLE, { ticker }));
  }

  // BR-008-24: quota exhaustion never hides behind a value that looks current.
  const isStale =
    budgetExhausted || isQuoteStale(sessionOpen, options.cadenceMinutes, now, stored.fetchedAt);

  return ok({
    assetId: asset.id,
    ticker: asset.code,
    price: stored.price,
    quotedAt: stored.quotedAt,
    fetchedAt: stored.fetchedAt,
    source: stored.source,
    delayTierMinutes: options.cadenceMinutes,
    sessionOpen,
    isStale,
  });
}
