import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PersonalDatabaseRefusedError, readInstanceMarker } from '@/db/personal-guard';
import { resetConfigState, resetLedger, resetUsers } from '../support/reset';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-021 BR-021-07/BR-021-08, AC 1–3 — the refusal guard, proven against a
 * real marked database.
 *
 * This file exists so the guard cannot be deleted without CI noticing
 * (#104's "the guard's absence must fail loudly"). Each test marks a
 * **disposable** database of its own — created beside the suite's database,
 * never the suite's database itself, which every other file still needs — and
 * asserts that every dangerous entrypoint refuses it with zero rows touched.
 */
const MARKED_DB = 'allmywallet_guard_marked';

function urlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

describe('personal database refusal guard (SPEC-021 BR-021-08)', () => {
  let testDb: TestDatabase;
  let admin: Pool;
  let markedMigrationUrl: string;
  let markedAppUrl: string;

  async function rowCounts(): Promise<Record<string, number>> {
    const pool = new Pool({ connectionString: markedMigrationUrl, max: 1 });
    try {
      const { rows } = await pool.query<{ users: number; runtime_state: number; assets: number }>(
        `SELECT (SELECT count(*)::int FROM users) AS users,
                (SELECT count(*)::int FROM runtime_state) AS runtime_state,
                (SELECT count(*)::int FROM assets) AS assets`,
      );
      return rows[0] ?? {};
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    admin = new Pool({ connectionString: testDb.migrationUrl, max: 1 });

    // TS-03: a previous run killed mid-file may have left the database behind.
    await admin.query(`DROP DATABASE IF EXISTS ${MARKED_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${MARKED_DB}`);

    markedMigrationUrl = urlFor(testDb.migrationUrl, MARKED_DB);
    markedAppUrl = urlFor(testDb.appUrl, MARKED_DB);
    await applyMigrations(markedMigrationUrl);

    const seed = new Pool({ connectionString: markedMigrationUrl, max: 1 });
    try {
      await seed.query(
        `INSERT INTO users (id, google_subject_id, email, name)
         VALUES ('0190a000-0000-7000-8000-000000000021', 'guard-subject', 'guard@example.invalid', 'Guard')`,
      );
      await seed.query(
        `INSERT INTO assets (id, code, name, class)
         VALUES ('0190a000-0000-7000-8000-000000000022', 'GARD3', 'Guard asset', 'stock')`,
      );
      await seed.query(
        `INSERT INTO runtime_state (key, value, reason) VALUES ('quotes.cadence_minutes', '30', 'guard fixture')`,
      );
    } finally {
      await seed.end();
    }

    // The marker, exactly as scripts/personal/init.sh writes it.
    await admin.query(`ALTER DATABASE ${MARKED_DB} SET allmywallet.instance_role = 'personal'`);
  }, 180_000);

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${MARKED_DB} WITH (FORCE)`);
    await admin.end();
    await testDb.stop();
  });

  it('reads the marker from a fresh connection', async () => {
    expect(await readInstanceMarker(markedMigrationUrl)).toEqual({
      database: MARKED_DB,
      role: 'personal',
    });
    expect((await readInstanceMarker(testDb.migrationUrl)).role).toBeNull();
  });

  it('startTestDatabase refuses a marked DATABASE_MIGRATION_URL before any statement', async () => {
    const before = await rowCounts();
    const saved = {
      migration: process.env.DATABASE_MIGRATION_URL,
      app: process.env.DATABASE_URL,
    };
    process.env.DATABASE_MIGRATION_URL = markedMigrationUrl;
    process.env.DATABASE_URL = markedAppUrl;
    try {
      await expect(startTestDatabase()).rejects.toThrow(PersonalDatabaseRefusedError);
      await expect(startTestDatabase()).rejects.toThrow(`"${MARKED_DB}"`);
    } finally {
      restoreEnv('DATABASE_MIGRATION_URL', saved.migration);
      restoreEnv('DATABASE_URL', saved.app);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('every reset helper refuses, touching zero rows', async () => {
    const before = await rowCounts();
    expect(before).toEqual({ users: 1, runtime_state: 1, assets: 1 });

    await expect(resetConfigState(markedMigrationUrl)).rejects.toThrow(
      PersonalDatabaseRefusedError,
    );
    await expect(resetUsers(markedMigrationUrl)).rejects.toThrow(PersonalDatabaseRefusedError);
    await expect(resetLedger(markedMigrationUrl)).rejects.toThrow(PersonalDatabaseRefusedError);

    expect(await rowCounts()).toEqual(before);
  });

  it('db:seed:reference exits non-zero naming the database, touching zero rows', async () => {
    const before = await rowCounts();
    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

    let status: number | undefined;
    let output = '';
    try {
      execFileSync(tsxBin, ['src/db/seed-reference.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: markedAppUrl,
          DATABASE_MIGRATION_URL: markedMigrationUrl,
        },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const execError = error as { status?: number; stdout?: string; stderr?: string };
      status = execError.status;
      output = `${execError.stdout ?? ''}${execError.stderr ?? ''}`;
    }

    expect(status, 'the seed must exit non-zero').toBe(1);
    expect(output).toContain(MARKED_DB);
    expect(await rowCounts()).toEqual(before);
  }, 60_000);

  it('the marker survives truncating every table, and the guards still refuse', async () => {
    // DL-021-13: the reason the marker is not a row. Truncated directly — not
    // through reset.ts, which would (correctly) refuse — to simulate the one
    // unguarded path the marker must outlive.
    const direct = new Pool({ connectionString: markedMigrationUrl, max: 1 });
    try {
      const { rows } = await direct.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      );
      const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
      await direct.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    } finally {
      await direct.end();
    }

    expect((await readInstanceMarker(markedMigrationUrl)).role).toBe('personal');
    await expect(resetConfigState(markedMigrationUrl)).rejects.toThrow(
      PersonalDatabaseRefusedError,
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
