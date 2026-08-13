import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetUsers } from '../support/reset';

import * as schema from '@/db/schema';
import { auditLog } from '@/db/schema/config';
import { UserId } from '@/core/shared/ids';
import { setConfigValue } from '@/config/resolve';
import { setRuntimeState } from '@/config/runtime-state';

/**
 * BR-002-07: "Configuration changes affecting behaviour are written to
 * AuditLog with actor, previous value and new value."
 */
describe('SPEC-002 — audit trail (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: another suite file may have left rows behind when the database
    // is reused rather than created per file.
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);

    pool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    // See config-resolve.test.ts's afterAll for why this must close before `testDb.stop()`.
    await pool.end();
    await testDb.stop();
  });

  it('a deployment-level write is audited with actor, previous and new value', async () => {
    await setConfigValue(db, {
      key: 'quotes.budget_alert_pct',
      level: 'deployment',
      value: 70,
      actor: { kind: 'operator' },
    });

    const write = await setConfigValue(db, {
      key: 'quotes.budget_alert_pct',
      level: 'deployment',
      value: 85,
      actor: { kind: 'operator' },
    });
    expect(write.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityKey, 'quotes.budget_alert_pct'))
      .orderBy(desc(auditLog.createdAt));

    const latest = rows[0];
    expect(latest).toBeDefined();
    expect(latest?.actor).toBe('operator');
    expect(latest?.action).toBe('config.set');
    expect(latest?.previousValue).toBe(70);
    expect(latest?.newValue).toBe(85);
  });

  it('a runtime-state adjustment is audited with actor "system", distinct from an operator write', async () => {
    await setRuntimeState(
      db,
      'quotes.cadence_minutes',
      60,
      'cadence degraded: budget alert threshold crossed',
    );

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityKey, 'quotes.cadence_minutes'))
      .orderBy(desc(auditLog.createdAt));

    const latest = rows[0];
    expect(latest).toBeDefined();
    expect(latest?.actor).toBe('system');
    expect(latest?.action).toBe('runtime_state.set');
  });

  it('a rejected write (unauthorized level) never reaches the audit log', async () => {
    const before = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityKey, 'auth.session_idle_days'));

    const rejected = await setConfigValue(db, {
      key: 'auth.session_idle_days',
      level: 'deployment',
      value: 45,
      actor: { kind: 'user', userId: UserId.generate() },
    });
    expect(rejected.ok).toBe(false);

    const after = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityKey, 'auth.session_idle_days'));
    expect(after.length).toBe(before.length);
  });
});
