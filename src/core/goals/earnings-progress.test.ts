import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { EarningRecord, EarningType } from '@/core/reporting/ports';
import { GoalErrorCode } from '@/core/goals/errors';
import type { WalletGoal } from '@/core/goals/goal';
import type { GoalAllocationEvent } from '@/core/goals/ports';
import {
  earningsProgress,
  goalYears,
  type EarningsMonth,
  type EarningsProgress,
} from '@/core/goals/earnings-progress';

/**
 * SPEC-019 BR-019-14..23 — the earnings chart, over exactly one calendar year.
 *
 * TS-05: every average below is hand-computed and the division is written into
 * the test. The year-to-date average is the figure most likely to be silently
 * wrong — it differs from SPEC-014's twelve-month moving average by design
 * (DL-019-03), so "it matches the Earnings report" is not available as a check.
 */

const USER = UserId.generate();
const WALLET = WalletId.generate();
const OTHER_WALLET = WalletId.generate();
const HGLG11 = AssetId.generate();
const PETR4 = AssetId.generate();

const AS_OF_MARCH_2026 = BusinessDate.of('2026-03-15');

function earning(payDate: string, amount: string, type: EarningType = 'rendimento'): EarningRecord {
  return {
    assetId: HGLG11,
    institutionId: null,
    type,
    payDate: BusinessDate.of(payDate),
    amount: Money.fromString(amount),
    quantity: Quantity.fromString('100'),
  };
}

