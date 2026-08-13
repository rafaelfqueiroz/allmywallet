import { describe, expect, it } from 'vitest';
import { aggregateStatus, type ComponentHealth } from '@/lib/health';

/**
 * AR-50/AR-33: "reports database reachability, worker liveness and last
 * successful quote sync... degrades rather than 500s." The DB-touching
 * probes (`checkDatabase`, `checkWorkerLiveness`, `checkQuoteSync`) are
 * integration-tested against real Postgres (tests/integration/health.test.ts,
 * TESTING §1) — this covers the pure aggregation rule those probes feed.
 */
describe('aggregateStatus', () => {
  const ok: ComponentHealth = { status: 'ok' };
  const down: ComponentHealth = { status: 'down' };
  const degraded: ComponentHealth = { status: 'degraded' };
  const unknown: ComponentHealth = { status: 'unknown' };

  it('is ok when every component is ok', () => {
    expect(aggregateStatus([ok, ok, ok])).toBe('ok');
  });

  it('a single down component makes the whole report down, regardless of position', () => {
    expect(aggregateStatus([down, ok, ok])).toBe('down');
    expect(aggregateStatus([ok, down, ok])).toBe('down');
    expect(aggregateStatus([ok, ok, down])).toBe('down');
  });

  it('down outranks degraded', () => {
    expect(aggregateStatus([down, degraded])).toBe('down');
  });

  it('degraded (with no down) reports degraded', () => {
    expect(aggregateStatus([ok, degraded, ok])).toBe('degraded');
  });

  it('unknown never drags the status down — "not built yet" is not "broken"', () => {
    // This is the specific behaviour that lets quote sync (SPEC-008, #11 —
    // not built yet) report 'unknown' without turning the whole endpoint red
    // before that spec has shipped.
    expect(aggregateStatus([ok, unknown, ok])).toBe('ok');
    expect(aggregateStatus([unknown, unknown, unknown])).toBe('ok');
  });

  it('an empty component list reports ok — vacuously true, matches the "no down component" rule', () => {
    expect(aggregateStatus([])).toBe('ok');
  });
});
