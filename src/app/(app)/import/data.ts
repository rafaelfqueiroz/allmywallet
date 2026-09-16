import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { resolveConfig } from '@/config/resolve';
import { businessDateInSaoPaulo, SystemClock, type BusinessDate } from '@/core/shared/clock';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import type { Transaction } from '@/core/ledger/transaction';
import type { ImportBatch, ImportRow } from '@/core/ingestion/ports';
import { daysSinceImport, isImportStale } from '@/core/ingestion/staleness';
import {
  buildPostImportSummary,
  type PostImportSummary,
} from '@/core/ingestion/post-import-summary';
import { adjustmentBlocker, type AdjustmentBlocker } from '@/core/ingestion/accept-adjustment';
import { explainRefusal, type RowRefusal } from '@/core/ingestion/refusal';
import { positionKeyString } from '@/core/positions/replay';
import { listPendingAllocations } from '@/core/wallets/pending';
import { corporateEventMovementOf } from '@/core/ingestion/movement-map';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';
import {
  type CorporateEventOutcome,
  type CorporateEventWindows,
  resolveCorporateEvents,
} from '@/core/ingestion/corporate-event-resolution';
import { buildCorporateEventRows } from '@/core/ingestion/corporate-event-evidence';
import { withIngestionDeps } from '@/app/(app)/import/composition';
import { withWalletDeps } from '@/app/(app)/wallets/composition';

/**
 * SPEC-005 BR-005-20b (#113 PR-B) — the three windows `resolveCorporateEvents`
 * needs, resolved the same way `handleImportCommit` resolves them
 * (`import.corporate_event_factor_window_days`,
 * `import.fraction_origin_window_days`, `import.fraction_auction_window_days`
 * — all deployment-level, so a plain pooled `db` read is enough, exactly as
 * the worker handler does it). A read-time explanation using a different
 * window than commit would use could show a factor as out-of-window that
 * commit actually accepted, or the reverse.
 */
async function loadCorporateEventWindows(): Promise<CorporateEventWindows> {
  return {
    factorDays: (await resolveConfig('import.corporate_event_factor_window_days', { db })).value,
    originDays: (await resolveConfig('import.fraction_origin_window_days', { db })).value,
    auctionDays: (await resolveConfig('import.fraction_auction_window_days', { db })).value,
  };
}

/**
 * AR-31: Server Components call a use case / repository read in `core/`
 * directly, never `db` from the component itself — this module is the seam
 * `page.tsx` reads through.
 */
export async function listImportBatches(userId: UserId): Promise<readonly ImportBatch[]> {
  return withIngestionDeps(userId, (deps) => deps.batches.listAll());
}

/**
 * SPEC-005 BR-005-28 — everything the import page needs to decide whether to
 * prompt, in one read.
 *
 * `thresholdDays` is resolved rather than assumed: `import.staleness_days` has
 * a **user** level, so a quarterly importer's own setting has to win over the
 * deployment default here exactly as it does in the reminder job. Two places
 * deciding "is this stale" from different numbers is how a user ends up
 * nagged on screen by a threshold they already raised.
 */
export interface ImportFreshness {
  readonly lastImportAt: BusinessDate | null;
  readonly daysSinceImport: number | null;
  readonly thresholdDays: number;
  readonly stale: boolean;
  /** No batch has ever been committed — the guide leads rather than follows. */
  readonly firstRun: boolean;
}

