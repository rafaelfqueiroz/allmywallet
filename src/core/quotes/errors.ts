/**
 * SPEC-008 error codes. AR-37: stable codes with structured, personal-data-free
 * context (AR-39) — the i18n layer decides what the user actually reads.
 */
export const QuotesErrorCode = {
  /** BR-008-16: ticker not in the asset catalog — rejected before any provider call. */
  UNKNOWN_TICKER: 'QUOTES_UNKNOWN_TICKER',
  /** BR-008-17: per-user on-demand rate limit exceeded. */
  RATE_LIMITED: 'QUOTES_RATE_LIMITED',
  /**
   * BR-008-18: the provider failed or does not have this ticker, and nothing
   * usable is stored to fall back on. The system does not retry in a loop or
   * fabricate a value.
   */
  NOT_AVAILABLE: 'QUOTES_NOT_AVAILABLE',
} as const;

export type QuotesErrorCode = (typeof QuotesErrorCode)[keyof typeof QuotesErrorCode];
