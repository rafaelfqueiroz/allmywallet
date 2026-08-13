import { beforeEach, describe, expect, it } from 'vitest';
import { exportTransactionsCsv, toCsvRows } from '@/core/ledger/export-transactions';
import type { TransactionListItem } from '@/core/ledger/ports';
import { FakeTransactionRepository } from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  importBatchIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';

/** SPEC-006 BR-006-10 / SPEC-003 BR-003-13 / AR-55. */
describe('CSV export', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  function item(overrides: Partial<TransactionListItem> = {}): TransactionListItem {
    return {
      transaction: aTransaction().buy().quantity('100').price('32.15').fees('4.90').build(),
      assetCode: 'PETR4',
      assetName: 'Petrobras PN',
      assetClass: 'stock',
      institutionName: 'Clear',
      ...overrides,
    };
  }

  it('writes a header row and one row per transaction', () => {
    const rows = toCsvRows([item(), item()]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.[0]).toBe('trade_date');
  });

  it('carries the ledger figures as full-precision decimal strings', () => {
    const rows = toCsvRows([item()]);
    const row = rows[1];
    expect(row).toBeDefined();
    if (!row) return;

    expect(row[0]).toBe('2026-01-05');
    expect(row[1]).toBe('PETR4');
    expect(row[7]).toBe('100');
    expect(row[8]).toBe('32.15');
    expect(row[9]).toBe('4.9');
    // 100 × 32,15 + 4,90 = 3.219,90
    expect(row[10]).toBe('3219.9');
  });

  it('never emits exponential notation for a small quantity', () => {
    // A spreadsheet reading `1e-8` where the ledger holds 0,00000001 is the
    // same corruption as a float, arriving by a different door.
    const rows = toCsvRows([
      item({ transaction: aTransaction().buy().quantity('0.00000001').price('1').build() }),
    ]);
    expect(rows[1]?.[7]).toBe('0.00000001');
  });

  it('BR-006-02 — records provenance, distinguishing imported from manual', () => {
    const manual = toCsvRows([item()])[1];
    expect(manual?.[12]).toBe('manual');

    const imported = toCsvRows([
      item({ transaction: aTransaction().buy().imported('batch-a').build() }),
    ])[1];
    expect(imported?.[12]).toBe(`import:${importBatchIdFor('batch-a')}`);
  });

  it('BR-006-16 — records whether a human corrected the row', () => {
    const base = aTransaction().buy().build();
    expect(toCsvRows([item({ transaction: base })])[1]?.[13]).toBe('false');
    expect(toCsvRows([item({ transaction: { ...base, isUserModified: true } })])[1]?.[13]).toBe(
      'true',
    );
  });

  it('leaves the ratio column empty except on a share-base event', () => {
    expect(toCsvRows([item()])[1]?.[11]).toBe('');
    expect(
      toCsvRows([item({ transaction: aTransaction().split().ratio('2').build() })])[1]?.[11],
    ).toBe('2');
  });

  it('renders a missing institution as an empty cell, not "null"', () => {
    expect(toCsvRows([item({ institutionName: null })])[1]?.[4]).toBe('');
  });

  describe('AC / AR-55 — formula-injection neutralisation', () => {
    it('neutralises an asset name that would execute as a formula', async () => {
      // Asset and institution names arrive from a parsed B3 extract — text the
      // export did not author. Opened in Excel, `=cmd|'/c calc'!A1` executes.
      const repository = new FakeTransactionRepository([aTransaction().buy().build()]);
      repository.describeAsset(assetIdFor('PETR4'), {
        code: `=cmd|'/c calc'!A1`,
        name: '@SUM(1+1)',
        assetClass: 'stock',
      });

      const csv = await exportTransactionsCsv(repository, {});

      expect(csv).toContain("'=cmd");
      expect(csv).toContain("'@SUM(1+1)");
      // The dangerous form — a cell starting with a bare `=` — must not appear.
      expect(csv).not.toMatch(/(^|,)=cmd/m);
    });

    it('neutralises a negative amount, which starts with a trigger character', () => {
      // `-` is one of the four triggers, so an ordinary negative adjustment
      // needs neutralising just as much as a crafted name does.
      const rows = toCsvRows([
        item({
          transaction: aTransaction().adjustment().quantity('-10').price('9.00').build(),
        }),
      ]);
      expect(rows[1]?.[7]).toBe('-10');
    });

    it('neutralises institution names too', async () => {
      const row = aTransaction().buy().at('Clear').build();
      const repository = new FakeTransactionRepository([row]);
      repository.describeAsset(assetIdFor('PETR4'), {
        code: 'PETR4',
        name: 'Petrobras',
        assetClass: 'stock',
      });
      repository.describeInstitution(institutionIdFor('Clear'), '+HYPERLINK("http://x")');

      const csv = await exportTransactionsCsv(repository, {});
      expect(csv).toContain("'+HYPERLINK");
    });
  });

  it('BR-006-10 — passes the active filter through to the repository', async () => {
    let seen: unknown;
    const repository = new FakeTransactionRepository([aTransaction().buy().build()]);
    const spy = {
      ...repository,
      export: async (filter: unknown) => {
        seen = filter;
        return repository.export(filter as never);
      },
    } as unknown as FakeTransactionRepository;

    const filter = { search: 'petr', types: ['buy'] as const };
    await exportTransactionsCsv(spy, filter);
    // "Export what I am looking at" cannot quietly widen to the whole ledger.
    expect(seen).toEqual(filter);
  });

  it('produces a header-only file when nothing matches', async () => {
    const csv = await exportTransactionsCsv(new FakeTransactionRepository([]), {});
    expect(csv.split('\r\n')).toHaveLength(1);
    expect(csv.startsWith('trade_date,')).toBe(true);
  });
});
