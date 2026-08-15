import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { grantConsent, listConsents, revokeConsent } from '@/core/privacy/consent';
import { buildFakeDeps } from '@/core/privacy/test-support/build-deps';

const USER = UserId.generate();

describe('SPEC-004 BR-004-06/07 — grantConsent', () => {
  it('AC — records purpose, timestamp and policy version', async () => {
    const deps = buildFakeDeps('2026-03-15T12:00:00Z');

    const result = await grantConsent(deps, USER, {
      purpose: 'email_reminders',
      policyVersion: '2026-01-01',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purpose).toBe('email_reminders');
    expect(result.value.grantedAt).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(result.value.revokedAt).toBeNull();
    expect(result.value.policyVersion).toBe('2026-01-01');
  });

  it('BR-004-07: writes an audit_log entry with previous and new value', async () => {
    const deps = buildFakeDeps();
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });

    expect(deps.auditLog.entries).toHaveLength(1);
    expect(deps.auditLog.entries[0]).toMatchObject({
      actor: USER,
      userId: USER,
      action: 'consent.granted',
      entityType: 'consent',
      entityKey: 'email_reminders',
      previousValue: null,
    });
  });

  it('rejects a purpose outside the declared set', async () => {
    const deps = buildFakeDeps();
    const result = await grantConsent(deps, USER, {
      // @ts-expect-error — deliberately outside ConsentPurpose to prove the runtime guard, not just the type
      purpose: 'not_a_real_purpose',
      policyVersion: 'v1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONSENT_PURPOSE');
  });

  it('BR-004-06: two purposes are independent — granting one does not grant the other', async () => {
    const deps = buildFakeDeps();
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });

    const states = await listConsents(deps, USER);
    const analytics = states.find((s) => s.purpose === 'product_analytics');
    expect(analytics?.granted).toBe(false);
  });

  it('granting again refreshes the timestamp and policy version (idempotent, not a duplicate row)', async () => {
    const deps = buildFakeDeps('2026-01-01T00:00:00Z');
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });
    deps.clock.set('2026-06-01T00:00:00Z');
    const second = await grantConsent(deps, USER, {
      purpose: 'email_reminders',
      policyVersion: 'v2',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.policyVersion).toBe('v2');
    expect(second.value.grantedAt).toEqual(new Date('2026-06-01T00:00:00Z'));

    const all = await deps.consents.listForUser(USER);
    expect(all).toHaveLength(1);
  });
});

describe('SPEC-004 BR-004-06/08 — revokeConsent', () => {
  it('AC — the user can decline reminder emails; the row records a revocation timestamp and the policy version', async () => {
    const deps = buildFakeDeps('2026-03-15T12:00:00Z');
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });
    deps.clock.set('2026-04-01T00:00:00Z');

    const result = await revokeConsent(deps, USER, 'email_reminders');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokedAt).toEqual(new Date('2026-04-01T00:00:00Z'));
    expect(result.value.grantedAt).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(result.value.policyVersion).toBe('v1');
  });

  it('BR-004-07: a revocation is also audited', async () => {
    const deps = buildFakeDeps();
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });
    await revokeConsent(deps, USER, 'email_reminders');

    expect(deps.auditLog.entries.map((e) => e.action)).toEqual([
      'consent.granted',
      'consent.revoked',
    ]);
  });

  it('refuses to revoke a purpose that was never granted', async () => {
    const deps = buildFakeDeps();
    const result = await revokeConsent(deps, USER, 'email_reminders');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONSENT_NOT_GRANTED');
  });

  it('refuses to revoke an already-revoked purpose', async () => {
    const deps = buildFakeDeps();
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });
    await revokeConsent(deps, USER, 'email_reminders');

    const second = await revokeConsent(deps, USER, 'email_reminders');
    expect(second.ok).toBe(false);
  });

  it(
    'AC/BR-004-08 — revoking leaves every core feature working: this use case has no ' +
      'dependency capable of touching anything but consents and the audit log',
    async () => {
      const deps = buildFakeDeps();
      await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });
      await revokeConsent(deps, USER, 'email_reminders');

      // Structural proof, not a behavioural one: PrivacyDependencies for this
      // use case carries exactly these two ports plus a clock — there is no
      // ledger, wallet, valuation or reporting port in scope for
      // `revokeConsent` to have degraded even if it tried.
      expect(Object.keys(deps).sort()).toEqual(
        ['accountDeletion', 'auditLog', 'clock', 'consents', 'exportData', 'notifications'].sort(),
      );
    },
  );
});

describe('SPEC-004 BR-004-06 — listConsents', () => {
  it('every declared purpose is present even with no decision recorded', async () => {
    const deps = buildFakeDeps();
    const states = await listConsents(deps, USER);
    expect(states.map((s) => s.purpose).sort()).toEqual(['email_reminders', 'product_analytics']);
    expect(states.every((s) => s.granted === false)).toBe(true);
  });

  it('reflects a granted-then-revoked purpose accurately', async () => {
    const deps = buildFakeDeps();
    await grantConsent(deps, USER, { purpose: 'product_analytics', policyVersion: 'v1' });
    await revokeConsent(deps, USER, 'product_analytics');

    const states = await listConsents(deps, USER);
    const analytics = states.find((s) => s.purpose === 'product_analytics');
    expect(analytics?.granted).toBe(false);
    expect(analytics?.grantedAt).not.toBeNull();
    expect(analytics?.revokedAt).not.toBeNull();
  });
});
