import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ImportBatchId, UserId } from '@/core/shared/ids';
import { domainError } from '@/core/shared/domain-error';
import { err, ok } from '@/core/shared/result';
import type { RecalculationOutcome } from '@/core/ledger/recalculate-from';
import type { Transaction } from '@/core/ledger/transaction';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireUserId: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/config/resolve', () => ({ resolveConfig: vi.fn() }));
vi.mock('@/lib/queue', () => ({ enqueue: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/worker/handlers/import', () => ({
  handleImportCancel: vi.fn(),
  saveUploadedFile: vi.fn(),
}));
vi.mock('@/app/(app)/import/composition', () => ({
  withIngestionAndWalletDeps: vi.fn(),
  withIngestionDeps: vi.fn(),
}));
vi.mock('@/core/ingestion/classify-row', () => ({ classifyImportRow: vi.fn() }));
vi.mock('@/core/ingestion/subscription-offer', () => ({
  keepSubscriptionClassification: vi.fn(),
  resolveSubscriptionOffer: vi.fn(),
}));
vi.mock('@/core/ingestion/accept-adjustment', () => ({ acceptReconciliationAdjustment: vi.fn() }));
vi.mock('@/core/wallets/apply-ledger-effects', () => ({ applyLedgerEffects: vi.fn() }));
vi.mock('@/core/wallets/reconcile-allocations', () => ({
  reconcileAllocationsToHoldings: vi.fn(),
}));

import { resolveConfig } from '@/config/resolve';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { requireUserId } from '@/lib/session';
import { withIngestionAndWalletDeps } from '@/app/(app)/import/composition';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import {
  keepSubscriptionClassification,
  resolveSubscriptionOffer,
} from '@/core/ingestion/subscription-offer';
import { acceptReconciliationAdjustment } from '@/core/ingestion/accept-adjustment';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { reconcileAllocationsToHoldings } from '@/core/wallets/reconcile-allocations';
import {
  acceptAdjustmentAction,
  classifyRowAction,
  keepSubscriptionClassificationAction,
  resolveSubscriptionOfferAction,
} from './actions';

/**
 * SPEC-009 BR-009-18 / SPEC-006 BR-006-14 — the import screen's ledger writes
 * (hand classification, subscription resolution, accepting a reconciliation
 * adjustment) ask the worker to rebuild `valuation.snapshot` from the earliest
 * date they made stale, once they have succeeded.
 */
const USER = UserId.of('01920000-0000-7000-8000-000000000003');
const ASSET = AssetId.of('01920000-0000-7000-8000-000000000001');
const ROW = '01920000-0000-7000-8000-0000000000c1';
const BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000d1');
const IDLE_STATE = { status: 'idle' } as const;
const aTransaction = { type: 'buy' } as unknown as Transaction;

const recalculated = (date: string): RecalculationOutcome => ({
  scope: { assetId: ASSET, institutionId: null, fromDate: BusinessDate.of(date) },
  position: null,
});

const rowForm = (extra: Record<string, string> = {}) => {
  const data = new FormData();
  data.set('rowId', ROW);
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return data;
};

const expectRebuildFrom = (from: string) => {
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith('valuation.snapshot', { userId: USER, from });
};

