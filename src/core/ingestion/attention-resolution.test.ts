import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedRecord, NormalizedTransactionRecord } from '@/core/ingestion/ports';
import { attentionResolutionOf } from '@/core/ingestion/attention-resolution';

function movement(overrides: Partial<NormalizedTransactionRecord> = {}): NormalizedRecord {
  return {
    kind: 'transaction',
    b3Type: 'Dividendo',
    direction: 'credit',
    assetCode: 'GRND3',
    assetName: 'Grendene',
    assetClass: 'stock',
    institutionName: 'Corretora Teste',
    tradeDate: BusinessDate.of('2026-05-20'),
    quantity: Quantity.fromString('300'),
    unitPrice: Money.fromString('0.11'),
    priceStated: true,
    fees: Money.zero(),
    ratio: null,
    ...overrides,
  };
}

const unclassified = { classification: 'unclassified' } as const;

describe('SPEC-022 BR-022-35 — attentionResolutionOf', () => {
  describe('reimport: the current map classifies a row the batch staged before it', () => {
    it('a type the map now ignores (#196: Tesouro custody fees)', () => {
      const fee = movement({
        b3Type: 'Cobrança de Taxa Semestral',
        direction: 'debit',
        assetClass: 'tesouro_direto',
      });
      expect(attentionResolutionOf(unclassified, fee)).toBe('reimport');
    });

    it('a type the map now maps (#192: reactivated JCP)', () => {
      const jcp = movement({ b3Type: 'Juros Sobre Capital Próprio - Reativado' });
      expect(attentionResolutionOf(unclassified, jcp)).toBe('reimport');
    });

    it('a price-less payment the current parser prices from its stated total (#192)', () => {
      // The re-read record states the price `cashEarningsPrice` recovered.
      const recovered = movement({ priceStated: true, priceDerivedFromTotal: true });
      expect(attentionResolutionOf(unclassified, recovered)).toBe('reimport');
    });

    it('a mapped type whose effect never reads the price', () => {
      const bonus = movement({ b3Type: 'Bonificação em Ativos', priceStated: false });
      expect(attentionResolutionOf(unclassified, bonus)).toBe('reimport');
    });
  });

  describe('decide: mapped or named, but this row is evidence a rule leaves inert', () => {
    it('a price-less credit of a type whose effect depends on price (#158 D6: RECT12)', () => {
      const transfer = movement({
        b3Type: 'Transferência',
        assetCode: 'RECT12',
        priceStated: false,
        unitPrice: Money.zero(),
      });
      expect(attentionResolutionOf(unclassified, transfer)).toBe('decide');
    });

    it('a price-less payment the current parser still cannot price', () => {
      const dividend = movement({ priceStated: false, unitPrice: Money.zero() });
      expect(attentionResolutionOf(unclassified, dividend)).toBe('decide');
    });

    it.each(['Atualização', 'Incorporação'])(
      'conversion evidence no resolver settled (#158 D7/D8): %s',
      (b3Type) => {
        expect(attentionResolutionOf(unclassified, movement({ b3Type }))).toBe('decide');
      },
    );

    it('a price-less listed Resgate, which is conversion evidence rather than a sale', () => {
      const resgate = movement({ b3Type: 'Resgate', priceStated: false });
      expect(attentionResolutionOf(unclassified, resgate)).toBe('decide');
    });

    it.each(['Desdobro', 'Grupamento', 'Fração em Ativos', 'Leilão de Fração'])(
      'a corporate-event row BR-005-20b could not confirm: %s',
      (b3Type) => {
        expect(attentionResolutionOf(unclassified, movement({ b3Type }))).toBe('decide');
      },
    );

    it('a row whose stored copy the user edited, which no import touches', () => {
      const fee = movement({ b3Type: 'Cobrança de Taxa Semestral', direction: 'debit' });
      expect(attentionResolutionOf(unclassified, fee, true)).toBe('decide');
    });

    it('a row commit refused (#117), whatever the map says of its type', () => {
      const refused = movement({ b3Type: 'Venda' });
      expect(attentionResolutionOf({ classification: 'invalid' }, refused)).toBe('decide');
    });

    it('a record that is not a movement at all', () => {
      const position: NormalizedRecord = {
        kind: 'position',
        assetCode: 'PETR4',
        assetName: 'Petrobras PN',
        assetClass: 'stock',
        institutionName: null,
        quantity: Quantity.fromString('1'),
        fixedIncome: null,
      };
      expect(attentionResolutionOf(unclassified, position)).toBe('decide');
    });
  });

  describe('no_rule: the movement type is not in the map (BR-005-19)', () => {
    it('an unmapped type, priced or not', () => {
      expect(attentionResolutionOf(unclassified, movement({ b3Type: 'Um Tipo Novo' }))).toBe(
        'no_rule',
      );
      expect(
        attentionResolutionOf(
          unclassified,
          movement({ b3Type: 'Restituição de Capital em Ações', priceStated: false }),
        ),
      ).toBe('no_rule');
    });
  });
});
