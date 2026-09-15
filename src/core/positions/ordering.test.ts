import { beforeEach, describe, expect, it } from 'vitest';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { compareForReplay, sortForReplay, typeRank } from '@/core/positions/ordering';

/**
 * SPEC-007 BR-007-15 — "a split processed out of order silently corrupts every
 * subsequent average". These tests pin the order down explicitly, because
 * nothing downstream would ever notice it changing.
 */
describe('replay ordering', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  describe('typeRank', () => {
    it('ranks share-base events before every trade on the same date', () => {
      for (const event of ['split', 'grupamento', 'bonificacao'] as const) {
        for (const trade of [
          'buy',
          'sell',
          'subscription',
          'transfer_in',
          'transfer_out',
        ] as const) {
          expect(typeRank(event)).toBeLessThan(typeRank(trade));
        }
      }
    });

    it('ranks acquisitions before disposals, so a same-day buy is in the average a sale realises against', () => {
      expect(typeRank('buy')).toBeLessThan(typeRank('sell'));
      expect(typeRank('transfer_in')).toBeLessThan(typeRank('transfer_out'));
      expect(typeRank('subscription')).toBeLessThan(typeRank('sell'));
    });

    it('ranks adjustments between acquisitions and disposals', () => {
      expect(typeRank('buy')).toBeLessThan(typeRank('adjustment'));
      expect(typeRank('adjustment')).toBeLessThan(typeRank('sell'));
    });

    it('assigns every one of BR-006-05’s fifteen types a rank', () => {
      // A type with no rank would sort as NaN and make the comparator
      // non-transitive — which corrupts the fold in a way that depends on the
      // input array's length.
      for (const type of TRANSACTION_TYPES) {
        expect(Number.isInteger(typeRank(type))).toBe(true);
      }
      expect(TRANSACTION_TYPES).toHaveLength(15);
    });

    it('BR-007-05a — ranks the bonificação fraction after share-base events and before every trade', () => {
      for (const event of ['split', 'grupamento', 'bonificacao'] as const) {
        expect(typeRank(event)).toBeLessThan(typeRank('fracao_bonificacao'));
      }
      for (const later of [
        'buy',
        'subscription',
        'transfer_in',
        'adjustment',
        'sell',
        'transfer_out',
        'dividend',
        'leilao_fracoes',
      ] as const) {
        expect(typeRank('fracao_bonificacao')).toBeLessThan(typeRank(later));
      }
    });

    it('BR-014-01 — ranks leilão de frações with the other proventos', () => {
      for (const provento of ['dividend', 'jcp', 'rendimento', 'amortization'] as const) {
        expect(typeRank('leilao_fracoes')).toBe(typeRank(provento));
      }
    });

    it('#113 — inserting rank 1 changed no pre-existing relative order', () => {
      // The table as it stood before #113, written out literally so this test
      // does not read the code it checks.
      const BEFORE_113 = {
        split: 0,
        grupamento: 0,
        bonificacao: 0,
        buy: 1,
        subscription: 1,
        transfer_in: 1,
        adjustment: 2,
        sell: 3,
        transfer_out: 3,
        dividend: 4,
        jcp: 4,
        rendimento: 4,
        amortization: 4,
      } as const;
      const types = Object.keys(BEFORE_113) as (keyof typeof BEFORE_113)[];
      expect(types).toHaveLength(13);
      for (const a of types) {
        for (const b of types) {
          expect(Math.sign(typeRank(a) - typeRank(b)), `${a} vs ${b}`).toBe(
            Math.sign(BEFORE_113[a] - BEFORE_113[b]),
          );
        }
      }
    });
  });

  describe('compareForReplay — the key is (trade_date, type_rank, created_at, id)', () => {
    it('orders by trade date first', () => {
      const earlier = aTransaction().on('2026-01-05').build();
      const later = aTransaction().on('2026-02-05').build();
      expect(compareForReplay(earlier, later)).toBeLessThan(0);
      expect(compareForReplay(later, earlier)).toBeGreaterThan(0);
    });

    it('breaks a same-date tie by type rank, not by insertion order', () => {
      // The buy is built first, so it has the lower id and the earlier
      // created_at — and must still sort *after* the split.
      const buy = aTransaction().buy().on('2026-02-10').build();
      const split = aTransaction().split().ratio('2').on('2026-02-10').build();
      expect(compareForReplay(split, buy)).toBeLessThan(0);
    });

    it('breaks a same-date same-rank tie by created_at', () => {
      const first = aTransaction().buy().on('2026-02-10').createdAt('2026-02-10T10:00:00Z').build();
      const second = aTransaction()
        .buy()
        .on('2026-02-10')
        .createdAt('2026-02-10T11:00:00Z')
        .build();
      expect(compareForReplay(first, second)).toBeLessThan(0);
      expect(compareForReplay(second, first)).toBeGreaterThan(0);
    });

    it('falls back to the id when even created_at ties', () => {
      // Not exotic: an import commit inserts thousands of rows inside one
      // transaction, so identical timestamps are the common case. Without this
      // key the fold's result would depend on the database's row order and
      // DM-4 would fail intermittently.
      const stamp = '2026-02-10T10:00:00Z';
      const first = aTransaction().buy().on('2026-02-10').createdAt(stamp).build();
      const second = aTransaction().buy().on('2026-02-10').createdAt(stamp).build();

      expect(first.createdAt.getTime()).toBe(second.createdAt.getTime());
      expect(compareForReplay(first, second)).toBeLessThan(0);
      expect(compareForReplay(second, first)).toBeGreaterThan(0);
    });

    it('reports a row as equal to itself, so the sort is stable and total', () => {
      const only = aTransaction().build();
      expect(compareForReplay(only, only)).toBe(0);
    });
  });

  describe('sortForReplay', () => {
    it('does not mutate the caller’s array', () => {
      // A sort in place would make the fold's result depend on how many times
      // it had already been run — the worst kind of bug to reproduce.
      const input = [
        aTransaction().on('2026-03-01').build(),
        aTransaction().on('2026-01-01').build(),
      ];
      const originalOrder = input.map((t) => t.id);

      sortForReplay(input);

      expect(input.map((t) => t.id)).toEqual(originalOrder);
    });

    it('produces one canonical order regardless of arrival order', () => {
      const january = aTransaction().buy().on('2026-01-05').build();
      const februarySplit = aTransaction().split().ratio('2').on('2026-02-10').build();
      const februaryBuy = aTransaction().buy().on('2026-02-10').build();
      const march = aTransaction().sell().on('2026-03-15').build();

      const expected = [january.id, februarySplit.id, februaryBuy.id, march.id];

      expect(sortForReplay([march, februaryBuy, februarySplit, january]).map((t) => t.id)).toEqual(
        expected,
      );
      expect(sortForReplay([februaryBuy, january, march, februarySplit]).map((t) => t.id)).toEqual(
        expected,
      );
    });

    it('same day: bonificação, then its fraction, then buy, then sell, then provento', () => {
      // Built in exactly the reverse order, so ids and created_at both point
      // the wrong way and only the type rank can produce the expected order.
      const provento = aTransaction().leilaoFracoes().on('2026-03-10').build();
      const sell = aTransaction().sell().on('2026-03-10').build();
      const buy = aTransaction().buy().on('2026-03-10').build();
      const fraction = aTransaction().fracaoBonificacao().on('2026-03-10').build();
      const bonus = aTransaction().bonificacao().on('2026-03-10').build();

      expect(sortForReplay([provento, sell, buy, fraction, bonus]).map((t) => t.id)).toEqual([
        bonus.id,
        fraction.id,
        buy.id,
        sell.id,
        provento.id,
      ]);
    });

    it('handles an empty ledger', () => {
      expect(sortForReplay([])).toEqual([]);
    });
  });
});
