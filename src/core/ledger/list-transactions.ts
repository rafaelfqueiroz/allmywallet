import type { DomainError } from '@/core/shared/domain-error';
import { type Result, err, ok } from '@/core/shared/result';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import type {
  Pagination,
  TransactionFilter,
  TransactionPage,
  TransactionRepository,
} from '@/core/ledger/ports';

/**
 * SPEC-006 BR-006-07/08/09 — the chronological, filterable, searchable history.
 *
 * The SQL lives in the adapter; what lives here is the page-size ceiling, and
 * it is a correctness rule rather than a nicety. The list has to work over
 * 10.000+ rows within SPEC-016's budget, and an unbounded `limit` reaching the
 * database is how a single request materialises an entire ledger — which is
 * slow on the VPS's 2 vCPU and, at the CSV boundary, is what turns a page into
 * a memory ceiling.
 */

export const MAX_PAGE_SIZE = 200;

export async function listTransactions(
  transactions: TransactionRepository,
  filter: TransactionFilter,
  pagination: Pagination,
): Promise<Result<TransactionPage, DomainError>> {
  // Integer-valued, positive, bounded. `Number.isInteger` rather than a
  // truncation, so a caller sending 10.5 is told rather than quietly served
  // something else.
  if (
    !Number.isInteger(pagination.limit) ||
    pagination.limit <= 0 ||
    pagination.limit > MAX_PAGE_SIZE
  ) {
    return err(
      ledgerError(LedgerErrorCode.INVALID_PAGINATION, {
        limit: pagination.limit,
        maxLimit: MAX_PAGE_SIZE,
      }),
    );
  }
  if (!Number.isInteger(pagination.offset) || pagination.offset < 0) {
    return err(ledgerError(LedgerErrorCode.INVALID_PAGINATION, { offset: pagination.offset }));
  }

  return ok(await transactions.search(filter, pagination));
}
