import { mkdtemp, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { FakeClock } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';
import {
  buildMovimentacaoXlsx,
  SYNTHETIC_CPF,
} from '@/adapters/ingestion/xlsx/test-support/builder';
import { isValidCpf } from '@/adapters/ingestion/xlsx/strip-cpf';
import { withTenant } from '@/db/tenant';
import type * as LoggerModule from '@/lib/logger';

/**
 * SPEC-004 — the log-scan item `logger.test.ts`'s own "Scope note" flagged
 * as missing: "the acceptance criterion asks for this scan 'across a full
 * import, valuation and report cycle'... this is not itself the full-cycle
 * scan the AC ultimately wants, which can only exist once those flows do."
 * SPEC-005 (import) is merged on `main` as of this issue; SPEC-011
 * (reporting) exists only on an unmerged branch, so this covers the import
 * half for real and explicitly leaves the reporting leg as a gap for
 * whichever issue lands SPEC-011, rather than silently calling this "the
 * full cycle."
 *
 * `logger`/`childLogger` are replaced with a pino instance built from the
 * **real, unmodified `LOGGER_OPTIONS`** (`src/lib/logger.ts`'s own exported
 * configuration — nothing here re-implements the scrub) writing to an
 * in-memory stream instead of stdout, which is what makes the output
 * capturable at all: pino's default destination writes through `sonic-boom`
 * directly against the file descriptor, bypassing `process.stdout.write`
 * and `fs.writeSync` interception alike (both were tried first; neither
 * captured anything). Every log call inside `handleImportStage`/
 * `handleImportCommit` below is real production code running unmodified —
 * only *where the bytes land* is swapped.
 */
const capturedChunks: string[] = [];

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof LoggerModule>();
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      capturedChunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const testLogger = pino(actual.LOGGER_OPTIONS, stream);
  return {
    ...actual,
    logger: testLogger,
    childLogger: (context: Record<string, unknown>) => testLogger.child(context),
  };
});

// Imported *after* the mock so the handler module resolves the mocked `@/lib/logger`.
const { handleImportCommit, handleImportStage, saveUploadedFile } =
  await import('@/worker/handlers/import');

describe('SPEC-004 — PII log scan across a real import cycle', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let uploadDir: string;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-20T12:00:00-03:00');
  const SEEDED_EMAIL = 'investidor.pii-scan@example.com';
  const SEEDED_NAME = 'Fulano de Tal PII Scan';

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
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId, SEEDED_EMAIL, SEEDED_NAME);
    uploadDir = await mkdtemp(join(tmpdir(), 'amw-pii-scan-'));
    capturedChunks.length = 0;
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function newPendingBatch(): Promise<ImportBatchId> {
    const batchId = ImportBatchId.generate();
    await withTenant(
      userId,
      async (tx) =>
        new DrizzleImportBatchRepository(tx, userId).insert({
          id: batchId,
          userId,
          source: 'b3_movimentacao',
          status: 'pending',
          uploadedAt: clock.now(),
          committedAt: null,
          rowCounts: null,
          reconciliation: null,
        }),
      appDb,
    );
    return batchId;
  }

  it('AC — a real import stage+commit cycle, with a CPF in a data cell and a real user profile, logs no personal data', async () => {
    const batchId = await newPendingBatch();
    const bytes = await buildMovimentacaoXlsx([
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        // A CPF planted in a data cell, not only the metadata block — the
        // case import-pipeline.test.ts's own comment explains is the one
        // that actually exercises `sanitizeCells`, not merely BR-005-04's
        // metadata skip.
        produto: `PETR4 - Petrobras PN ${SYNTHETIC_CPF}`,
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ]);
    await saveUploadedFile(uploadDir, batchId, bytes);

    const handlerDeps = () => ({
      database: appDb,
      clock,
      ingestion: new XlsxIngestionPort(),
      uploadDir,
    });

    await handleImportStage({ batchId, userId }, handlerDeps());
    await handleImportCommit({ batchId, userId }, handlerDeps());
    const output = capturedChunks.join('');

    // Sanity: the pipeline actually logged something during this window —
    // an empty capture would make every assertion below pass trivially.
    expect(output.length).toBeGreaterThan(0);

    expect(output).not.toContain(SEEDED_EMAIL);
    expect(output).not.toContain(SEEDED_NAME);
    expect(output).not.toContain(SYNTHETIC_CPF);
    // The bare-digit form too — stripCpf/sanitizeCells operate on both.
    const bareCpf = SYNTHETIC_CPF.replace(/\D/g, '');
    expect(output).not.toContain(bareCpf);
    // Sanity the CPF really was checksum-valid, so the assertion above means something.
    expect(isValidCpf(bareCpf)).toBe(true);
  });

  it('AC — an induced parser error (unreadable file) produces a report with no personal data', async () => {
    const batchId = await newPendingBatch();
    // Not a real xlsx at all — the parser must fail cleanly, and whatever it
    // logs about the failure must still carry no personal data (there is
    // none to carry here, but the *shape* of the failure log is what this
    // proves: code and structural context only, per AR-39).
    await saveUploadedFile(uploadDir, batchId, new Uint8Array([1, 2, 3, 4]));

    const handlerDeps = () => ({
      database: appDb,
      clock,
      ingestion: new XlsxIngestionPort(),
      uploadDir,
    });

    await expect(handleImportStage({ batchId, userId }, handlerDeps())).rejects.toThrow();
    const output = capturedChunks.join('');

    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(SEEDED_EMAIL);
    expect(output).not.toContain(SEEDED_NAME);
  });

  /**
   * The two tests above prove a *property of today's pipeline*: neither
   * `handleImportStage` nor `handleImportCommit` currently logs a row's
   * content or a user's profile at all — verified by neutering `stripCpf`
   * (`src/adapters/ingestion/xlsx/strip-cpf.ts`'s `sanitizeCells`) during
   * development and confirming both tests **still passed**, which means
   * they were not actually exercising the redaction mechanism, only the
   * absence of a logging call that would need it.
   *
   * This test closes that gap: it calls the exact `logger`/`childLogger`
   * this file's `vi.mock` substitutes — the real `LOGGER_OPTIONS`, writing
   * to the same captured stream every assertion above reads — with a
   * payload shaped like the regression BR-004-04 exists to prevent (a log
   * call that, in the future, mistakenly includes the row or the profile).
   * Proven to bite: temporarily removing `'email'`/`'name'` from
   * `FORBIDDEN_KEYS` and `redact.paths` in `src/lib/logger.ts` and
   * re-running made this test fail with the raw values present in `output`;
   * reverted immediately after, not committed.
   */
  it('the redaction this file relies on is real: a simulated future log call carrying the profile is still scrubbed', async () => {
    const { logger } = await import('@/lib/logger');
    (logger as pino.Logger).info(
      { email: SEEDED_EMAIL, name: SEEDED_NAME, cpf: SYNTHETIC_CPF },
      'simulated regression — a future call that should never ship',
    );
    const output = capturedChunks.join('');
    expect(output).not.toContain(SEEDED_EMAIL);
    expect(output).not.toContain(SEEDED_NAME);
    expect(output).not.toContain(SYNTHETIC_CPF);
  });
});
