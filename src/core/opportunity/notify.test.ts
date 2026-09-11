import { describe, expect, it } from 'vitest';
import { decideNotification, isWithinQuietHours } from '@/core/opportunity/notify';

/**
 * SPEC-018 BR-018-21..27 — every reason an email is or is not sent.
 *
 * TS-04/TS-05: expected outcomes are hand-reasoned against the cited rule,
 * never against what `decideNotification` returns.
 */

const NOW = new Date('2026-03-16T13:00:00Z');

function input(overrides: Partial<Parameters<typeof decideNotification>[0]> = {}) {
  return {
    active: true,
    muted: false,
    consented: true,
    lastState: 'hold' as const,
    evaluatedState: 'buy' as const,
    lastSentAt: null,
    now: NOW,
    cooldownHours: 24,
    quietHours: null,
    ...overrides,
  };
}

describe('BR-018-21 — a real state change, fully clear, sends', () => {
  it('sends when every gate is clear', () => {
    expect(decideNotification(input())).toEqual({ send: true, reason: 'state_changed' });
  });
});

describe('BR-018-21 — repeat evaluations send nothing', () => {
  it('is unchanged when the evaluated state equals the last observed state', () => {
    const result = decideNotification(input({ lastState: 'buy', evaluatedState: 'buy' }));
    expect(result).toEqual({ send: false, reason: 'unchanged' });
  });
});

describe('the first observation of a rule (no BR-018 wording covers this directly — see notify.ts)', () => {
  it('does not send when there has never been a prior observation, even though the state is real', () => {
    const result = decideNotification(input({ lastState: null, evaluatedState: 'sell' }));
    expect(result).toEqual({ send: false, reason: 'first_observation' });
  });

  it('does send on the evaluation *after* the baseline, once a real prior state exists', () => {
    const result = decideNotification(input({ lastState: 'sell', evaluatedState: 'buy' }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });
});

describe('BR-018-16 — an unknown reading never sends, and takes priority over first-observation', () => {
  it('does not send when the evaluated state is unknown', () => {
    const result = decideNotification(input({ lastState: 'buy', evaluatedState: 'unknown' }));
    expect(result).toEqual({ send: false, reason: 'unknown_state' });
  });

  it('is unknown_state rather than first_observation when both apply', () => {
    const result = decideNotification(input({ lastState: null, evaluatedState: 'unknown' }));
    expect(result).toEqual({ send: false, reason: 'unknown_state' });
  });
});

describe('defensive: an inactive rule never sends', () => {
  it('refuses regardless of everything else, even a real change', () => {
    const result = decideNotification(
      input({ active: false, lastState: 'hold', evaluatedState: 'buy' }),
    );
    expect(result).toEqual({ send: false, reason: 'inactive' });
  });
});

describe('BR-018-26 — per-asset mute suppresses only the email', () => {
  it('suppresses a genuine change when the rule is muted', () => {
    const result = decideNotification(input({ muted: true }));
    expect(result).toEqual({ send: false, reason: 'muted' });
  });
});

describe('BR-018-25 — opt-in gates the send, not the state', () => {
  it('suppresses when the user has not consented', () => {
    const result = decideNotification(input({ consented: false }));
    expect(result).toEqual({ send: false, reason: 'not_consented' });
  });
});

describe('BR-018-22/23 — cooldown, including a genuine second crossing', () => {
  it('suppresses a change sent less than the cooldown window ago', () => {
    const lastSentAt = new Date('2026-03-16T00:00:00Z'); // 13h before NOW, cooldown 24h
    const result = decideNotification(input({ lastSentAt, cooldownHours: 24 }));
    expect(result).toEqual({ send: false, reason: 'cooldown' });
  });

  it('sends again once the cooldown window has fully elapsed', () => {
    const lastSentAt = new Date('2026-03-15T12:59:59Z'); // just over 24h before NOW
    const result = decideNotification(input({ lastSentAt, cooldownHours: 24 }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });

  it('is exactly at the cooldown boundary — the window has fully elapsed, so it sends', () => {
    const lastSentAt = new Date('2026-03-15T13:00:00Z'); // exactly 24h before NOW
    const result = decideNotification(input({ lastSentAt, cooldownHours: 24 }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });

  it('is one second inside the boundary — still suppressed', () => {
    const lastSentAt = new Date('2026-03-15T13:00:01Z'); // 23h59m59s before NOW
    const result = decideNotification(input({ lastSentAt, cooldownHours: 24 }));
    expect(result).toEqual({ send: false, reason: 'cooldown' });
  });

  it('never suppresses on cooldown when nothing has ever been sent', () => {
    const result = decideNotification(input({ lastSentAt: null }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });
});

describe('BR-018-27 — quiet hours', () => {
  it('suppresses inside a same-day window', () => {
    // NOW is 2026-03-16T13:00:00Z = 10:00 in São Paulo (UTC-3).
    const result = decideNotification(input({ quietHours: { start: '09:00', end: '11:00' } }));
    expect(result).toEqual({ send: false, reason: 'quiet_hours' });
  });

  it('does not suppress outside the window', () => {
    const result = decideNotification(input({ quietHours: { start: '22:00', end: '23:00' } }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });

  it('sends when there is no quiet window at all (null)', () => {
    const result = decideNotification(input({ quietHours: null }));
    expect(result).toEqual({ send: true, reason: 'state_changed' });
  });
});

describe('isWithinQuietHours — the wall-clock comparison in isolation', () => {
  it('is false when the window is null', () => {
    expect(isWithinQuietHours(NOW, null)).toBe(false);
  });

  it('is true at the start of a same-day window (inclusive)', () => {
    // 10:00 São Paulo.
    expect(isWithinQuietHours(NOW, { start: '10:00', end: '11:00' })).toBe(true);
  });

  it('is false at the end of a same-day window (exclusive)', () => {
    expect(isWithinQuietHours(NOW, { start: '09:00', end: '10:00' })).toBe(false);
  });

  it('is false strictly outside a same-day window', () => {
    expect(isWithinQuietHours(NOW, { start: '14:00', end: '15:00' })).toBe(false);
  });

  it('wraps midnight when start > end, and matches the late side', () => {
    // 10:00 São Paulo falls inside a 22:00–11:00 overnight window.
    expect(isWithinQuietHours(NOW, { start: '22:00', end: '11:00' })).toBe(true);
  });

  it('wraps midnight and matches the early side too', () => {
    const lateEvening = new Date('2026-03-16T01:30:00Z'); // 22:30 São Paulo the prior day
    expect(isWithinQuietHours(lateEvening, { start: '22:00', end: '07:00' })).toBe(true);
  });

  it('wraps midnight and excludes a time strictly between end and start', () => {
    // 10:00 São Paulo, window 22:00–07:00 wraps but 10:00 is in neither half.
    expect(isWithinQuietHours(NOW, { start: '22:00', end: '07:00' })).toBe(false);
  });
});
