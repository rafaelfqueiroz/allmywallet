import type { BusinessDate } from '@/core/shared/clock';

/**
 * SPEC-005 BR-005-28 — when the last custody import is older than the
 * configured threshold, the app says so.
 *
 * **The threshold is a parameter, never a constant.** `import.staleness_days`
 * is a config-registry key with both deployment and user levels (SPEC-002), so
 * a user who imports quarterly can widen it rather than being nagged monthly.
 * A hardcoded 30 here would make the registry entry a lie that nothing tests.
 *
 * **`null` is stale.** A user who has never imported has no custody data at
 * all, which is the strongest possible case for the prompt — not the weakest.
 * Treating "never" as "not yet due" would hide the guide from exactly the
 * person it was written for.
 *
 * Pure and date-based (AR-29): staleness is a question about days, and a
 * timestamp comparison would make the answer depend on the reader's clock time
 * rather than on the calendar.
 */
export interface StalenessInput {
  readonly lastImportAt: BusinessDate | null;
  readonly today: BusinessDate;
  readonly thresholdDays: number;
}

const MS_PER_DAY = 86_400_000;

export function daysSinceImport(
  lastImportAt: BusinessDate | null,
  today: BusinessDate,
): number | null {
  if (lastImportAt === null) return null;
  // Both ends parse to UTC midnight, so this difference is an exact multiple
  // of a day — no rounding step, which AR-09 bars anyway.
  return (Date.parse(today) - Date.parse(lastImportAt)) / MS_PER_DAY;
}

export function isImportStale({ lastImportAt, today, thresholdDays }: StalenessInput): boolean {
  const elapsed = daysSinceImport(lastImportAt, today);
  if (elapsed === null) return true;
  // Strictly greater: on the threshold day itself the data is exactly as old
  // as the user said they were willing to tolerate, and prompting then would
  // fire a day early for anyone who set the number deliberately.
  return elapsed > thresholdDays;
}
