import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetConsents, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';
import { grantConsent, listConsents, revokeConsent } from '@/core/privacy/consent';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleAuditLogPort } from '@/adapters/db/audit-log';
import {
  FakeAccountDeletionPort,
  FakeNotificationPort,
  FakePersonalDataExportPort,
} from '@/core/privacy/test-support/fake-repositories';

/**
 * SPEC-004 BR-004-06/07/08 — granular, per-purpose, versioned consent, proved
 * through the real Drizzle adapter and RLS rather than the fakes
 * `consent.test.ts` (unit) already exercises exhaustively.
 */
describe('SPEC-004 BR-004-06/07/08 — consent (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-05-01T00:00:00Z');

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await resetConsents(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
  });

  afterEach(async () => {
    await resetConsents(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  });

  async function withPrivacyDeps<T>(fn: (deps: PrivacyDependencies) => Promise<T>): Promise<T> {
    return withTenant(
      userId,
      async (tx) => {
        const deps: PrivacyDependencies = {
          consents: new DrizzleConsentRepository(tx, userId),
          auditLog: new DrizzleAuditLogPort(tx),
          exportData: new FakePersonalDataExportPort(),
          accountDeletion: new FakeAccountDeletionPort(),
          notifications: new FakeNotificationPort(),
          clock,
        };
        return fn(deps);
      },
      appDb,
    );
  }

  it('AC — granting a purpose persists it, readable via a fresh read (not just the same connection)', async () => {
    await withPrivacyDeps((deps) =>
      grantConsent(deps, userId, { purpose: 'email_reminders', policyVersion: '2026-05-01' }),
    );

    const { rows } = await migratorPool.query(
      `SELECT purpose, granted_at, revoked_at, policy_version FROM consents WHERE user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'email_reminders',
      revoked_at: null,
      policy_version: '2026-05-01',
    });
  });

  it('AC — the user can decline reminder emails while every core feature keeps working: revocation touches only the consents row', async () => {
    await withPrivacyDeps((deps) =>
      grantConsent(deps, userId, { purpose: 'email_reminders', policyVersion: 'v1' }),
    );

    const before = await migratorPool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [
      userId,
    ]);
    expect(Number(before.rows[0]?.n)).toBe(1);

    const result = await withPrivacyDeps((deps) => revokeConsent(deps, userId, 'email_reminders'));
    expect(result.ok).toBe(true);

    // The account itself, and every other tenant-scoped fact about it, is
    // completely unaffected — revocation is a single UPDATE to one row in
    // `consents`, nothing else.
    const after = await migratorPool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [
      userId,
    ]);
    expect(Number(after.rows[0]?.n)).toBe(1);

    const { rows } = await migratorPool.query(
      'SELECT revoked_at FROM consents WHERE user_id = $1 AND purpose = $2',
      [userId, 'email_reminders'],
    );
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it('AC — revoking is recorded with a timestamp and the policy version', async () => {
    await withPrivacyDeps((deps) =>
      grantConsent(deps, userId, { purpose: 'product_analytics', policyVersion: 'v3' }),
    );
    clock.set('2026-06-15T10:00:00Z');
    await withPrivacyDeps((deps) => revokeConsent(deps, userId, 'product_analytics'));

    const { rows } = await migratorPool.query<{ revoked_at: Date; policy_version: string }>(
      'SELECT revoked_at, policy_version FROM consents WHERE user_id = $1 AND purpose = $2',
      [userId, 'product_analytics'],
    );
    expect(new Date(rows[0]!.revoked_at).toISOString()).toBe('2026-06-15T10:00:00.000Z');
    expect(rows[0]?.policy_version).toBe('v3');
  });

  it('two purposes are independent end to end — granting one leaves the other undecided', async () => {
    await withPrivacyDeps((deps) =>
      grantConsent(deps, userId, { purpose: 'email_reminders', policyVersion: 'v1' }),
    );

    const states = await withPrivacyDeps((deps) => listConsents(deps, userId));
    const analytics = states.find((s) => s.purpose === 'product_analytics');
    expect(analytics?.granted).toBe(false);

    const { rows } = await migratorPool.query(
      "SELECT count(*)::int AS n FROM consents WHERE user_id = $1 AND purpose = 'product_analytics'",
      [userId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('a second tenant’s consent decisions never appear in this tenant’s read', async () => {
    const otherUser = UserId.generate();
    await seedUser(testDb.migrationUrl, otherUser);
    await withTenant(
      otherUser,
      async (tx) => {
        const deps: PrivacyDependencies = {
          consents: new DrizzleConsentRepository(tx, otherUser),
          auditLog: new DrizzleAuditLogPort(tx),
          exportData: new FakePersonalDataExportPort(),
          accountDeletion: new FakeAccountDeletionPort(),
          notifications: new FakeNotificationPort(),
          clock,
        };
        return grantConsent(deps, otherUser, { purpose: 'email_reminders', policyVersion: 'v1' });
      },
      appDb,
    );

    const states = await withPrivacyDeps((deps) => listConsents(deps, userId));
    expect(states.every((s) => s.granted === false)).toBe(true);

    await migratorPool.query('DELETE FROM users WHERE id = $1', [otherUser]);
  });
});
