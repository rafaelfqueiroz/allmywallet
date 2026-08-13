import { describe, expect, it } from 'vitest';
import { REGISTRATIONS } from '@/worker/registrations';
import { QUEUE } from '@/worker/queues';

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
