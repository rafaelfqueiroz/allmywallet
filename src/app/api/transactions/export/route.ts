import { type NextRequest, NextResponse } from 'next/server';
import { requireUserId } from '@/lib/session';
import { fromSearchParams } from '@/lib/transactions-url-state';
import { exportTransactionsCsv } from '@/core/ledger/export-transactions';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';

/**
 * SPEC-006 BR-006-10 / AR-33 — a route handler, not a server action, because
 * this is a file download: the response body is the CSV stream itself, with
 * a `Content-Disposition` header, which a server action's serialisable
 * `Result` return value cannot express. Mirrors
 * `src/app/api/privacy/export/csv/route.ts`.
 *
 * **Honours the active filters, never the whole ledger.** The query string is
 * parsed with the exact same `lib/transactions-url-state.ts` the page itself
 * reads — `page` is simply not part of `TransactionFilter`, so a request that
 * happens to carry one is naturally ignored, and "export what I am looking
 * at" means the whole filtered set rather than the one page on screen.
 *
 * `exportTransactionsCsv` (`core/ledger/export-transactions.ts`) already
 * neutralises formula-injection cells (SPEC-003 BR-003-13) — nothing here
 * touches the CSV body.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const userId = await requireUserId();
  const { filter } = fromSearchParams({
    get: (name) => request.nextUrl.searchParams.get(name),
  });

  const csv = await withTransactionsDeps(userId, (deps) =>
    exportTransactionsCsv(deps.transactions, filter),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="transacoes.csv"',
    },
  });
}
