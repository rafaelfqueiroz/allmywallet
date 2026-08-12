import { describe, expect, it } from 'vitest';
import { INFRASTRUCTURE_TABLES, SHARED_TABLES, isSharedTable } from '@/db/shared-tables';

/**
 * AR-15 / BR-003-06. The enumeration gate in `tests/isolation/` treats every
 * table *not* on this list as tenant-scoped, so the list is the one place where
 * a table can legitimately escape the tenant boundary. These assertions exist so
 * that widening it is a deliberate act with a failing test attached, rather than
 * something that happens by autocomplete.
 */
describe('shared table declaration', () => {
  it('declares exactly the five reference tables the architecture exempts', () => {
    // ARCHITECTURE §5 AR-15 names these five and no others. Adding a sixth means
    // asserting it holds no personal data — which is a decision, not an edit.
    expect([...SHARED_TABLES].sort()).toEqual([
      'assets',
      'index_series',
      'institutions',
      'latest_quotes',
      'price_quotes',
    ]);
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
