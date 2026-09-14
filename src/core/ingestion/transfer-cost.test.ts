import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import { carriedTransferCosts, type TransferLeg } from '@/core/ingestion/transfer-cost';

const asset = AssetId.generate();
const source = InstitutionId.generate();
const destination = InstitutionId.generate();
const day = BusinessDate.of('2026-03-10');

function leg(overrides: Partial<TransferLeg>): TransferLeg {
  return {
    assetId: asset,
    institutionId: destination,
    tradeDate: day,
    quantity: Quantity.fromString('100'),
    ledgerType: 'transfer_in',
    needsCarriedCost: true,
    ...overrides,
  };
}

const debit = leg({ institutionId: source, ledgerType: 'transfer_out', needsCarriedCost: false });

function ledger(history: readonly Transaction[]) {
  const asked: (InstitutionId | null)[] = [];
  return {
    asked,
    listForPosition: async (_assetId: AssetId, institutionId: InstitutionId | null) => {
      asked.push(institutionId);
      return history;
    },
  };
}

// Hand-computed: 100 @ 10,00 then 100 @ 20,00, no fees → preço médio 15,00.
const twoBuys = [
  aTransaction().buy().on('2026-01-05').quantity('100').price('10').fees('0').build(),
  aTransaction().buy().on('2026-02-05').quantity('100').price('20').fees('0').build(),
];

describe('#110 — carriedTransferCosts', () => {
  it('carries the source position’s average cost onto the matching credit', async () => {
    const repo = ledger(twoBuys);

    const costs = await carriedTransferCosts(repo, [leg({}), debit]);

    expect(costs.get(0)?.equals(Money.fromString('15'))).toBe(true);
    expect(repo.asked).toEqual([source]);
  });

  it('replays only what happened before the transfer day, so a re-import computes the same cost', async () => {
    const sameDay = aTransaction().buy().on('2026-03-10').quantity('100').price('90').fees('0');

    const costs = await carriedTransferCosts(ledger([...twoBuys, sameDay.build()]), [
      leg({}),
      debit,
    ]);

    expect(costs.get(0)?.equals(Money.fromString('15'))).toBe(true);
  });

  it('leaves rows that need no carried cost alone', async () => {
    const repo = ledger(twoBuys);

    const costs = await carriedTransferCosts(repo, [leg({ needsCarriedCost: false }), debit]);

    expect(costs.size).toBe(0);
    expect(repo.asked).toEqual([]);
  });

  it.each([
    ['another asset', { assetId: AssetId.generate() }],
    ['another day', { tradeDate: BusinessDate.of('2026-03-11') }],
    ['another quantity', { quantity: Quantity.fromString('99') }],
    ['the same institution', { institutionId: destination }],
    ['a debit that is not a transfer', { ledgerType: 'sell' as const }],
  ])('finds no source in a debit for %s', async (_label, overrides) => {
    const costs = await carriedTransferCosts(ledger(twoBuys), [
      leg({}),
      { ...debit, ...overrides },
    ]);

    expect(costs.size).toBe(0);
  });

  it('pairs one debit with one credit only', async () => {
    const costs = await carriedTransferCosts(ledger(twoBuys), [leg({}), leg({}), debit]);

    expect([...costs.keys()]).toEqual([0]);
  });

  it('carries nothing when the source held fewer shares than left it', async () => {
    const costs = await carriedTransferCosts(ledger(twoBuys.slice(0, 1)), [
      leg({ quantity: Quantity.fromString('150') }),
      { ...debit, quantity: Quantity.fromString('150') },
    ]);

    expect(costs.size).toBe(0);
  });

  it('carries nothing when the source position has no cost', async () => {
    const bonus = aTransaction().bonificacao().on('2026-01-05').quantity('100').price('0').build();

    const costs = await carriedTransferCosts(ledger([bonus]), [leg({}), debit]);

    expect(costs.size).toBe(0);
  });

  it('carries nothing when the source ledger cannot be replayed', async () => {
    const oversold = aTransaction().sell().on('2026-01-05').quantity('10').price('5').build();

    const costs = await carriedTransferCosts(ledger([oversold]), [leg({}), debit]);

    expect(costs.size).toBe(0);
  });
});
