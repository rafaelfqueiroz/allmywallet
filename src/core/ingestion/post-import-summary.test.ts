import { describe, expect, it } from 'vitest';
import { AssetId, ImportBatchId, ImportRowId, UserId, WalletId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { ImportRow, ImportRowClassification } from '@/core/ingestion/ports';
import { buildPostImportSummary } from '@/core/ingestion/post-import-summary';
import type { PendingAllocation } from '@/core/wallets/pending';
import type { WalletAllocation } from '@/core/wallets/ports';

const USER = UserId.generate();
const BATCH = ImportBatchId.generate();
const PETR4 = AssetId.generate();
const ITSA4 = AssetId.generate();
const RETIREMENT = WalletId.generate();

function row(
  assetId: AssetId,
  ledgerType: string | null,
  quantity: string,
  classification: ImportRowClassification = 'new',
): ImportRow {
  return {
    id: ImportRowId.generate(),
    batchId: BATCH,
    raw: {},
    record: {
      kind: 'transaction',
      b3Type: 'Compra',
      direction: null,
      assetCode: 'X',
      assetName: 'X',
      assetClass: 'stock',
      institutionName: null,
      tradeDate: BusinessDate.of('2026-03-10'),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString('10'),
      fees: Money.zero(),
      ratio: null,
    },
    assetId,
    institutionId: null,
    classification,
    naturalKey: 'k',
    occurrence: 1,
    ledgerType,
    transactionId: null,
  } as unknown as ImportRow;
}

function allocation(assetId: AssetId, walletId: WalletId, quantity: string): WalletAllocation {
  return {
    userId: USER,
    walletId,
    assetId,
    quantity: Quantity.fromString(quantity),
    costBasisAtAllocation: null,
  } as unknown as WalletAllocation;
}

const pendingFor = (assetId: AssetId, quantity: string): PendingAllocation => ({
  assetId,
  unassignedQuantity: Quantity.fromString(quantity),
  reason: 'ambiguous_split',
});

describe('SPEC-010 BR-010-15 — the post-import summary', () => {
  it('reports where a purchased asset ended up', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'buy', '100')],
      allocations: [allocation(PETR4, RETIREMENT, '100')],
      pending: [],
    });

    expect(summary.assets).toHaveLength(1);
    expect(summary.assets[0]?.importedQuantity.toString()).toBe('100');
    expect(summary.assets[0]?.destinations).toEqual([
      { walletId: RETIREMENT, quantity: Quantity.fromString('100') },
    ]);
    expect(summary.assets[0]?.pending).toBeNull();
    expect(summary.settled).toBe(true);
  });

  it('sums several rows for the same asset into one line', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'buy', '100'), row(PETR4, 'buy', '50')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toHaveLength(1);
    expect(summary.assets[0]?.importedQuantity.toString()).toBe('150');
  });

  it('BR-010-12 — surfaces a purchase still waiting for a decision, with its reason', () => {
    const summary = buildPostImportSummary({
      rows: [row(ITSA4, 'buy', '20')],
      allocations: [allocation(ITSA4, RETIREMENT, '60')],
      pending: [pendingFor(ITSA4, '20')],
    });

    expect(summary.assets[0]?.pending?.reason).toBe('ambiguous_split');
    expect(summary.assets[0]?.pending?.unassignedQuantity.toString()).toBe('20');
    expect(summary.settled).toBe(false);
  });

  it('a resolved item drops out without the page re-deriving the rule', () => {
    // Same import, after the user allocated the 20. `pending` no longer lists
    // the asset, so the summary settles on its own.
    const summary = buildPostImportSummary({
      rows: [row(ITSA4, 'buy', '20')],
      allocations: [allocation(ITSA4, RETIREMENT, '80')],
      pending: [],
    });

    expect(summary.assets[0]?.pending).toBeNull();
    expect(summary.settled).toBe(true);
  });

  it('BR-006-03 — a duplicate row changed nothing, so it is not in the summary', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'buy', '100', 'duplicate')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toEqual([]);
    expect(summary.settled).toBe(true);
  });

  it('a sale is not an allocation decision and does not appear', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'sell', '40')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toEqual([]);
  });

  it('proventos are not acquisitions', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'dividend', '100')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toEqual([]);
  });

  it('counts a transfer in and a subscription — both bring quantity in', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, 'transfer_in', '10'), row(ITSA4, 'subscription', '5')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toHaveLength(2);
  });

  it('a position row carries no ledger type and is ignored', () => {
    const summary = buildPostImportSummary({
      rows: [row(PETR4, null, '100')],
      allocations: [],
      pending: [],
    });

    expect(summary.assets).toEqual([]);
  });

  it('orders assets deterministically, so two renders agree', () => {
    const first = buildPostImportSummary({
      rows: [row(PETR4, 'buy', '1'), row(ITSA4, 'buy', '1')],
      allocations: [],
      pending: [],
    });
    const second = buildPostImportSummary({
      rows: [row(ITSA4, 'buy', '1'), row(PETR4, 'buy', '1')],
      allocations: [],
      pending: [],
    });

    expect(first.assets.map((a) => a.assetId)).toEqual(second.assets.map((a) => a.assetId));
  });

  it('an import that brought in nothing settles rather than looking unresolved', () => {
    const summary = buildPostImportSummary({ rows: [], allocations: [], pending: [] });
    expect(summary.assets).toEqual([]);
    expect(summary.settled).toBe(true);
  });
});
