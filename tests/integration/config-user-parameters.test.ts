import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

import * as schema from '@/db/schema';
import { auditLog, configOverrides } from '@/db/schema/config';
import { UserId } from '@/core/shared/ids';
import { withTenantRollbackOn } from '@/db/tenant';
import { saveUserParameters } from '@/config/user-parameters';

/**
 * SPEC-022 BR-022-37 / SPEC-002 BR-002-03/07 — a screen's parameters are saved
 * together, all or nothing, against the real RLS-guarded tables: a refusal in
 * the middle of the writes undoes the ones already made, and an unchanged key
 * is neither written nor audited.
 */
describe('saveUserParameters (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  // The owner's connection reads past RLS, so an assertion sees every row.
  let ownerPool: Pool;
  let owner: ReturnType<typeof drizzle<typeof schema>>;
  const userId = UserId.of(randomUUID());

  const overrides = () =>
    owner
      .select({ key: configOverrides.key, value: configOverrides.value })
      .from(configOverrides)
      .where(and(eq(configOverrides.level, 'user'), eq(configOverrides.userId, userId)));

  const save = (entries: Parameters<typeof saveUserParameters>[1]['entries']) =>
    withTenantRollbackOn(
      userId,
      (tx) => saveUserParameters(tx, { userId, entries }),
      (outcome) => outcome.status === 'refused',
      db,
    );

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: another suite file may have left rows behind on a reused database.
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);

    pool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    db = drizzle(pool, { schema });
    ownerPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    owner = drizzle(ownerPool, { schema });
  }, 180_000);

  beforeEach(async () => {
    await resetConfigState(testDb.migrationUrl);
  });

  afterAll(async () => {
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await pool.end();
    await ownerPool.end();
    await testDb.stop();
  });

  it('writes the changed keys, and neither writes nor audits an unchanged one', async () => {
    const outcome = await save([
      { key: 'reports.concentration_threshold_pct', value: 42, loaded: { value: 20 } },
      // The registry default, unchanged: stays a default.
      { key: 'ui.theme', value: 'system', loaded: { value: 'system' } },
    ]);

    expect(outcome).toEqual({ status: 'saved', written: ['reports.concentration_threshold_pct'] });
    expect(await overrides()).toEqual([{ key: 'reports.concentration_threshold_pct', value: 42 }]);
    const audited = await owner
      .select({ key: auditLog.entityKey })
      .from(auditLog)
      .where(eq(auditLog.entityKey, 'ui.theme'));
    expect(audited).toHaveLength(0);
  });

  it('rolls back the keys already written when a later one is refused', async () => {
    const outcome = await save([
      { key: 'reports.concentration_threshold_pct', value: 42 },
      // Schema-valid, but deployment-only: `setConfigValue` refuses it at
      // user level (BR-002-03) after the first key was written.
      { key: 'quotes.budget_alert_pct', value: 85 },
    ]);

    expect(outcome).toEqual({ status: 'refused', invalid: ['quotes.budget_alert_pct'] });
    expect(await overrides()).toEqual([]);
    expect(await owner.select().from(auditLog)).toEqual([]);
  });

  it('writes nothing when any value is outside its schema, naming each', async () => {
    const outcome = await save([
      { key: 'ui.theme', value: 'dark' },
      { key: 'reports.concentration_threshold_pct', value: 420 },
    ]);

    expect(outcome).toEqual({
      status: 'refused',
      invalid: ['reports.concentration_threshold_pct'],
    });
    expect(await overrides()).toEqual([]);
  });

  it('leaves a key changed elsewhere since the form loaded', async () => {
    // The eye toggle hid values after the form had loaded them as visible.
    await save([{ key: 'ui.hide_values', value: true }]);

    await save([
      { key: 'ui.hide_values', value: false, loaded: { value: false } },
      { key: 'ui.theme', value: 'dark', loaded: { value: 'system' } },
    ]);

    expect(await overrides()).toEqual(
      expect.arrayContaining([
        { key: 'ui.hide_values', value: true },
        { key: 'ui.theme', value: 'dark' },
      ]),
    );
  });
});
