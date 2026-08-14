import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { reconcilePositions, type ReconciliationInput } from '@/core/ingestion/reconcile';

const asOf = BusinessDate.of('2026-03-15');
const assetId = AssetId.generate();

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    assetId,
    assetCode: 'PETR4',
    institutionId: null,
    computedQuantity: Quantity.fromString('100'),
    b3Quantity: Quantity.fromString('100'),
    firstComputedTradeDate: BusinessDate.of('2020-01-10'),
    hasUnclassifiedRowsAffectingAsset: false,
    ...overrides,
  };
}

describe('SPEC-005 BR-005-22..26 — reconcilePositions', () => {
  it('BR-005-22/AC: a position matching B3 exactly produces no discrepancy and status "reconciled"', () => {
    const report = reconcilePositions(asOf, [input()]);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.status).toBe('reconciled');
  });

  it('BR-005-23: a mismatch is reported with computed, B3 and the signed difference', () => {
    const report = reconcilePositions(asOf, [
      input({
        computedQuantity: Quantity.fromString('90'),
        b3Quantity: Quantity.fromString('100'),
      }),
    ]);
    expect(report.status).toBe('discrepancies_found');
    expect(report.discrepancies).toEqual([
      expect.objectContaining({
        assetCode: 'PETR4',
        computedQuantity: '90',
        b3Quantity: '100',
        difference: '10',
        resolved: false,
      }),
    ]);
  });

  it('BR-005-24: attributes "missing history" when the ledger has no history for the asset at all', () => {
    const report = reconcilePositions(asOf, [
      input({
        computedQuantity: Quantity.zero(),
        b3Quantity: Quantity.fromString('50'),
        firstComputedTradeDate: null,
      }),
    ]);
    expect(report.discrepancies[0]?.cause).toBe('missing_history_before_import_range');
  });

  it('BR-005-24: attributes "missing history" when the ledger holds less than B3 does, even with some history', () => {
    const report = reconcilePositions(asOf, [
      input({
        computedQuantity: Quantity.fromString('90'),
        b3Quantity: Quantity.fromString('100'),
      }),
    ]);
    expect(report.discrepancies[0]?.cause).toBe('missing_history_before_import_range');
  });

  it('BR-005-24: attributes "unclassified rows" ahead of every other signal', () => {
    const report = reconcilePositions(asOf, [
      input({
        computedQuantity: Quantity.zero(),
        b3Quantity: Quantity.fromString('50'),
        firstComputedTradeDate: null,
        hasUnclassifiedRowsAffectingAsset: true,
      }),
    ]);
    expect(report.discrepancies[0]?.cause).toBe('unclassified_rows_affecting_asset');
  });

  it('BR-005-24: attributes "uncaptured corporate event" when the ledger holds more than B3 with no other signal', () => {
    const report = reconcilePositions(asOf, [
      input({
        computedQuantity: Quantity.fromString('200'),
        b3Quantity: Quantity.fromString('100'),
      }),
    ]);
    expect(report.discrepancies[0]?.cause).toBe('uncaptured_corporate_event');
  });

  it('multiple assets: only the ones that disagree appear in the report', () => {
    const otherAsset = AssetId.generate();
    const report = reconcilePositions(asOf, [
      input(),
      input({
        assetId: otherAsset,
        assetCode: 'VALE3',
        computedQuantity: Quantity.fromString('10'),
        b3Quantity: Quantity.fromString('20'),
      }),
    ]);
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]?.assetCode).toBe('VALE3');
  });
});