function goalOf(overrides: Partial<WalletGoal> = {}): WalletGoal {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: WalletGoalId.generate(),
    userId: USER,
    walletId: WALLET,
    name: 'Renda mensal',
    kind: 'earnings',
    amount: Money.fromString('1000'),
    basis: null,
    period: 'monthly',
    achievedOn: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function allocation(
  effectiveOn: string,
  assetId: AssetId,
  quantity: string,
  walletId: WalletId = WALLET,
): GoalAllocationEvent {
  return {
    walletId,
    assetId,
    quantity: Quantity.fromString(quantity),
    effectiveOn: BusinessDate.of(effectiveOn),
    costBasisAfter: Money.fromString('1000'),
  };
}

/**
 * A closed year paying R$ 100,00 in January and rising by R$ 100,00 a month to
 * R$ 1.200,00 in December. March is paid in two instalments of R$ 150,00, so
 * the fold that adds two payments in one month is exercised rather than
 * assumed.
 *
 *   total = 100 × (1 + 2 + … + 12) = 100 × 78 = 7.800,00
 */
const YEAR_2025: readonly EarningRecord[] = [
  earning('2025-01-15', '100'),
  earning('2025-02-16', '200'),
  earning('2025-03-10', '150'),
  earning('2025-03-25', '150'),
  earning('2025-04-15', '400'),
  earning('2025-05-15', '500'),
  earning('2025-06-15', '600'),
  earning('2025-07-15', '700'),
  earning('2025-08-15', '800'),
  earning('2025-09-15', '900'),
  earning('2025-10-15', '1000'),
  earning('2025-11-15', '1100'),
  earning('2025-12-15', '1200'),
];

function unwrap(result: ReturnType<typeof earningsProgress>): EarningsProgress {
  if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`);
  return result.value;
}

function month(progress: EarningsProgress, key: string): EarningsMonth {
  const found = progress.months.find((candidate) => candidate.month === key);
  if (found === undefined) throw new Error(`no month ${key}`);
  return found;
}

function elapsed(progress: EarningsProgress, key: string) {
  const found = month(progress, key);
  if (found.kind !== 'elapsed') throw new Error(`${key} has not elapsed`);
  return found;
}

describe('BR-019-17/18 — the year-to-date average', () => {
  const progress = unwrap(
    earningsProgress(goalOf({ period: 'yearly' }), YEAR_2025, 2025, AS_OF_MARCH_2026),
  );

  it('at January equals January alone', () => {
    // 100,00 ÷ 1 = 100,00
    expect(elapsed(progress, '2025-01').amount.toString()).toBe('100');
    expect(elapsed(progress, '2025-01').yearToDateAverage.toString()).toBe('100');
  });

  it('at June equals the mean of the six months elapsed', () => {
    // 100 + 200 + 300 + 400 + 500 + 600 = 2.100,00
    // 2.100,00 ÷ 6 = 350,00
    expect(elapsed(progress, '2025-06').cumulative.toString()).toBe('2100');
    expect(elapsed(progress, '2025-06').yearToDateAverage.toString()).toBe('350');
  });

  it('at December equals the mean of twelve', () => {
    // 100 × (1 + 2 + … + 12) = 100 × 78 = 7.800,00
    // 7.800,00 ÷ 12 = 650,00
    expect(elapsed(progress, '2025-12').cumulative.toString()).toBe('7800');
    expect(elapsed(progress, '2025-12').yearToDateAverage.toString()).toBe('650');
    expect(progress.total.toString()).toBe('7800');
  });

  it('adds two payments landing in the same month', () => {
    // 150,00 + 150,00 = 300,00
    expect(elapsed(progress, '2025-03').amount.toString()).toBe('300');
    // 100 + 200 + 300 = 600,00 ÷ 3 = 200,00
    expect(elapsed(progress, '2025-03').yearToDateAverage.toString()).toBe('200');
  });

  it('BR-019-16 — the cumulative line restarts at each January', () => {
    // February's running total is February's own year's, not a continuation of
    // the previous December's 7.800,00.
    const next = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly' }),
        [...YEAR_2025, earning('2026-01-20', '50'), earning('2026-02-20', '70')],
        2026,
        AS_OF_MARCH_2026,
      ),
    );
    // 50,00 + 70,00 = 120,00
    expect(elapsed(next, '2026-02').cumulative.toString()).toBe('120');
    // 120,00 ÷ 2 = 60,00
    expect(elapsed(next, '2026-02').yearToDateAverage.toString()).toBe('60');
  });

  it('an elapsed month that paid nothing is a real zero, and drags the mean down', () => {
    const progress2 = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly' }),
        [earning('2025-01-15', '900'), earning('2025-03-15', '300')],
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(elapsed(progress2, '2025-02').amount.toString()).toBe('0');
    // 900 + 0 + 300 = 1.200,00 ÷ 3 = 400,00 — not 1.200 ÷ 2 = 600,00, which is
    // what a mean over "months that paid" would produce.
    expect(elapsed(progress2, '2025-03').yearToDateAverage.toString()).toBe('400');
  });
});

describe('BR-019-19 / DL-019-02 — exactly one calendar year', () => {
  it('reads no record from either side of the boundary', () => {
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly' }),
        [
          earning('2024-12-31', '9999'),
          ...YEAR_2025,
          earning('2026-01-01', '8888'),
          earning('2026-12-31', '7777'),
        ],
        2025,
        AS_OF_MARCH_2026,
      ),
    );

    // The total is unchanged by the neighbours: still 7.800,00.
    expect(progress.total.toString()).toBe('7800');
    expect(progress.months).toHaveLength(12);
    expect(progress.months.every((entry) => entry.month.startsWith('2025-'))).toBe(true);

    const figures = progress.months.flatMap((entry) =>
      entry.kind === 'elapsed'
        ? [entry.amount.toString(), entry.cumulative.toString(), entry.yearToDateAverage.toString()]
        : [],
    );
    expect(figures).not.toContain('9999');
    expect(figures).not.toContain('8888');
    expect(figures).not.toContain('7777');
    // December's cumulative is the year's own total and nothing more.
    expect(elapsed(progress, '2025-12').cumulative.toString()).toBe('7800');
  });

  it('runs January to December, in order', () => {
    const progress = unwrap(
      earningsProgress(goalOf({ period: 'yearly' }), YEAR_2025, 2025, AS_OF_MARCH_2026),
    );
    expect(progress.months.map((entry) => entry.month)).toEqual([
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
    ]);
  });
});

describe('BR-019-17 — a month that has not elapsed is not a zero bar', () => {
  const CURRENT_YEAR: readonly EarningRecord[] = [
    earning('2026-01-10', '100'),
    earning('2026-02-10', '200'),
    earning('2026-03-10', '300'),
  ];

  it('carries no amount at all for April through December', () => {
    const progress = unwrap(
      earningsProgress(goalOf({ period: 'yearly' }), CURRENT_YEAR, 2026, AS_OF_MARCH_2026),
    );

    expect(month(progress, '2026-03').kind).toBe('elapsed');
    for (const key of ['2026-04', '2026-07', '2026-12']) {
      expect(month(progress, key)).toEqual({ kind: 'not_elapsed', month: key });
    }
    // Nine invented zeros would have made this 350 ÷ ... — instead the
    // denominator is the three months that have actually begun:
    // 100 + 200 + 300 = 600,00 ÷ 3 = 200,00
    expect(elapsed(progress, '2026-03').yearToDateAverage.toString()).toBe('200');
  });

  it('BR-019-20 — shows the current month’s income beside the chart', () => {
    const progress = unwrap(
      earningsProgress(goalOf({ period: 'yearly' }), CURRENT_YEAR, 2026, AS_OF_MARCH_2026),
    );
    expect(progress.highlight).toEqual({
      kind: 'current_month',
      month: '2026-03',
      amount: Money.fromString('300'),
    });
  });

  it('BR-019-20 — a closed year shows that year’s total instead', () => {
    const progress = unwrap(
      earningsProgress(goalOf({ period: 'yearly' }), YEAR_2025, 2025, AS_OF_MARCH_2026),
    );
    expect(progress.highlight).toEqual({
      kind: 'year_total',
      year: 2025,
      amount: Money.fromString('7800'),
    });
    // Every month of a closed year has elapsed.
    expect(progress.months.every((entry) => entry.kind === 'elapsed')).toBe(true);
  });

  it('a year that has not begun carries no elapsed month at all', () => {
    // Not reachable through BR-019-22's selector, which offers no future year.
    // A record dated ahead of the clock is the only way in, and it must not
    // produce twelve bars of income nobody has received.
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly' }),
        [earning('2027-06-15', '500')],
        2027,
        AS_OF_MARCH_2026,
      ),
    );
    expect(progress.months.every((entry) => entry.kind === 'not_elapsed')).toBe(true);
    expect(progress.highlight).toEqual({
      kind: 'year_total',
      year: 2027,
      amount: Money.fromString('500'),
    });
  });
});

describe('BR-019-21 — a year with no income', () => {
  it('is an explicit empty state, and has no months to draw as zeros', () => {
    const progress = unwrap(
      earningsProgress(goalOf({ period: 'yearly' }), YEAR_2025, 2024, AS_OF_MARCH_2026),
    );

    expect(progress.empty).toBe(true);
    // Not twelve zero bars: none at all, so a renderer that ignored `empty`
    // still could not draw them.
    expect(progress.months).toEqual([]);
    expect(progress.total.toString()).toBe('0');
    expect(progress.achieved).toBe(false);
  });

  it('a year with a single payment is not empty', () => {
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly' }),
        [earning('2025-07-15', '42')],
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(progress.empty).toBe(false);
    expect(progress.months).toHaveLength(12);
    expect(progress.total.toString()).toBe('42');
  });
});

describe('BR-019-22 — the years the selector may offer', () => {
  it('lists only the years the wallet existed and had allocations', () => {
    // Allocated 06/2023, emptied 11/2023, allocated again 02/2025.
    //   2023 → held          2024 → entered empty, no events → not offered
    //   2025 → held          2026 → carried the 2025 holding in
    const events = [
      allocation('2023-06-01', HGLG11, '100'),
      allocation('2023-11-01', HGLG11, '0'),
      allocation('2025-02-01', PETR4, '50'),
    ];

    expect(goalYears(events, WALLET, AS_OF_MARCH_2026)).toEqual([2023, 2025, 2026]);
  });

  it('offers a year the wallet held assets that paid nothing — that is BR-019-21’s year', () => {
    const events = [allocation('2024-01-10', HGLG11, '100')];
    expect(goalYears(events, WALLET, AS_OF_MARCH_2026)).toEqual([2024, 2025, 2026]);
  });

  it('ignores another wallet’s allocations, and anything dated after the clock', () => {
    const events = [
      allocation('2023-06-01', HGLG11, '100', OTHER_WALLET),
      allocation('2025-02-01', PETR4, '50'),
      allocation('2027-01-01', PETR4, '80'),
    ];
    expect(goalYears(events, WALLET, AS_OF_MARCH_2026)).toEqual([2025, 2026]);
  });

  it('offers nothing for a wallet that never allocated', () => {
    expect(goalYears([], WALLET, AS_OF_MARCH_2026)).toEqual([]);
    expect(goalYears([allocation('2027-01-01', PETR4, '80')], WALLET, AS_OF_MARCH_2026)).toEqual(
      [],
    );
  });
});

describe('BR-019-23 — achieved within the period the goal names', () => {
  it('a monthly goal is achieved by one month reaching exactly the amount', () => {
    // May pays exactly 500,00 against a monthly goal of 500,00: *reaches or
    // exceeds*, so this is the boundary and it counts.
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'monthly', amount: Money.fromString('500') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(progress.achieved).toBe(true);

    // One centavo higher and May no longer reaches it — but June's 600,00 does.
    const higher = unwrap(
      earningsProgress(
        goalOf({ period: 'monthly', amount: Money.fromString('500.01') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(higher.achieved).toBe(true);

    // Above every single month: the best month is December's 1.200,00.
    const unreachable = unwrap(
      earningsProgress(
        goalOf({ period: 'monthly', amount: Money.fromString('1200.01') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(unreachable.achieved).toBe(false);
  });

  it('a monthly goal ignores months that have not elapsed', () => {
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'monthly', amount: Money.fromString('300') }),
        [earning('2026-03-10', '250')],
        2026,
        AS_OF_MARCH_2026,
      ),
    );
    expect(progress.achieved).toBe(false);
    expect(progress.months.filter((entry) => entry.kind === 'not_elapsed')).toHaveLength(9);
  });

  it('a yearly goal is achieved by the year’s total, at exactly the amount', () => {
    const exact = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly', amount: Money.fromString('7800') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(exact.achieved).toBe(true);

    const justAbove = unwrap(
      earningsProgress(
        goalOf({ period: 'yearly', amount: Money.fromString('7800.01') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    expect(justAbove.achieved).toBe(false);
    // No single month reaches 7.800,00 — a yearly goal is not a monthly one.
    expect(
      unwrap(
        earningsProgress(
          goalOf({ period: 'monthly', amount: Money.fromString('7800') }),
          YEAR_2025,
          2025,
          AS_OF_MARCH_2026,
        ),
      ).achieved,
    ).toBe(false);
  });
});

describe('the goal a progress function is handed', () => {
  it('refuses a growth goal, and an earnings row with no period', () => {
    const growth = earningsProgress(
      goalOf({ kind: 'growth', basis: 'invested', period: null }),
      YEAR_2025,
      2025,
      AS_OF_MARCH_2026,
    );
    expect(growth.ok).toBe(false);
    if (!growth.ok) expect(growth.error.code).toBe(GoalErrorCode.NOT_AN_EARNINGS_GOAL);

    const malformed = earningsProgress(goalOf({ period: null }), YEAR_2025, 2025, AS_OF_MARCH_2026);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe(GoalErrorCode.NOT_AN_EARNINGS_GOAL);
  });

  it('carries the period and amount through, so a renderer knows which line to draw', () => {
    const progress = unwrap(
      earningsProgress(
        goalOf({ period: 'monthly', amount: Money.fromString('1000') }),
        YEAR_2025,
        2025,
        AS_OF_MARCH_2026,
      ),
    );
    // BR-019-15: a horizontal line at 1.000,00 across the twelve months.
    expect(progress.period).toBe('monthly');
    expect(progress.goalAmount.toString()).toBe('1000');
    expect(progress.year).toBe(2025);
  });
});

/**
 * BR-019-23 with BR-019-25 — **a goal is reached on money that has arrived.**
 *
 * `total` counts every provento the ledger records inside the year, because
 * AC-13 makes it reconcile with the Earnings report over the same calendar
 * year, and a manually entered provento with a pay date later in the year is
 * inside it. Achievement cannot be measured that way: it writes a permanent
 * marker (BR-019-26) and sends an email (BR-019-25). Announcing either against
 * income nobody has received would be the product congratulating someone on
 * money they cannot spend, and the marker can never be taken back.
 */
describe('BR-019-23 — a yearly goal is measured on income already received', () => {
  // March 2026. Two payments recorded: R$ 400,00 that has arrived, and
  // R$ 700,00 dated December, which has not.
  const WITH_A_FUTURE_PAYMENT: readonly EarningRecord[] = [
    earning('2026-02-10', '400'),
    earning('2026-12-01', '700'),
  ];

  it('is not achieved by a provento dated later in the year', () => {
    const result = earningsProgress(
      goalOf({ period: 'yearly', amount: Money.fromString('1000') }),
      WITH_A_FUTURE_PAYMENT,
      2026,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 400 + 700 = 1.100,00 recorded in the year, so `total` clears the
    // R$ 1.000,00 goal…
    expect(result.value.total.toString()).toBe('1100');
    // …and the goal is still not achieved, because only R$ 400,00 has been
    // received: March's cumulative is 0 + 400 + 0 = 400,00.
    expect(result.value.achieved).toBe(false);
  });

  it('is achieved once the received cumulative reaches the amount', () => {
    const result = earningsProgress(
      goalOf({ period: 'yearly', amount: Money.fromString('400') }),
      WITH_A_FUTURE_PAYMENT,
      2026,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly the amount — BR-019-23's inclusive boundary, on received money.
    expect(result.value.achieved).toBe(true);
  });

  it('a month that has not elapsed cannot achieve a monthly goal either', () => {
    const result = earningsProgress(
      goalOf({ period: 'monthly', amount: Money.fromString('700') }),
      WITH_A_FUTURE_PAYMENT,
      2026,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // December's R$ 700,00 would meet the monthly goal exactly, and December
    // has not happened.
    expect(result.value.achieved).toBe(false);
  });

  it('a year with no elapsed month at all is not achieved', () => {
    // A future year: nothing has elapsed, so there is no cumulative to reach
    // the amount and the fallback must be zero rather than a crash.
    const result = earningsProgress(
      goalOf({ period: 'yearly', amount: Money.fromString('1') }),
      [earning('2027-06-01', '5000')],
      2027,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achieved).toBe(false);
  });
});

/**
 * BR-019-24 / AC-14 — the pay date that carried the goal over.
 *
 * Exact to the day here, unlike the growth burn-up's month-end sampling: the
 * records carry their own pay dates, so the payment responsible can be named.
 */
describe('BR-019-24 — the crossing pay date', () => {
  it('a monthly goal names the payment that carried that month over', () => {
    // March pays twice: R$ 150,00 on the 10th and R$ 150,00 on the 25th. A
    // monthly goal of R$ 300,00 is met by the second one, not the first.
    const result = earningsProgress(
      goalOf({ period: 'monthly', amount: Money.fromString('300') }),
      YEAR_2025,
      2025,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBe('2025-03-25');
  });

  it('a monthly goal does not carry a running total across the month boundary', () => {
    // January 100 + February 200 = 300 across two months, but no single month
    // reaches 300 until March's 150 + 150. A goal reached by accumulating
    // across months would have named February.
    const result = earningsProgress(
      goalOf({ period: 'monthly', amount: Money.fromString('300') }),
      YEAR_2025,
      2025,
      AS_OF_MARCH_2026,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).not.toBe('2025-02-16');
  });

  it('a yearly goal names the payment at which the running total crossed', () => {
    // 100 + 200 + 150 = 450; the second March payment takes it to 600.
    // A yearly goal of R$ 500,00 is crossed on 2025-03-25.
    const result = earningsProgress(
      goalOf({ period: 'yearly', amount: Money.fromString('500') }),
      YEAR_2025,
      2025,
      AS_OF_MARCH_2026,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBe('2025-03-25');
  });

  it('is null for a year the goal was not reached in', () => {
    const result = earningsProgress(
      goalOf({ period: 'yearly', amount: Money.fromString('99999') }),
      YEAR_2025,
      2025,
      AS_OF_MARCH_2026,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBeNull();
  });

  it('never names a pay date in a month that has not elapsed', () => {
    // December's R$ 700,00 would meet the goal, and December has not happened
    // — `achievedOn` and `achieved` must agree about which payments count.
    const result = earningsProgress(
      goalOf({ period: 'monthly', amount: Money.fromString('700') }),
      [earning('2026-02-10', '400'), earning('2026-12-01', '700')],
      2026,
      AS_OF_MARCH_2026,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBeNull();
    expect(result.value.achieved).toBe(false);
  });
});