describe('import actions — SPEC-009 BR-009-18 snapshot rebuild request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUserId).mockResolvedValue(USER);
    vi.mocked(resolveConfig).mockResolvedValue({ value: 30 } as never);
    vi.mocked(withIngestionAndWalletDeps).mockImplementation(async (_userId, callback) =>
      callback({} as never, {} as never),
    );
    vi.mocked(applyLedgerEffects).mockResolvedValue(ok(undefined) as never);
    vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue(ok([]));
    vi.mocked(enqueue).mockResolvedValue(undefined);
  });

  describe('classifyRowAction', () => {
    const classified = (...dates: string[]) =>
      ok({
        transaction: aTransaction,
        recalculations: dates.map(recalculated),
        rederived: [],
      });

    it('enqueues one rebuild from the classified row’s date', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(classified('2020-02-10'));

      const result = await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expect(result).toEqual({ status: 'idle' });
      expectRebuildFrom('2020-02-10');
    });

    it('takes the earliest date when carried legs were re-derived', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(classified('2020-02-10', '2020-01-13'));

      await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expectRebuildFrom('2020-01-13');
    });

    it('enqueues nothing when classification is refused', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(err(domainError('ROW_PRICE_NOT_STATED')));

      const result = await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expect(result).toMatchObject({ status: 'error', code: 'ROW_PRICE_NOT_STATED' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing when the wallet effects refuse', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(classified('2020-02-10'));
      vi.mocked(applyLedgerEffects).mockResolvedValue(err(domainError('ALLOCATION_EXCEEDS')));

      const result = await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing for input the schema refuses', async () => {
      const result = await classifyRowAction(IDLE_STATE, new FormData());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(classified('2020-02-10'));
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      const result = await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expect(result).toEqual({ status: 'idle' });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveSubscriptionOfferAction', () => {
    const resolved = (...dates: string[]) =>
      ok({
        transactions: [aTransaction],
        recalculations: dates.map(recalculated),
        rederived: [aTransaction],
      });

    it('enqueues one rebuild from the earliest position the resolution moved', async () => {
      // The credit's re-typed price (2020-01-13) and a transfer carrying its
      // cost onward (2021-09-02): stale from the earlier of the two.
      vi.mocked(resolveSubscriptionOffer).mockResolvedValue(resolved('2021-09-02', '2020-01-13'));

      const result = await resolveSubscriptionOfferAction(IDLE_STATE, rowForm());

      expect(result).toEqual({ status: 'idle' });
      expect(reconcileAllocationsToHoldings).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        new Set([ASSET]),
      );
      expect(applyLedgerEffects).not.toHaveBeenCalled();
      expectRebuildFrom('2020-01-13');
    });

    it('enqueues nothing when the offer is stale or refused', async () => {
      vi.mocked(resolveSubscriptionOffer).mockResolvedValue(
        err(domainError('SUBSCRIPTION_OFFER_UNAVAILABLE')),
      );

      const result = await resolveSubscriptionOfferAction(IDLE_STATE, rowForm());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns the exact allocation reconciliation refusal', async () => {
      vi.mocked(resolveSubscriptionOffer).mockResolvedValue(resolved('2020-01-13'));
      vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue(
        err(domainError('ALLOCATION_EXCEEDS_HOLDINGS', { held: '10', requested: '11' })),
      );

      const result = await resolveSubscriptionOfferAction(IDLE_STATE, rowForm());

      expect(result).toEqual({
        status: 'error',
        code: 'ALLOCATION_EXCEEDS_HOLDINGS',
        context: { held: '10', requested: '11' },
      });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(resolveSubscriptionOffer).mockResolvedValue(resolved('2020-01-13'));
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      const result = await resolveSubscriptionOfferAction(IDLE_STATE, rowForm());

      expect(result).toEqual({ status: 'idle' });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('keepSubscriptionClassificationAction', () => {
    it('enqueues nothing when no carried leg was re-derived — superseding an inactive row moves no figure', async () => {
      vi.mocked(keepSubscriptionClassification).mockResolvedValue(
        ok({
          transactions: [aTransaction],
          recalculations: [recalculated('2020-01-13')],
          rederived: [],
        }),
      );

      const result = await keepSubscriptionClassificationAction(IDLE_STATE, rowForm());

      expect(result).toEqual({ status: 'idle' });
      expect(reconcileAllocationsToHoldings).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        new Set([ASSET]),
      );
      expect(applyLedgerEffects).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues from the earliest position when a carried leg was re-derived', async () => {
      vi.mocked(keepSubscriptionClassification).mockResolvedValue(
        ok({
          transactions: [aTransaction],
          recalculations: [recalculated('2021-09-02'), recalculated('2020-01-13')],
          rederived: [aTransaction],
        }),
      );

      await keepSubscriptionClassificationAction(IDLE_STATE, rowForm());

      expectRebuildFrom('2020-01-13');
    });

    it('enqueues nothing when the use case refuses', async () => {
      vi.mocked(keepSubscriptionClassification).mockResolvedValue(
        err(domainError('SUBSCRIPTION_OFFER_UNAVAILABLE')),
      );

      const result = await keepSubscriptionClassificationAction(IDLE_STATE, rowForm());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns the exact allocation reconciliation refusal', async () => {
      vi.mocked(keepSubscriptionClassification).mockResolvedValue(
        ok({
          transactions: [aTransaction],
          recalculations: [recalculated('2020-01-13')],
          rederived: [],
        }),
      );
      vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue(
        err(domainError('ALLOCATION_EXCEEDS_HOLDINGS', { assetId: ASSET })),
      );

      const result = await keepSubscriptionClassificationAction(IDLE_STATE, rowForm());

      expect(result).toEqual({
        status: 'error',
        code: 'ALLOCATION_EXCEEDS_HOLDINGS',
        context: { assetId: ASSET },
      });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('acceptAdjustmentAction', () => {
    const form = () => {
      const data = new FormData();
      data.set('batchId', BATCH);
      data.set('assetId', ASSET);
      return data;
    };

    it('enqueues from the reconciliation date the adjustment is dated at', async () => {
      vi.mocked(acceptReconciliationAdjustment).mockResolvedValue(
        ok({
          batch: {},
          result: { transaction: aTransaction, recalculation: recalculated('2026-03-02') },
        }) as never,
      );

      const result = await acceptAdjustmentAction(IDLE_STATE, form());

      expect(result).toEqual({ status: 'idle' });
      expectRebuildFrom('2026-03-02');
    });

    it('enqueues nothing when the adjustment is refused', async () => {
      vi.mocked(acceptReconciliationAdjustment).mockResolvedValue(
        err(domainError('ADJUSTMENT_STALE')),
      );

      const result = await acceptAdjustmentAction(IDLE_STATE, form());

      expect(result).toMatchObject({ status: 'error', code: 'ADJUSTMENT_STALE' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns the exact allocation refusal after rolling the adjustment back', async () => {
      vi.mocked(acceptReconciliationAdjustment).mockResolvedValue(
        ok({
          batch: {},
          result: { transaction: aTransaction, recalculation: recalculated('2026-03-02') },
        }) as never,
      );
      vi.mocked(applyLedgerEffects).mockResolvedValue(
        err(domainError('ALLOCATION_EXCEEDS_HOLDINGS', { held: '10', allocated: '12' })),
      );

      const result = await acceptAdjustmentAction(IDLE_STATE, form());

      expect(result).toEqual({
        status: 'error',
        code: 'ALLOCATION_EXCEEDS_HOLDINGS',
        context: { held: '10', allocated: '12' },
      });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still completes, and logs, when the enqueue throws', async () => {
      vi.mocked(acceptReconciliationAdjustment).mockResolvedValue(
        ok({
          batch: {},
          result: { transaction: aTransaction, recalculation: recalculated('2026-03-02') },
        }) as never,
      );
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      await expect(acceptAdjustmentAction(IDLE_STATE, form())).resolves.toEqual({ status: 'idle' });

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
  /**
   * The request must follow the commit. The composition mock only invokes the
   * callback, so without an event log moving `requestSnapshotRebuild` inside
   * the callback would still pass every test above.
   */
  describe('ordering — the rebuild is requested only after the tenant transaction committed', () => {
    let events: string[];

    beforeEach(() => {
      events = [];
      vi.mocked(withIngestionAndWalletDeps).mockImplementation(async (_userId, callback) => {
        events.push('callback-start');
        const result = await callback({} as never, {} as never);
        events.push('commit');
        return result;
      });
      vi.mocked(enqueue).mockImplementation(async () => {
        events.push('enqueue');
      });
    });

    it('classify', async () => {
      vi.mocked(classifyImportRow).mockResolvedValue(
        ok({
          transaction: aTransaction,
          recalculations: [recalculated('2020-02-10')],
          rederived: [],
        }),
      );

      await classifyRowAction(IDLE_STATE, rowForm({ type: 'buy' }));

      expect(events).toEqual(['callback-start', 'commit', 'enqueue']);
    });

    it('resolve as subscription', async () => {
      vi.mocked(resolveSubscriptionOffer).mockResolvedValue(
        ok({
          transactions: [aTransaction],
          recalculations: [recalculated('2020-01-13')],
          rederived: [],
        }),
      );

      await resolveSubscriptionOfferAction(IDLE_STATE, rowForm());

      expect(events).toEqual(['callback-start', 'commit', 'enqueue']);
    });

    it('accept adjustment', async () => {
      vi.mocked(acceptReconciliationAdjustment).mockResolvedValue(
        ok({
          batch: {},
          result: { transaction: aTransaction, recalculation: recalculated('2026-03-02') },
        }) as never,
      );
      const data = new FormData();
      data.set('batchId', BATCH);
      data.set('assetId', ASSET);

      await acceptAdjustmentAction(IDLE_STATE, data);

      expect(events).toEqual(['callback-start', 'commit', 'enqueue']);
    });
  });
});
