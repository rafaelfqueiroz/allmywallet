import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the rebuild is replaced — `parseSnapshotJobPayload` stays real, so the
// test below proves the registration validates what pg-boss hands it.
vi.mock('@/worker/handlers/valuation', async (importOriginal) => ({
  ...(await importOriginal<typeof ValuationModule>()),
  handleValuationSnapshot: vi.fn(),
}));

import { REGISTRATIONS } from '@/worker/registrations';
import { QUEUE } from '@/worker/queues';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';
import type * as ValuationModule from '@/worker/handlers/valuation';

/**
 * AR-16/17/18 — this test asserts the *registration shape* (which SPEC-008
 * queues carry a cron, that the cron strings are well-formed 5-field
 * expressions) since actually exercising `boss.schedule`'s `tz` argument or
 * an early trading-calendar exit needs a live pg-boss connection — those are
 * proven by the handler-level unit tests (`FakeClock`/`FakeTradingCalendar`
 * asserting zero provider calls outside a session, `src/core/quotes/*.test.ts`)
 * and by starting the worker for real in integration.
 */
describe('worker registrations (SPEC-008)', () => {
  const SPEC_008_QUEUES = [
    QUEUE.QUOTES_POLL,
    QUEUE.QUOTES_CLOSE_CAPTURE,
    QUEUE.TESOURO_SYNC,
    QUEUE.BCB_SYNC,
    QUEUE.BUDGET_CHECK,
  ];

  it('registers every SPEC-008 queue named in src/worker/queues.ts', () => {
    const registered = REGISTRATIONS.map((r) => r.queue);
    for (const queue of SPEC_008_QUEUES) {
      expect(registered).toContain(queue);
    }
  });

  it('AR-16: every SPEC-008 queue carries a cron — scheduling is the worker’s job alone', () => {
    for (const queue of SPEC_008_QUEUES) {
      const registration = REGISTRATIONS.find((r) => r.queue === queue);
      expect(registration?.cron, `${queue} has no cron`).toBeTruthy();
      // AR-17: `startWorker` registers every cron with `tz: 'America/Sao_Paulo'`
      // (a single shared argument to `boss.schedule`, not per-queue) — a
      // 5-field cron expression here is the shape that call requires.
      expect(registration?.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    }
  });

  it('AR-18: quotes.poll fires far more often than the effective cadence — the handler, not the cron, gates on the trading calendar', () => {
    const poll = REGISTRATIONS.find((r) => r.queue === QUEUE.QUOTES_POLL);
    // Every 5 minutes — deliberately more frequent than any degradation-ladder
    // rung (30/60/120 min default), because AR-18 puts the actual session/
    // cadence decision in the handler, not in an unexpressable cron holiday rule.
    expect(poll?.cron).toBe('*/5 * * * *');
  });
});

/**
 * SPEC-009 BR-009-18 — `startWorker` hands each registration `job.data`
 * unchanged. The scoped rebuild an import or fixed-income edit enqueues must
 * reach `handleValuationSnapshot`; the daily cron's `null` must not narrow it.
 */
describe('worker registrations (SPEC-009 valuation.snapshot)', () => {
  const USER = '01920000-0000-7000-8000-000000000009';
  // `startWorker` casts to `JobHandler<object>` and passes `job.data`, which
  // pg-boss delivers as `null` for a cron job — hence `unknown` here.
  const handler = REGISTRATIONS.find((r) => r.queue === QUEUE.VALUATION_SNAPSHOT)?.handler as (
    data: unknown,
  ) => Promise<void>;

  beforeEach(() => {
    vi.mocked(handleValuationSnapshot).mockReset();
    vi.mocked(handleValuationSnapshot).mockResolvedValue({ tenants: 1, snapshots: 3, failures: 0 });
  });

  it('BR-009-18: a { userId, from } job rebuilds that tenant from that date', async () => {
    await handler({ userId: USER, from: '2026-03-18' });
    expect(handleValuationSnapshot).toHaveBeenCalledExactlyOnceWith({
      userId: USER,
      from: '2026-03-18',
    });
  });

  it('a { from } job rebuilds every tenant from that date', async () => {
    await handler({ from: '2026-03-18' });
    expect(handleValuationSnapshot).toHaveBeenCalledExactlyOnceWith({ from: '2026-03-18' });
  });

  it('the daily cron’s null data rebuilds every tenant’s whole history', async () => {
    await handler(null);
    expect(handleValuationSnapshot).toHaveBeenCalledExactlyOnceWith({});
  });

  it('AR-21: a malformed payload fails the job instead of widening to a full rebuild', async () => {
    await expect(handler({ userId: USER, from: '18/03/2026' })).rejects.toThrow(TypeError);
    expect(handleValuationSnapshot).not.toHaveBeenCalled();
  });

  it('discards the run summary — pg-boss gets nothing back', async () => {
    await expect(handler({})).resolves.toBeUndefined();
  });
});
