import { describe, expect, it } from 'vitest';
import { fakeTx, poisonTx } from '@/config/test-support/fake-tx';
import { getRuntimeStateRow, setRuntimeState } from './runtime-state';

/**
 * BR-002-05/06, BR-008-22. The real read/write-and-audit round trip against
 * Postgres is tests/integration/config-resolve.test.ts and
 * .../config-audit.test.ts. This file covers the two branches that don't
 * need a real database at all: no row found, and a value that fails its own
 * schema being rejected before ever reaching the database (a system-written
 * value failing its own registry entry is a bug, not an expected outcome —
 * ARCHITECTURE §9 — so it throws rather than returning a `Result`).
 */
describe('getRuntimeStateRow', () => {
  it('returns undefined when no row exists for the key', async () => {
    const tx = fakeTx({ selectRows: [] });
    const row = await getRuntimeStateRow(tx, 'quotes.cadence_minutes');
    expect(row).toBeUndefined();
  });

  it('returns the row, typed to the key, when one exists', async () => {
    const tx = fakeTx({
      selectRows: [
        {
          value: 120,
          reason: 'cadence degraded: budget alert crossed',
          updatedAt: new Date('2026-01-01'),
        },
      ],
    });
    const row = await getRuntimeStateRow(tx, 'quotes.cadence_minutes');
    expect(row?.value).toBe(120);
    expect(row?.reason).toBe('cadence degraded: budget alert crossed');
  });
});

describe('setRuntimeState', () => {
  it('rejects a value that fails its own registry schema, without touching the database', async () => {
    await expect(
      setRuntimeState(poisonTx(), 'quotes.cadence_minutes', 0, 'should never reach the database'),
    ).rejects.toThrow();
  });

  it('writes the parsed value and reason for a valid value, and audits the change with actor "system"', async () => {
    // setRuntimeState makes two inserts (runtime_state, then audit_log) —
    // captured in order rather than by field name, so the assertion doesn't
    // depend on the two tables' differently-shaped rows.
    const insertedRows: unknown[] = [];
    const tx = fakeTx({ onInsertValues: (values) => insertedRows.push(values) });

    await setRuntimeState(
      tx,
      'quotes.cadence_minutes',
      90,
      'cadence degraded: budget alert crossed',
    );

    expect(insertedRows).toHaveLength(2);
    const [runtimeStateRow, auditRow] = insertedRows as [
      { value: unknown; reason: unknown },
      { actor: unknown; action: unknown; newValue: unknown },
    ];
    expect(runtimeStateRow.value).toBe(90);
    expect(runtimeStateRow.reason).toBe('cadence degraded: budget alert crossed');
    expect(auditRow.actor).toBe('system');
    expect(auditRow.action).toBe('runtime_state.set');
    expect(auditRow.newValue).toEqual({
      value: 90,
      reason: 'cadence degraded: budget alert crossed',
    });
  });
});
