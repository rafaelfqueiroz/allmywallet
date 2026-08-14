import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import {
  getAccountDeletionStatus,
  purgeDueAccounts,
  requestAccountDeletion,
} from '@/core/privacy/delete-account';
import { buildFakeDeps } from '@/core/privacy/test-support/build-deps';

const USER = UserId.generate();
const OTHER_USER = UserId.generate();

describe('SPEC-004 BR-004-09 — requestAccountDeletion', () => {
  it('AC — access is revoked immediately and the request is recorded with a purge date 30 days out (the default window)', async () => {
    const deps = buildFakeDeps('2026-03-15T12:00:00Z');

    const result = await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedAt).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(result.value.purgeAt).toEqual(new Date('2026-04-14T12:00:00Z'));
    expect(deps.accountDeletion.sessionsRevokedFor(USER)).toBe(true);
  });

  it('respects a configured window other than the default', async () => {
    const deps = buildFakeDeps('2026-01-01T00:00:00Z');
    const result = await requestAccountDeletion(deps, USER, { deletionWindowDays: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purgeAt).toEqual(new Date('2026-01-08T00:00:00Z'));
  });

  it('BR-004-09: sends a confirmation notification', async () => {
    const deps = buildFakeDeps();
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });
    expect(deps.notifications.deletionRequestedSentTo).toEqual([USER]);
  });

  it('BR-004-17-adjacent: records the request in audit_log', async () => {
    const deps = buildFakeDeps();
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });
    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]).toMatchObject({
      actor: USER,
      userId: USER,
      action: 'account.deletion.requested',
    });
  });

  it('refuses a second request while one is already pending', async () => {
    const deps = buildFakeDeps();
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });
    const second = await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('DELETION_ALREADY_REQUESTED');
    // Only one session-revocation and one notification — the second request never re-ran the side effects.
    expect(deps.notifications.deletionRequestedSentTo).toHaveLength(1);
  });

  it('two accounts are independent — requesting deletion for one never touches the other', async () => {
    const deps = buildFakeDeps();
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 30 });
    expect(deps.accountDeletion.sessionsRevokedFor(OTHER_USER)).toBe(false);
    const otherStatus = await getAccountDeletionStatus(deps, OTHER_USER);
    expect(otherStatus).toBeNull();
  });
});

describe('SPEC-004 BR-004-09/10 — purgeDueAccounts', () => {
  it('AC — an account past its window is purged, notified and audited', async () => {
    const deps = buildFakeDeps('2026-04-20T00:00:00Z');
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 7 }); // purgeAt = 2026-04-27

    // Not yet due: 2026-04-25 minus a 7-day window is 2026-04-18, before the
    // 2026-04-20 request.
    const tooEarly = await purgeDueAccounts(deps, new Date('2026-04-25T00:00:00Z'), 7);
    expect(tooEarly.purged).toHaveLength(0);
    expect(deps.accountDeletion.purgedUserIds).toHaveLength(0);

    // Due: 2026-04-28 minus 7 days is 2026-04-21, at or after the request.
    const due = await purgeDueAccounts(deps, new Date('2026-04-28T00:00:00Z'), 7);
    expect(due.purged).toEqual([USER]);
    expect(deps.accountDeletion.purgedUserIds).toEqual([USER]);
    expect(deps.notifications.deletionCompletedSentTo).toEqual([USER]);
    expect(deps.auditLog.entries.map((e) => e.action)).toContain('account.deletion.purged');
  });

  it('purges every due account, not merely the first', async () => {
    const deps = buildFakeDeps('2026-01-01T00:00:00Z');
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 1 });
    await requestAccountDeletion(deps, OTHER_USER, { deletionWindowDays: 1 });

    const result = await purgeDueAccounts(deps, new Date('2026-01-05T00:00:00Z'), 1);
    expect([...result.purged].sort()).toEqual([USER, OTHER_USER].sort());
  });

  it('one account failing to purge does not stop the rest', async () => {
    const deps = buildFakeDeps('2026-01-01T00:00:00Z');
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 1 });
    await requestAccountDeletion(deps, OTHER_USER, { deletionWindowDays: 1 });

    const originalPurge = deps.accountDeletion.purgeUser.bind(deps.accountDeletion);
    deps.accountDeletion.purgeUser = async (userId) => {
      if (userId === USER) throw new Error('simulated purge failure');
      return originalPurge(userId);
    };

    const result = await purgeDueAccounts(deps, new Date('2026-01-05T00:00:00Z'), 1);
    expect(result.purged).toEqual([OTHER_USER]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.userId).toBe(USER);
  });

  it('notifies the account before purging it — the email address lives only in the row about to be deleted', async () => {
    const deps = buildFakeDeps('2026-01-01T00:00:00Z');
    await requestAccountDeletion(deps, USER, { deletionWindowDays: 1 });

    const order: string[] = [];
    const originalNotify = deps.notifications.sendAccountDeletionCompleted.bind(deps.notifications);
    deps.notifications.sendAccountDeletionCompleted = async (userId) => {
      order.push('notified');
      return originalNotify(userId);
    };
    const originalPurge = deps.accountDeletion.purgeUser.bind(deps.accountDeletion);
    deps.accountDeletion.purgeUser = async (userId) => {
      order.push('purged');
      return originalPurge(userId);
    };

    await purgeDueAccounts(deps, new Date('2026-01-05T00:00:00Z'), 1);
    expect(order).toEqual(['notified', 'purged']);
  });

  it('nothing is purged when nothing is due', async () => {
    const deps = buildFakeDeps();
    const result = await purgeDueAccounts(deps, new Date(), 30);
    expect(result.purged).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