export async function loadImportFreshness(
  userId: UserId,
  batches: readonly ImportBatch[],
): Promise<ImportFreshness> {
  const today = new SystemClock().today();

  // AR-11, and not a formality here: `config_overrides` is tenant-scoped, and
  // its RLS policy casts `current_setting('app.user_id')` to uuid. Outside a
  // `withTenant` transaction that setting is the empty string, so the policy
  // does not quietly return nothing — it raises 22P02 and takes the whole page
  // down with it. Reading a user-level config key is a tenant query like any
  // other.
  const thresholdDays = await withTenant(
    userId,
    async (tx) => (await resolveConfig('import.staleness_days', { db: tx, userId })).value,
    db,
  );

  // The most recent *commit*, not the most recent upload: a batch staged and
  // abandoned changed nothing about how current the ledger is, and counting it
  // would silence the prompt for someone whose data never actually landed.
  let latest: Date | null = null;
  for (const batch of batches) {
    if (batch.committedAt === null) continue;
    if (latest === null || batch.committedAt > latest) latest = batch.committedAt;
  }

  const lastImportAt = latest === null ? null : businessDateInSaoPaulo(latest);

  return {
    lastImportAt,
    daysSinceImport: daysSinceImport(lastImportAt, today),
    thresholdDays,
    stale: isImportStale({ lastImportAt, today, thresholdDays }),
    firstRun: lastImportAt === null,
  };
}

export interface ImportBatchDetail {
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly needsAttention: readonly ImportRow[];
  /** SPEC-005 BR-005-19 (amended, #110) — stored and visible, outside Needs attention. */
  readonly ignored: readonly ImportRow[];
  /**
   * SPEC-005 BR-005-25 (#110) — for each unresolved discrepancy B3's figure
   * cannot be accepted for right now, why, keyed by `positionKeyString`. Asked
   * of the current ledger with the same `adjustmentBlocker` the use case refuses
   * with, so the page offers the button exactly where accepting would work.
   */
  readonly acceptBlockers: ReadonlyMap<string, AdjustmentBlocker>;
  /** SPEC-005 #117 — why each `invalid` row was refused, keyed by row id. */
  readonly refusals: ReadonlyMap<string, RowRefusal>;
  /**
   * SPEC-005 BR-005-20b (#113 PR-B) — why each still-`unclassified`
   * corporate-event row (Desdobro, Grupamento, Fração em Ativos, Leilão de
   * Fração) has not resolved, keyed by row id. Derived at read time, the same
   * way `refusals` is: `resolveCorporateEvents` is unchanged and pure
   * (AR-01), called here with the current ledger and no `declined` set —
   * "omitted at read time, where nothing was tried" (that file's own
   * doc comment). A `status: 'resolved'`/`'consumed'` outcome for a row still
   * `unclassified` in a **committed** batch means commit's settlement round
   * declined it because a later row conflicted (BR-005-20b) — the page shows
   * that as conflicting with the ledger, not as "about to resolve".
   */
  readonly corporateEvents: ReadonlyMap<string, CorporateEventOutcome>;
  /**
   * SPEC-010 BR-010-15 — `null` until the batch is committed. Before that
   * nothing has been allocated and a summary would be describing a future.
   */
  readonly summary: PostImportSummary | null;
}

