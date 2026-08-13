import { describe, expect, it } from 'vitest';
import {
  AUDIT_TABLES,
  AUTH_SUBSTRATE_TABLES,
  INFRASTRUCTURE_TABLES,
  SHARED_TABLES,
  isSharedTable,
} from '@/db/shared-tables';

/**
 * AR-15 / BR-003-06. The enumeration gate in `tests/isolation/` treats every
 * table *not* on this list as tenant-scoped, so the list is the one place where
 * a table can legitimately escape the tenant boundary. These assertions exist so
 * that widening it is a deliberate act with a failing test attached, rather than
 * something that happens by autocomplete.
 */
describe('shared table declaration', () => {
  it('pins the exempt list exactly, so growing it fails a test rather than passing quietly', () => {
    // AR-15 names five; `runtime_state` was added by SPEC-002 under BR-003-06's
    // "reviewed when added" clause — it holds a system-written cadence value and
    // the reason for it, nothing derived from anyone's holdings. The reasoning
    // lives in src/db/shared-tables.ts.
    //
    // This assertion is deliberately exact. Its whole value is that the next
    // person to widen the tenant-boundary exemption has to come here and say
    // why, rather than appending a string and watching the suite stay green.
    expect([...SHARED_TABLES].sort()).toEqual([
      'assets',
      'index_series',
      'institutions',
      'latest_quotes',
      'price_quotes',
      'runtime_state',
    ]);
  });

  it('keeps the audit log exempt for a stated reason, not by being lumped in', () => {
    // Cross-tenant readability is the point of an audit log (BR-004-17), so it
    // cannot carry a policy keyed on app.user_id. It is a weaker exemption than
    // the reference tables — it *can* hold tenant data in previous/new value —
    // so it is declared apart from them, and its retention and deletion
    // semantics are raised on SPEC-004 (#7) rather than settled here.
    expect(AUDIT_TABLES).toEqual(['audit_log']);
    expect(SHARED_TABLES).not.toContain('audit_log');
    expect(isSharedTable('audit_log')).toBe(true);
  });

  it('treats an unlisted table as tenant-scoped', () => {
    // Failing closed is the entire design: a table nobody classified is assumed
    // to hold personal data until someone says otherwise.
    expect(isSharedTable('transactions')).toBe(false);
    expect(isSharedTable('wallets')).toBe(false);
    expect(isSharedTable('import_rows')).toBe(false);
    expect(isSharedTable('')).toBe(false);
  });

  it('recognises the declared reference tables', () => {
    for (const table of SHARED_TABLES) {
      expect(isSharedTable(table)).toBe(true);
    }
  });

  it('excludes migration bookkeeping, which is machinery rather than data', () => {
    for (const table of INFRASTRUCTURE_TABLES) {
      expect(isSharedTable(table)).toBe(true);
    }
  });
});

/**
 * SPEC-001 (#4): the auth substrate exemption is a *different* kind of
 * declaration from BR-003-06 above — these tables are not reference data,
 * they are the mechanism that determines tenant identity in the first place
 * (see the long comment on `AUTH_SUBSTRATE_TABLES` in shared-tables.ts for
 * why RLS cannot apply to them). Asserted separately so the two exemption
 * reasons stay distinguishable in the test output, not just in a comment.
 */
describe('auth substrate declaration (SPEC-001 #4)', () => {
  it('declares exactly the four Auth.js tables and no others', () => {
    expect([...AUTH_SUBSTRATE_TABLES].sort()).toEqual([
      'accounts',
      'sessions',
      'users',
      'verification_tokens',
    ]);
  });

  it('recognises every declared auth substrate table', () => {
    for (const table of AUTH_SUBSTRATE_TABLES) {
      expect(isSharedTable(table)).toBe(true);
    }
  });

  it('does not conflate the auth substrate with the BR-003-06 reference tables', () => {
    for (const table of AUTH_SUBSTRATE_TABLES) {
      expect(SHARED_TABLES).not.toContain(table);
    }
  });
});

describe('isolation-test scratch tables', () => {
  it('exempts nothing by name pattern — fixtures are the test suite’s problem', () => {
    // The harness prefix is filtered inside tests/isolation/enumeration.test.ts
    // instead. A production exemption keyed on a name pattern is a hole a real
    // table can be walked through by naming it correctly, and this declaration
    // is the one place in the codebase that must not have one.
    expect(isSharedTable('_rls_harness_two_tenant')).toBe(false);
    expect(isSharedTable('wallets_rls_harness_not_a_prefix')).toBe(false);
  });
});
