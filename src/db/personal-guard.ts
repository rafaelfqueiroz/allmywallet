import { Pool } from 'pg';

/**
 * SPEC-021 BR-021-07/BR-021-08 (AR-72) — the refusal guard.
 *
 * The personal instance is the only copy of everything B3 does not hold, and
 * the variable it needs for migrations (`DATABASE_MIGRATION_URL`) is exactly
 * the one `startTestDatabase` reuses and `tests/support/reset.ts` truncates
 * through. One leftover export in a shell would erase it, silently. This guard
 * is the second barrier (DL-021-05); the separate Compose project is the first.
 *
 * The marker is a **database-level setting**, not a row (DL-021-13):
 *
 *   ALTER DATABASE allmywallet SET allmywallet.instance_role = 'personal';
 *
 * `reset.ts` truncates `runtime_state` itself, so a table marker would be
 * erased by the very operation it exists to stop. A per-database setting
 * survives every `TRUNCATE` and needs no migration.
 *
 * It is called from each dangerous tool's **own entrypoint** — the test
 * database helper, the reset helpers, the seed script — and never from
 * `src/db/client.ts`, which the personal `web` and `worker` connect through.
 */

export const INSTANCE_ROLE_SETTING = 'allmywallet.instance_role';
export const PERSONAL_INSTANCE_ROLE = 'personal';

export class PersonalDatabaseRefusedError extends Error {
  constructor(readonly database: string) {
    super(
      `Refusing to touch database "${database}": it carries ${INSTANCE_ROLE_SETTING} = ` +
        `'${PERSONAL_INSTANCE_ROLE}', the personal production instance (SPEC-021 BR-021-08). ` +
        'Tests, resets and seeds run only against disposable databases — unset ' +
        'DATABASE_MIGRATION_URL/DATABASE_URL, or point them at a development database.',
    );
    this.name = 'PersonalDatabaseRefusedError';
  }
}

export interface InstanceMarker {
  readonly database: string;
  /** `current_setting(…, true)`: `NULL` when never set, `''` after a `RESET` in some sessions. */
  readonly role: string | null;
}

/**
 * Pure decision, split out so every branch is unit-testable without Postgres.
 * A missing setting and an empty one both read as "not personal" — anything
 * else that is not exactly `'personal'` is also allowed through, because the
 * marker has one meaning and guessing at others would refuse legitimate
 * databases for a typo nobody made.
 */
export function refusalFor(marker: InstanceMarker): PersonalDatabaseRefusedError | null {
  return marker.role === PERSONAL_INSTANCE_ROLE
    ? new PersonalDatabaseRefusedError(marker.database)
    : null;
}

/**
 * Reads the marker on a **fresh connection**. `ALTER DATABASE … SET` applies
 * to sessions started after it, so a pooled connection opened earlier could
 * still read `NULL` from a database that has since been marked.
 */
export async function readInstanceMarker(url: string): Promise<InstanceMarker> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ database: string; role: string | null }>(
      `SELECT current_database() AS database, current_setting($1, true) AS role`,
      [INSTANCE_ROLE_SETTING],
    );
    const row = rows[0];
    if (!row) throw new Error('personal-guard: the marker query returned no row');
    return { database: row.database, role: row.role };
  } finally {
    await pool.end();
  }
}

/** Throws `PersonalDatabaseRefusedError` naming the database, before any other statement runs. */
export async function assertNotPersonalDatabase(url: string): Promise<void> {
  const refusal = refusalFor(await readInstanceMarker(url));
  if (refusal) throw refusal;
}
