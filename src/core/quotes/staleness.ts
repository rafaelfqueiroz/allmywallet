/**
 * SPEC-008 BR-008-15 / DL-008-03: a stored quote is re-fetched only when the
 * session is open **and** the entry is older than the cadence interval.
 * Outside the session a stored quote is never stale, however old — a naive
 * TTL would otherwise re-fetch an unchanging Saturday price all weekend.
 */
export function isQuoteStale(
  sessionOpen: boolean,
  cadenceMinutes: number,
  now: Date,
  fetchedAt: Date,
): boolean {
  if (!sessionOpen) return false;
  const ageMinutes = (now.getTime() - fetchedAt.getTime()) / 60_000;
  return ageMinutes > cadenceMinutes;
}
