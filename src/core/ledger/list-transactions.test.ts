import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, listTransactions } from '@/core/ledger/list-transactions';
import { FakeTransactionRepository } from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';

/**
 * SPEC-006 BR-006-07/08/09. The filter *semantics* are SQL and are proven
 * against real Postgres in `tests/integration/transaction-repository.test.ts`
 * (TS-30); what belongs here is the page-size ceiling, which is a correctness
 * rule rather than a nicety — an unbounded limit reaching the database is how
 * one request materialises an entire ledger.
 */
describe('listTransactions', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  const repository = () =>
    new FakeTransactionRepository(
      Array.from({ length: 25 }, (_, i) =>
        aTransaction()
          .buy()
          .on(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`)
          .build(),
      ),
    );

  it('returns a page and the total matching the filter, not the page size', async () => {
    const result = await listTransactions(repository(), {}, { limit: 10, offset: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(10);
    // Pagination over 10.000 rows needs the full count, not the page length.
    expect(result.value.total).toBe(25);
  });

  it('applies the offset', async () => {
    const result = await listTransactions(repository(), {}, { limit: 10, offset: 20 });
    expect(result.ok && result.value.items).toHaveLength(5);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the ceiling', MAX_PAGE_SIZE + 1],
    ['fractional', 10.5],
  ])('refuses a %s limit', async (_label, limit) => {
    const result = await listTransactions(repository(), {}, { limit, offset: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PAGINATION');
  });

  it('accepts the ceiling itself', async () => {
    const result = await listTransactions(repository(), {}, { limit: MAX_PAGE_SIZE, offset: 0 });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a %s offset', async (_label, offset) => {
    const result = await listTransactions(repository(), {}, { limit: 10, offset });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PAGINATION');
    expect(result.error.context).toEqual({ offset });
  });

  it('passes the filter through untouched', async () => {
    // BR-006-08: filters work independently and in combination. The repository
    // is what applies them; this asserts the use case does not drop or rewrite
    // any of them on the way.
    let seen: unknown;
    const repo = new FakeTransactionRepository([]);
    const spy = {
      ...repo,
      search: async (filter: unknown, pagination: { limit: number; offset: number }) => {
        seen = filter;
        return repo.search(filter as never, pagination);
      },
    } as unknown as FakeTransactionRepository;

    const filter = { search: 'petr', types: ['buy'] as const, from: undefined };
    await listTransactions(spy, filter, { limit: 10, offset: 0 });
    expect(seen).toEqual(filter);
  });
});
