import { describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';
import type { OnboardingDismissalPort } from '@/core/onboarding/ports';
import { dismissOnboarding, reopenOnboarding } from '@/core/onboarding/dismiss';

/**
 * SPEC-020 BR-020-11..13. TS-02: a hand-written fake, not a mocking library.
 */
class FakeDismissalPort implements OnboardingDismissalPort {
  private readonly store = new Map<UserId, Date | null>();

  async dismissedAt(userId: UserId): Promise<Date | null> {
    return this.store.get(userId) ?? null;
  }

  async setDismissedAt(userId: UserId, at: Date | null): Promise<void> {
    this.store.set(userId, at);
  }
}

const USER = UserId.generate();

describe('dismissOnboarding (BR-020-09/11)', () => {
  it('sets the dismissal to the clock’s current instant', async () => {
    const port = new FakeDismissalPort();
    const clock = new FakeClock('2026-03-01T12:00:00Z');

    await dismissOnboarding(port, USER, clock);

    expect(await port.dismissedAt(USER)).toEqual(new Date('2026-03-01T12:00:00Z'));
  });

  it('overwrites a previous dismissal with the new instant', async () => {
    const port = new FakeDismissalPort();
    await port.setDismissedAt(USER, new Date('2026-01-01T00:00:00Z'));
    const clock = new FakeClock('2026-03-01T12:00:00Z');

    await dismissOnboarding(port, USER, clock);

    expect(await port.dismissedAt(USER)).toEqual(new Date('2026-03-01T12:00:00Z'));
  });
});

describe('reopenOnboarding (BR-020-13)', () => {
  it('clears a dismissal back to null', async () => {
    const port = new FakeDismissalPort();
    await port.setDismissedAt(USER, new Date('2026-01-01T00:00:00Z'));

    await reopenOnboarding(port, USER);

    expect(await port.dismissedAt(USER)).toBeNull();
  });

  it('is a no-op on a user who was never dismissed', async () => {
    const port = new FakeDismissalPort();

    await reopenOnboarding(port, USER);

    expect(await port.dismissedAt(USER)).toBeNull();
  });
});