export async function loadImportBatchDetail(
  userId: UserId,
  batchId: ImportBatchId,
): Promise<ImportBatchDetail | null> {
  const detail = await withIngestionDeps(userId, async (deps) => {
    const batch = await deps.batches.findById(batchId);
    if (batch === null) return null;
    const rows = await deps.rows.listByBatch(batchId);

    const acceptBlockers = new Map<string, AdjustmentBlocker>();
    const reconciliation = batch.reconciliation;
    for (const discrepancy of reconciliation?.discrepancies ?? []) {
      if (reconciliation === null || discrepancy.resolved) continue;
      const ledger = await deps.transactions.listForPosition(
        discrepancy.assetId,
        discrepancy.institutionId,
      );
      const blocker = adjustmentBlocker(discrepancy, ledger, reconciliation.asOf);
      if (blocker !== null) acceptBlockers.set(positionKeyString(discrepancy), blocker);
    }

    // #117 BR-005-24: each refused row's cause, asked of the current ledger.
    const refusals = new Map<string, RowRefusal>();
    const ledgers = new Map<
      string,
      Awaited<ReturnType<typeof deps.transactions.listForPosition>>
    >();
    for (const row of rows) {
      if (row.classification !== 'invalid' || row.record.kind !== 'transaction') continue;
      const key = positionKeyString(row);
      const ledger =
        ledgers.get(key) ??
        (await deps.transactions.listForPosition(row.assetId, row.institutionId));
      ledgers.set(key, ledger);
      refusals.set(
        row.id,
        explainRefusal(row, ledger, userId, deps.clock.now(), deps.clock.today()),
      );
    }

    // SPEC-005 BR-005-20b (#113 PR-B) — the same explanation for a
    // corporate-event row that stays `unclassified`: derived at read time
    // from the current ledger, sharing `ledgers`'s per-position cache with
    // the loop above so a position needing both reads its ledger once.
    const corporateEventRows = rows.filter(
      (row) =>
        row.record.kind === 'transaction' && corporateEventMovementOf(row.record.b3Type) !== null,
    );
    const corporateEvents = new Map<string, CorporateEventOutcome>();
    if (corporateEventRows.length > 0) {
      const ledgerByPosition = new Map<string, readonly Transaction[]>();
      for (const row of corporateEventRows) {
        const key = positionKeyString(row);
        if (ledgerByPosition.has(key)) continue;
        const ledger =
          ledgers.get(key) ??
          (await deps.transactions.listForPosition(row.assetId, row.institutionId));
        ledgers.set(key, ledger);
        ledgerByPosition.set(key, ledger);
      }

      const now = deps.clock.now();
      const today = deps.clock.today();
      const eventRows = buildCorporateEventRows({
        rows: corporateEventRows,
        ledgerByPosition,
        batchId: batch.id,
        userId,
        now,
        today,
      });

      // SPEC-008 BR-008-29: only an *open* ratio row needs its issuer's
      // published factors — a settled sibling is context only (never
      // resolved here) and its `ticker` was left blank.
      const issuerCodes = [
        ...new Set(
          eventRows
            .filter(
              (r) => r.open && (r.movement === 'desdobro' || r.movement === 'grupamento'),
            )
            .map((r) => issuerCodeOf(r.ticker))
            .filter((code): code is string => code !== null),
        ),
      ];
      const factors =
        issuerCodes.length === 0
          ? new Map()
          : await deps.corporateEventFactors.listByIssuers(issuerCodes);
      const windows = await loadCorporateEventWindows();
      const outcomes = resolveCorporateEvents({
        rows: eventRows,
        history: (key) => ledgerByPosition.get(positionKeyString(key)) ?? [],
        factors,
        windows,
      });
      for (const row of corporateEventRows) {
        if (row.classification !== 'unclassified') continue;
        const outcome = outcomes.get(row.id);
        if (outcome !== undefined) corporateEvents.set(row.id, outcome);
      }
    }

    return {
      batch,
      rows,
      acceptBlockers,
      refusals,
      corporateEvents,
      needsAttention: rows.filter(
        (row) => row.classification === 'unclassified' || row.classification === 'invalid',
      ),
      ignored: rows.filter((row) => row.classification === 'ignored'),
    };
  });

  if (detail === null || detail.batch.status !== 'committed') {
    return detail === null ? null : { ...detail, summary: null };
  }

  // A second tenant transaction rather than one: the wallet ports are a
  // different composition root, and the summary is a read of *current*
  // allocation state rather than of anything this batch froze — so it does not
  // need to share the ingestion read's snapshot, and pretending it did would
  // imply a consistency guarantee that is not the point (see
  // `post-import-summary.ts` on why current-state is the right answer).
  const { allocations, pending } = await withWalletDeps(userId, async (deps) => ({
    allocations: await deps.allocations.listAll(),
    pending: await listPendingAllocations(deps, userId),
  }));

  return {
    ...detail,
    summary: buildPostImportSummary({ rows: detail.rows, allocations, pending }),
  };
}
