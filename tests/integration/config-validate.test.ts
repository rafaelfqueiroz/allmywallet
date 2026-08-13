import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetUsers } from '../support/reset';

import * as schema from '@/db/schema';
import { configOverrides } from '@/db/schema/config';
import { collectConfigFailures } from '@/config/validate';
import { invalidateDeploymentCache } from '@/config/resolve';
import { uuidv7 } from 'uuidv7';

/**
 * BR-002-04 / DL-002-01: an invalid deployment-level value fails the boot
 * loudly, naming the key, the offending value and the permitted range — and
 * is never silently interpreted as the default.
 */
describe('SPEC-002 — startup validation (integration)', () => {
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
    // See the top-level note in config-resolve.test.ts's afterAll for why
    // this must close before `testDb.stop()`.
    await pool.end();
    await testDb.stop();
  });

  beforeEach(() => {
    invalidateDeploymentCache();
  });

  it('passes with only the registry defaults in play', async () => {
    const failures = await collectConfigFailures(db);
    expect(failures).toEqual([]);
  });

  it('fails with a message naming the key, offending value and range for an out-of-range value', async () => {
    // Written directly, bypassing setConfigValue's own validation — this is
    // exactly the "someone edited the row by hand" scenario validate.ts
    // exists to catch after a redeploy.
    await db.insert(configOverrides).values({
      id: uuidv7(),
      key: 'quotes.budget_alert_pct',
      level: 'deployment',
      userId: null,
      value: 250, // out of the 1–100 range
    });

    const failures = await collectConfigFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.key).toBe('quotes.budget_alert_pct');
    expect(failures[0]?.error.message).toContain('quotes.budget_alert_pct');
    expect(failures[0]?.error.message).toContain('250');
    expect(failures[0]?.error.message).toContain('1–100');

    // Clean up so later tests in this file see only their own bad rows.
    await db.delete(configOverrides).where(eq(configOverrides.key, 'quotes.budget_alert_pct'));
  });

  it('fails on quotes.cadence_minutes = 0 specifically — never interpreted as "poll continuously"', async () => {
    await db.insert(configOverrides).values({
      id: uuidv7(),
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      userId: null,
      value: 0,
    });

    const failures = await collectConfigFailures(db);
    const cadenceFailure = failures.find((f) => f.key === 'quotes.cadence_minutes');
    expect(cadenceFailure).toBeDefined();
    expect(cadenceFailure?.error.offendingValue).toBe(0);
  });

  it('the real entrypoint exits non-zero and does not start, in a real subprocess', () => {
    // Node resolves a bare specifier like 'drizzle-orm' by walking up from
    // the *importing file's* own directory, not from `cwd` — so the script
    // has to live inside the project tree for the project's node_modules to
    // resolve at all, not under the OS temp directory.
    const scriptDir = mkdtempSync(join(process.cwd(), 'tests', 'integration', '.boot-test-'));
    const scriptPath = join(scriptDir, 'boot.mjs');
    writeFileSync(
      scriptPath,
      `
      import { drizzle } from 'drizzle-orm/node-postgres';
      import { Pool } from 'pg';
      import { validateConfigOrExit } from '${new URL('../../src/config/validate.ts', import.meta.url).pathname}';
      import * as schema from '${new URL('../../src/db/schema/index.ts', import.meta.url).pathname}';

      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const db = drizzle(pool, { schema });
      await validateConfigOrExit(db);
      console.log('BOOTED');
      process.exit(0);
      `,
    );

    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

    let threw = false;
    let output = '';
    try {
      try {
        output = execFileSync(tsxBin, [scriptPath], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: testDb.appUrl },
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        threw = true;
        const execError = error as { status?: number; stderr?: string };
        expect(execError.status).toBe(1);
        expect(execError.stderr ?? '').toContain('quotes.cadence_minutes');
      }
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }

    expect(threw, 'the boot subprocess must exit non-zero, not print BOOTED').toBe(true);
    expect(output).not.toContain('BOOTED');
  }, 60_000);
});
