import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportRowId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  TEST_USER_ID,
  aTransaction,
  importBatchIdFor,
} from '@/core/ledger/test-support/transaction-builder';
import { positionKeyString } from '@/core/positions/replay';
import { buildCorporateEventRows } from '@/core/ingestion/corporate-event-evidence';
import { resolveCorporateEvents } from '@/core/ingestion/corporate-event-resolution';
import type { ImportRow } from '@/core/ingestion/ports';

describe('SPEC-005 BR-005-20b — corporate-event read evidence', () => {
  it('reuses and covers a committed unclassified row instead of counting it twice', () => {
    const batchId = importBatchIdFor('evidence-batch');
    const storedBase = aTransaction()
      .rendimento()
      .status('unclassified')
      .of('MGLU3')
      .at('XP')
      .on('2024-05-30')
      .quantity('630')
      .price('0')
      .imported('evidence-batch')
      .build();
    const stored = { ...storedBase, naturalKey: `${storedBase.naturalKey}|desdobro` };
    const row: ImportRow = {
      id: ImportRowId.generate(),
      batchId,
      raw: {},
      record: {
        kind: 'transaction',
        b3Type: 'Desdobro',
        direction: 'credit',
        assetCode: 'MGLU3',
        assetName: 'Magazine Luiza ON',
        assetClass: 'stock',
        institutionName: 'XP',
        tradeDate: BusinessDate.of('2024-05-30'),
        quantity: Quantity.fromString('630'),
        unitPrice: Money.zero(),
        priceStated: false,
        fees: Money.zero(),
        ratio: null,
      },
      assetId: stored.assetId,
      institutionId: stored.institutionId,
      classification: 'unclassified',
      naturalKey: stored.naturalKey,
      occurrence: stored.occurrence,
      ledgerType: stored.type,
      transactionId: stored.id,
    };
    const ledgerByPosition = new Map([[positionKeyString(stored), [stored]]]);

    const events = buildCorporateEventRows({
      rows: [row],
      ledgerByPosition,
      batchId,
      userId: TEST_USER_ID,
      now: new Date('2026-03-15T12:00:00Z'),
      today: BusinessDate.of('2026-03-15'),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: row.id, open: true, transaction: stored });
    const outcomes = resolveCorporateEvents({
      rows: events,
      history: () => [stored],
      factors: new Map(),
      windows: { factorDays: 7, originDays: 30, auctionDays: 180 },
    });
    expect(outcomes.get(row.id)).toMatchObject({ status: 'refused', refusal: 'no_basis' });
  });
});
