import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { asStored, type Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
} from '@/core/ledger/test-support/transaction-builder';
import { positionKeyString, replayPosition } from '@/core/positions/replay';
import {
  type CorporateEventFactor,
  type CorporateEventFactorKind,
  factorMultiplier,
} from '@/core/quotes/corporate-event-factors';
import type { CorporateEventMovement } from '@/core/ingestion/movement-map';
import { importNaturalKeyFor } from '@/core/ingestion/occurrence';
import {
  type CorporateEventOutcome,
  type CorporateEventRow,
  type CorporateEventWindows,
  corporateEventMovementOfKey,
  resolveCorporateEvents,
} from '@/core/ingestion/corporate-event-resolution';

/**
 * SPEC-005 BR-005-20b (#113). Every expectation below is computed by hand in
 * the comment beside it (DV-17, TS-05); fixtures are generated, never taken
 * from a real extract (DV-24).
 */

const WINDOWS: CorporateEventWindows = { factorDays: 7, originDays: 30, auctionDays: 180 };
const BROKER = 'XP';

/** A B3 corporate-event row as the ledger stores it before resolution: placeholder type, `unclassified`. */
function storedRow(ticker: string, date: string, quantity: string, price = '0'): Transaction {
  return aTransaction()
    .rendimento()
    .status('unclassified')
    .of(ticker)
    .at(BROKER)
    .on(date)
    .quantity(quantity)
    .price(price)
    .imported()
    .build();
}

function open(
  movement: CorporateEventMovement,
  ticker: string,
  date: string,
  quantity: string,
  price = '0',
): CorporateEventRow {
  const transaction = storedRow(ticker, date, quantity, price);
  return { id: transaction.id, movement, ticker, transaction, open: true };
}

function settled(
  movement: CorporateEventMovement,
  ticker: string,
  transaction: Transaction,
): CorporateEventRow {
  return { id: transaction.id, movement, ticker, transaction, open: false };
}

const buy = (ticker: string, date: string, quantity: string, price: string) =>
  aTransaction().buy().of(ticker).at(BROKER).on(date).quantity(quantity).price(price).build();
const sell = (ticker: string, date: string, quantity: string, price: string) =>
  aTransaction().sell().of(ticker).at(BROKER).on(date).quantity(quantity).price(price).build();
const bonus = (ticker: string, date: string, quantity: string) =>
  aTransaction().bonificacao().of(ticker).at(BROKER).on(date).quantity(quantity).build();

function factor(
  issuerCode: string,
  kind: CorporateEventFactorKind,
  published: string,
  lastDatePrior: string,
): CorporateEventFactor {
  return {
    issuerCode,
    kind,
    factorPublished: published,
    multiplier: factorMultiplier(kind, published),
    lastDatePrior: BusinessDate.of(lastDatePrior),
    approvedOn: null,
  };
}

function resolve(
  rows: readonly CorporateEventRow[],
  ledger: readonly Transaction[],
  factors: readonly CorporateEventFactor[] = [],
) {
  const byIssuer = new Map<string, CorporateEventFactor[]>();
  for (const f of factors) byIssuer.set(f.issuerCode, [...(byIssuer.get(f.issuerCode) ?? []), f]);
  return resolveCorporateEvents({
    rows,
    history: (key) => ledger.filter((t) => positionKeyString(t) === positionKeyString(key)),
    factors: byIssuer,
    windows: WINDOWS,
  });
}

function outcomeOf(
  outcomes: ReadonlyMap<string, CorporateEventOutcome>,
  row: CorporateEventRow,
): CorporateEventOutcome {
  const outcome = outcomes.get(row.id);
  if (outcome === undefined) throw new Error(`no outcome for ${row.id}`);
  return outcome;
}

function written(outcomes: ReadonlyMap<string, CorporateEventOutcome>, row: CorporateEventRow) {
  const outcome = outcomeOf(outcomes, row);
  if (outcome.status === 'refused') throw new Error(`refused: ${outcome.refusal}`);
  return outcome.transaction;
}

function replayed(ledger: readonly Transaction[]) {
  const result = replayPosition(ledger);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const str = (value: Quantity | null | undefined) => value?.toString() ?? null;

describe('#113 BR-005-20b — corporateEventMovementOfKey', () => {
  const parts = {
    assetId: assetIdFor('MGLU3'),
    institutionId: institutionIdFor(BROKER),
    tradeDate: BusinessDate.of('2024-05-28'),
    type: 'rendimento' as const,
    quantity: storedRow('MGLU3', '2024-05-28', '40').quantity,
    unitPrice: storedRow('MGLU3', '2024-05-28', '40').unitPrice,
  };

  it('reads the B3 type off the unmapped key suffix', () => {
    expect(corporateEventMovementOfKey(importNaturalKeyFor(parts, 'Grupamento'))).toBe(
      'grupamento',
    );
    expect(corporateEventMovementOfKey(importNaturalKeyFor(parts, 'Fração em Ativos'))).toBe(
      'fracao_em_ativos',
    );
    expect(corporateEventMovementOfKey(importNaturalKeyFor(parts, 'Leilão de Fração'))).toBe(
      'leilao_de_fracao',
    );
  });

  it('is null for a mapped key, whose last component is a price, and for another B3 type', () => {
    expect(corporateEventMovementOfKey(importNaturalKeyFor(parts, null))).toBeNull();
    expect(corporateEventMovementOfKey(importNaturalKeyFor(parts, 'Atualização'))).toBeNull();
  });
});

describe('#113 BR-005-20b / BR-007-04a — Desdobro and Grupamento in the position walk', () => {
  it('applies a desdobro: 70 + 630 with factor 900 is ratio 10, and the position is 700 at 10,00', () => {
    // Buy 70 @ 100,00 → cost 7.000,00. m = 1 + 900 ÷ 100 = 10; 70 × 9 = 630 = Δ.
    // After ×10: 700 shares, cost 7.000,00, average 7.000 ÷ 700 = 10,00.
    const history = [buy('ALZR11', '2024-01-10', '70', '100')];
    const row = open('desdobro', 'ALZR11', '2024-03-05', '630');
    const outcomes = resolve([row], history, [
      factor('ALZR', 'desdobramento', '900', '2024-03-01'),
    ]);
    const outcome = outcomeOf(outcomes, row);
    expect(outcome).toMatchObject({ status: 'resolved', movement: 'desdobro' });
    if (outcome.status !== 'resolved' || outcome.movement !== 'desdobro') return;
    expect(outcome.transaction).toMatchObject({
      id: row.transaction.id,
      type: 'split',
      status: 'active',
    });
    expect(str(outcome.transaction.ratio)).toBe('10');
    expect(str(outcome.evidence.basis)).toBe('70');
    expect(str(outcome.evidence.derivedRatio)).toBe('10');

    const position = replayed([...history, outcome.transaction]);
    expect(position.quantity.toString()).toBe('700');
    expect(position.totalCost.toString()).toBe('7000');
    expect(position.averageCost.toString()).toBe('10');
  });

  it('applies 80 + 80 with factor 100 as ratio 2: 160 at 15,00', () => {
    // Buy 80 @ 30,00 → 2.400,00. m = 2; 80 × 1 = 80. 160 shares, 2.400 ÷ 160 = 15,00.
    const history = [buy('BBAS3', '2024-04-01', '80', '30')];
    const row = open('desdobro', 'BBAS3', '2024-04-17', '80');
    const outcomes = resolve([row], history, [
      factor('BBAS', 'desdobramento', '100', '2024-04-15'),
    ]);
    const split = written(outcomes, row);
    expect(str(split.ratio)).toBe('2');
    const position = replayed([...history, split]);
    expect(position.quantity.toString()).toBe('160');
    expect(position.averageCost.toString()).toBe('15');
  });

  it('applies a grupamento 220 → 110 with factor 0.5: 110 at 22,00', () => {
    // Buy 220 @ 11,00 → 2.420,00. 220 × 0,5 = 110 = R. 2.420 ÷ 110 = 22,00.
    const history = [buy('SIMH3', '2024-01-02', '220', '11')];
    const row = open('grupamento', 'SIMH3', '2024-08-12', '110');
    const outcomes = resolve([row], history, [factor('SIMH', 'grupamento', '0.5', '2024-08-09')]);
    const grupamento = written(outcomes, row);
    expect(grupamento.type).toBe('grupamento');
    expect(str(grupamento.ratio)).toBe('0.5');
    const position = replayed([...history, grupamento]);
    expect(position.quantity.toString()).toBe('110');
    expect(position.totalCost.toString()).toBe('2420');
    expect(position.averageCost.toString()).toBe('22');
  });

  it('refuses 80 → 40 against factor 0.1 as disagrees, with P, stated, derived and published figures', () => {
    // 80 × 0,1 = 8 ≠ 40. Derived 40 ÷ 80 = 0,5.
    const published = factor('MGLU', 'grupamento', '0.1', '2024-05-24');
    const row = open('grupamento', 'MGLU3', '2024-05-28', '40');
    const outcome = outcomeOf(
      resolve([row], [buy('MGLU3', '2024-01-02', '80', '10')], [published]),
      row,
    );
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'disagrees' });
    if (outcome.status !== 'refused' || outcome.movement !== 'grupamento') return;
    expect(outcome.evidence.issuerCode).toBe('MGLU');
    expect(str(outcome.evidence.basis)).toBe('80');
    expect(str(outcome.evidence.stated)).toBe('40');
    expect(str(outcome.evidence.derivedRatio)).toBe('0.5');
    expect(outcome.evidence.factors).toEqual([published]);
  });

  it('refuses a 3:1 grupamento published as 0.333333333333 as not_representable', () => {
    // Stored at NUMERIC(20,8) the multiplier would be 0,33333333, not B3's figure.
    const row = open('grupamento', 'ABCD3', '2024-05-28', '100');
    const outcome = outcomeOf(
      resolve(
        [row],
        [buy('ABCD3', '2024-01-02', '300', '10')],
        [factor('ABCD', 'grupamento', '0.333333333333', '2024-05-24')],
      ),
      row,
    );
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'not_representable' });
  });

  it('refuses a desdobro and a grupamento on one position and date — both combined_same_day', () => {
    // VIVT3 on 2025-04-16: which applies first is not stated. P = 100 for both.
    const history = [buy('VIVT3', '2025-01-02', '100', '50')];
    const desdobro = open('desdobro', 'VIVT3', '2025-04-16', '237');
    const grupamento = open('grupamento', 'VIVT3', '2025-04-16', '3.75');
    const outcomes = resolve([desdobro, grupamento], history, [
      factor('VIVT', 'desdobramento', '237', '2025-04-15'),
      factor('VIVT', 'grupamento', '0.01', '2025-04-15'),
    ]);
    for (const row of [desdobro, grupamento]) {
      const outcome = outcomeOf(outcomes, row);
      expect(outcome).toMatchObject({ status: 'refused', refusal: 'combined_same_day' });
      if (outcome.movement === 'desdobro' || outcome.movement === 'grupamento') {
        expect(str(outcome.evidence.basis)).toBe('100');
      }
    }
  });

  it('refuses an open ratio row on the date of a ratio event already in the ledger as combined_same_day', () => {
    const history = [
      buy('VIVT3', '2025-01-02', '100', '50'),
      aTransaction().split().of('VIVT3').at(BROKER).on('2025-04-16').ratio('2').build(),
    ];
    const row = open('desdobro', 'VIVT3', '2025-04-16', '100');
    const outcome = outcomeOf(
      resolve([row], history, [factor('VIVT', 'desdobramento', '100', '2025-04-15')]),
      row,
    );
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'combined_same_day' });
  });

  it('refuses no factor, two factors, and a factor 8 days before a 7-day window; accepts one 7 days before', () => {
    const history = [buy('MGLU3', '2024-01-02', '80', '10')];
    const row = open('grupamento', 'MGLU3', '2024-05-28', '8'); // 80 × 0,1 = 8 agrees
    expect(outcomeOf(resolve([row], history), row)).toMatchObject({ refusal: 'no_factor' });
    expect(
      outcomeOf(
        resolve([row], history, [
          factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
          factor('MGLU', 'grupamento', '0.1', '2024-05-27'),
        ]),
        row,
      ),
    ).toMatchObject({ refusal: 'ambiguous_factor' });
    // 28 − 20 = 8 days > 7.
    expect(
      outcomeOf(resolve([row], history, [factor('MGLU', 'grupamento', '0.1', '2024-05-20')]), row),
    ).toMatchObject({ refusal: 'no_factor' });
    // 28 − 21 = 7 days: in.
    expect(
      outcomeOf(resolve([row], history, [factor('MGLU', 'grupamento', '0.1', '2024-05-21')]), row),
    ).toMatchObject({ status: 'resolved' });
  });

  it('refuses a ticker with no issuer, or an issuer with no stored factors, as no_factor', () => {
    const noIssuer = open('grupamento', 'AXIA15G', '2024-05-28', '8');
    const outcome = outcomeOf(
      resolve(
        [noIssuer],
        [buy('AXIA15G', '2024-01-02', '80', '10')],
        [factor('AXIA', 'grupamento', '0.1', '2024-05-24')],
      ),
      noIssuer,
    );
    expect(outcome).toMatchObject({ refusal: 'no_factor' });
    if (outcome.movement === 'grupamento') expect(outcome.evidence.issuerCode).toBeNull();

    const unknown = open('grupamento', 'WXYZ3', '2024-05-28', '8');
    expect(
      outcomeOf(
        resolve(
          [unknown],
          [buy('WXYZ3', '2024-01-02', '80', '10')],
          [factor('MGLU', 'grupamento', '0.1', '2024-05-24')],
        ),
        unknown,
      ),
    ).toMatchObject({ refusal: 'no_factor' });
  });

  it('refuses no basis: P = 0 after a full sale, and a prefix that cannot replay', () => {
    const factors = [factor('MGLU', 'grupamento', '0.1', '2024-05-24')];
    const row = open('grupamento', 'MGLU3', '2024-05-28', '8');
    // 80 bought, 80 sold: P = 0.
    const closed = outcomeOf(
      resolve(
        [row],
        [buy('MGLU3', '2024-01-02', '80', '10'), sell('MGLU3', '2024-02-01', '80', '12')],
        factors,
      ),
      row,
    );
    expect(closed).toMatchObject({ refusal: 'no_basis' });
    if (closed.movement === 'grupamento') expect(str(closed.evidence.basis)).toBe('0');
    // 80 bought, 90 sold: the prefix itself fails.
    const broken = outcomeOf(
      resolve(
        [row],
        [buy('MGLU3', '2024-01-02', '80', '10'), sell('MGLU3', '2024-02-01', '90', '12')],
        factors,
      ),
      row,
    );
    expect(broken).toMatchObject({ refusal: 'no_basis' });
    if (broken.movement === 'grupamento') expect(broken.evidence.basis).toBeNull();
  });

  it('blocks a later ratio event behind an unresolved one, showing no basis', () => {
    // The 2020 desdobro has no factor; the 2024 grupamento would agree on its own
    // (320 × 0,1 = 32), but P = 320 assumes the desdobro applied.
    const history = [buy('MGLU3', '2020-09-01', '80', '20')];
    const desdobro = open('desdobro', 'MGLU3', '2020-10-15', '240');
    const grupamento = open('grupamento', 'MGLU3', '2024-05-28', '32');
    const outcomes = resolve([grupamento, desdobro], history, [
      factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
    ]);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'no_factor' });
    const blocked = outcomeOf(outcomes, grupamento);
    expect(blocked).toMatchObject({ refusal: 'blocked' });
    if (blocked.movement === 'grupamento') {
      expect(blocked.evidence.basis).toBeNull();
      expect(blocked.evidence.factors).toHaveLength(1);
    }
  });

  it('chains a 2020 desdobro into a 2024 grupamento, in either input order', () => {
    // Buy 80 @ 20,00 → 1.600,00.
    // 2020-10-15 desdobro: factor 300 → m = 4; 80 × 3 = 240 = Δ → 320 shares, average 5,00.
    // 2024-05-28 grupamento: P = 320; 320 × 0,1 = 32 = R → 32 shares, average 1.600 ÷ 32 = 50,00.
    const history = [buy('MGLU3', '2020-09-01', '80', '20')];
    const desdobro = open('desdobro', 'MGLU3', '2020-10-15', '240');
    const grupamento = open('grupamento', 'MGLU3', '2024-05-28', '32');
    const factors = [
      factor('MGLU', 'desdobramento', '300', '2020-10-13'),
      factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
    ];
    for (const rows of [
      [desdobro, grupamento],
      [grupamento, desdobro],
    ]) {
      const outcomes = resolve(rows, history, factors);
      const split = written(outcomes, desdobro);
      const grouped = outcomeOf(outcomes, grupamento);
      expect(str(split.ratio)).toBe('4');
      expect(grouped).toMatchObject({ status: 'resolved' });
      if (grouped.status !== 'resolved' || grouped.movement !== 'grupamento') return;
      expect(str(grouped.evidence.basis)).toBe('320');
      expect(str(grouped.transaction.ratio)).toBe('0.1');

      const position = replayed([...history, split, grouped.transaction]);
      expect(position.quantity.toString()).toBe('32');
      expect(position.totalCost.toString()).toBe('1600');
      expect(position.averageCost.toString()).toBe('50');
    }
  });

  it('resolves the grupamento the same way once the desdobro is stored resolved (incremental = from scratch)', () => {
    const history = [buy('MGLU3', '2020-09-01', '80', '20')];
    const desdobro = open('desdobro', 'MGLU3', '2020-10-15', '240');
    const grupamento = open('grupamento', 'MGLU3', '2024-05-28', '32');
    const factors = [
      factor('MGLU', 'desdobramento', '300', '2020-10-13'),
      factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
    ];
    const first = resolve([desdobro, grupamento], history, factors);
    const storedSplit = written(first, desdobro);

    // Next import: the desdobro is active in the ledger, a partner only.
    const second = resolve(
      [settled('desdobro', 'MGLU3', storedSplit), grupamento],
      [...history, storedSplit],
      factors,
    );
    expect(second.has(desdobro.id)).toBe(false);
    const again = written(second, grupamento);
    expect(again).toEqual(written(first, grupamento));
  });

  it('measures P before a same-day buy: the event ranks first (BR-007-15)', () => {
    // 80 @ 20,00 on 2020-09-01 and 10 @ 5,00 on the desdobro's own date. The split
    // applies before the day's buy, so P = 80 (not 90): 80 × 3 = 240 = Δ.
    // Then 320 shares at 1.600,00 plus 10 @ 5,00 → 330 shares, 1.650,00, average 5,00.
    const history = [buy('MGLU3', '2020-09-01', '80', '20'), buy('MGLU3', '2020-10-15', '10', '5')];
    const row = open('desdobro', 'MGLU3', '2020-10-15', '240');
    const outcomes = resolve([row], history, [
      factor('MGLU', 'desdobramento', '300', '2020-10-13'),
    ]);
    const split = written(outcomes, row);
    const position = replayed([...history, split]);
    expect(position.quantity.toString()).toBe('330');
    expect(position.totalCost.toString()).toBe('1650');
    expect(position.averageCost.toString()).toBe('5');
  });

  it('gives no outcome for a position holding only settled rows', () => {
    const split = aTransaction().split().of('MGLU3').at(BROKER).on('2020-10-15').ratio('4').build();
    expect(resolve([settled('desdobro', 'MGLU3', split)], [split]).size).toBe(0);
  });
});

describe('#113 BR-005-20b / BR-007-05a — a bonificação fraction and its auction', () => {
  /**
   * Buy 100 @ 20,00 → 2.000,00. Bonificação of 5,2 at no attributed value
   * (BR-007-05) → 105,2 shares, 2.000,00. Its fractional part 105,2 − 105 = 0,2
   * is the Fração em Ativos of 2025-12-15, sold at auction on 2026-01-20
   * (36 days later) at 12,50.
   */
  function scenario() {
    const bonificacao = bonus('ITSA4', '2025-12-10', '5.2');
    const history = [buy('ITSA4', '2025-11-03', '100', '20'), bonificacao];
    const fraction = open('fracao_em_ativos', 'ITSA4', '2025-12-15', '0.2');
    const auction = open('leilao_de_fracao', 'ITSA4', '2026-01-20', '0.2', '12.50');
    return { bonificacao, history, fraction, auction };
  }

  it('removes the fraction as fracao_bonificacao and books the auction as a 2,50 leilao_fracoes', () => {
    const { bonificacao, history, fraction, auction } = scenario();
    const outcomes = resolve([auction, fraction], history);

    const removal = outcomeOf(outcomes, fraction);
    expect(removal).toMatchObject({ status: 'resolved', movement: 'fracao_em_ativos' });
    if (removal.status !== 'resolved' || removal.movement !== 'fracao_em_ativos') return;
    expect(removal.transaction).toMatchObject({ type: 'fracao_bonificacao', status: 'active' });
    // Decision log row 17: zero total on the removal.
    expect(removal.transaction.totalValue.isZero()).toBe(true);
    expect(removal.evidence.origin).toMatchObject({ id: bonificacao.id, type: 'bonificacao' });
    expect(str(removal.evidence.origin?.quantityAfter)).toBe('105.2');
    expect(str(removal.evidence.origin?.fractionalPart)).toBe('0.2');
    expect(removal.evidence.partnerId).toBe(auction.id);
    expect(removal.evidence.candidates).toEqual([auction.id]);
    expect(removal.evidence.auctionPrice?.toString()).toBe('12.5');

    const income = outcomeOf(outcomes, auction);
    expect(income).toMatchObject({ status: 'resolved', movement: 'leilao_de_fracao' });
    if (income.status !== 'resolved' || income.movement !== 'leilao_de_fracao') return;
    expect(income.transaction.type).toBe('leilao_fracoes');
    // 0,2 × 12,50 = 2,50.
    expect(income.transaction.totalValue.toString()).toBe('2.5');
    expect(income.evidence.partnerId).toBe(fraction.id);
    expect(income.evidence.candidates).toEqual([fraction.id]);

    // 105,2 − 0,2 = 105 shares; total cost 2.000,00 unchanged; nothing realised;
    // average 2.000 ÷ 105 = 19,047619047619… (repeating "047619").
    const position = replayed([...history, removal.transaction, income.transaction]);
    expect(position.quantity.toString()).toBe('105');
    expect(position.totalCost.toString()).toBe('2000');
    expect(position.realizedGain.isZero()).toBe(true);
    expect(asStored(position.averageCost)).toBe('19.04761905');
  });

  it('refuses two bonificações that each leave 0,2 as ambiguous_origin, with both candidates shown', () => {
    // 100 + 5,2 = 105,2 → 0,2; + 1 = 106,2 → 0,2 again, both inside 30 days.
    const { history, fraction, auction } = scenario();
    const outcomes = resolve([fraction, auction], [...history, bonus('ITSA4', '2025-12-12', '1')]);
    const refused = outcomeOf(outcomes, fraction);
    expect(refused).toMatchObject({ status: 'refused', refusal: 'ambiguous_origin' });
    if (refused.movement === 'fracao_em_ativos' && refused.status === 'refused') {
      expect(refused.evidence.origins.map((o) => str(o.fractionalPart))).toEqual(['0.2', '0.2']);
      expect(refused.evidence.origin).toBeNull();
    }
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'ambiguous_origin' });
  });

  it('refuses a fraction no event left: a different quantity, or an event 31 days before', () => {
    const { history, auction } = scenario();
    const other = open('fracao_em_ativos', 'ITSA4', '2025-12-15', '0.3');
    const otherAuction = open('leilao_de_fracao', 'ITSA4', '2026-01-20', '0.3', '12.50');
    expect(outcomeOf(resolve([other, otherAuction], history), other)).toMatchObject({
      refusal: 'no_origin',
    });
    // 2025-11-14 → 2025-12-15 is 16 + 15 = 31 days > 30.
    const early = [buy('ITSA4', '2025-11-03', '100', '20'), bonus('ITSA4', '2025-11-14', '5.2')];
    const fraction = open('fracao_em_ativos', 'ITSA4', '2025-12-15', '0.2');
    const outcomes = resolve([fraction, auction], early);
    const refused = outcomeOf(outcomes, fraction);
    expect(refused).toMatchObject({ refusal: 'no_origin' });
    if (refused.movement === 'fracao_em_ativos') expect(refused.evidence.origins).toEqual([]);
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'no_origin' });
  });

  it('refuses an unpaired fraction and an unpaired auction as no_pair', () => {
    const { history, fraction } = scenario();
    const alone = outcomeOf(resolve([fraction], history), fraction);
    expect(alone).toMatchObject({ status: 'refused', refusal: 'no_pair' });
    if (alone.movement === 'fracao_em_ativos') {
      expect(alone.evidence).toMatchObject({ candidates: [], partnerId: null, auctionPrice: null });
      // The origin is still shown.
      expect(alone.evidence.origin).not.toBeNull();
    }

    const auctionOnly = open('leilao_de_fracao', 'ITSA4', '2026-01-20', '0.2', '12.50');
    const orphan = outcomeOf(resolve([auctionOnly], history), auctionOnly);
    expect(orphan).toMatchObject({ status: 'refused', refusal: 'no_pair' });
    if (orphan.movement === 'leilao_de_fracao') {
      expect(orphan.evidence).toMatchObject({ candidates: [], partnerId: null, origin: null });
      expect(orphan.evidence.auctionPrice?.toString()).toBe('12.5');
    }
  });

  it('refuses two auctions for one fraction as ambiguous_pair on all three rows', () => {
    const { history, fraction, auction } = scenario();
    const second = open('leilao_de_fracao', 'ITSA4', '2026-02-01', '0.2', '12.40');
    const outcomes = resolve([fraction, auction, second], history);
    const refused = outcomeOf(outcomes, fraction);
    expect(refused).toMatchObject({ refusal: 'ambiguous_pair' });
    if (refused.movement === 'fracao_em_ativos') {
      expect(refused.evidence.candidates).toEqual([auction.id, second.id]);
    }
    for (const row of [auction, second]) {
      const each = outcomeOf(outcomes, row);
      expect(each).toMatchObject({ refusal: 'ambiguous_pair' });
      if (each.movement === 'leilao_de_fracao')
        expect(each.evidence.candidates).toEqual([fraction.id]);
    }
  });

  it('does not pair an auction before the fraction, nor one 181 days after it', () => {
    const { history, fraction } = scenario();
    const before = open('leilao_de_fracao', 'ITSA4', '2025-12-14', '0.2', '12.50');
    const early = resolve([fraction, before], history);
    expect(outcomeOf(early, fraction)).toMatchObject({ refusal: 'no_pair' });
    expect(outcomeOf(early, before)).toMatchObject({ refusal: 'no_pair' });
    // 2025-12-15 + 181 days: 16 (Dec) + 31 + 28 + 31 + 30 + 31 + 14 (Jun) = 181 → 2026-06-14.
    const late = open('leilao_de_fracao', 'ITSA4', '2026-06-14', '0.2', '12.50');
    expect(outcomeOf(resolve([fraction, late], history), late)).toMatchObject({
      refusal: 'no_pair',
    });
  });

  it('refuses an auction stating no price as no_price, on both rows', () => {
    const { history, fraction } = scenario();
    const free = open('leilao_de_fracao', 'ITSA4', '2026-01-20', '0.2', '0');
    const outcomes = resolve([fraction, free], history);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'no_price' });
    expect(outcomeOf(outcomes, free)).toMatchObject({ refusal: 'no_price' });
  });

  it('refuses a fraction the position can no longer give up as no_basis', () => {
    // 105,2 held after the bonificação, all 105,2 sold on 2025-12-12: nothing left
    // for the 0,2 removal on 2025-12-15.
    const { history, fraction, auction } = scenario();
    const outcomes = resolve(
      [fraction, auction],
      [...history, sell('ITSA4', '2025-12-12', '105.2', '25')],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'no_basis' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'no_basis' });
  });

  it('refuses when the origin window holds a prefix that cannot replay: origin_unresolved', () => {
    // 100 bought, 200 sold before the bonificação: its "after" cannot be computed.
    const { bonificacao, fraction, auction } = scenario();
    const broken = [
      buy('ITSA4', '2025-11-03', '100', '20'),
      sell('ITSA4', '2025-11-20', '200', '20'),
      bonificacao,
    ];
    const outcomes = resolve([fraction, auction], broken);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'origin_unresolved' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'origin_unresolved' });
  });

  it('pairs with a hand-classified leilao_fracoes, leaving it untouched', () => {
    const { history, fraction, auction } = scenario();
    const classified: Transaction = {
      ...auction.transaction,
      type: 'leilao_fracoes',
      status: 'active',
    };
    const outcomes = resolve(
      [fraction, settled('leilao_de_fracao', 'ITSA4', classified)],
      [...history, classified],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ status: 'resolved' });
    expect(outcomes.has(auction.id)).toBe(false);
  });

  it('refuses the fraction when its hand-classified auction contradicts the origin: partner_conflict', () => {
    const { history, fraction, auction } = scenario();
    const asDividend: Transaction = { ...auction.transaction, type: 'dividend', status: 'active' };
    const outcomes = resolve(
      [fraction, settled('leilao_de_fracao', 'ITSA4', asDividend)],
      [...history, asDividend],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'partner_conflict' });
    expect(outcomes.size).toBe(1);
  });

  it('refuses both fractions when two claim one bonificação, even when each pairs uniquely', () => {
    // F1 0,2 on 2025-12-15 ↔ A1 same day. F2 0,2 on 2026-01-05 ↔ A2 on 2026-06-20:
    // A2 is 166 days after F2 but 187 after F1; A1 is before F2. Both fractions
    // measure 105,2 → 0,2 at the one bonificação (5 and 26 days before), so one
    // event would have left two fractions: neither is applied.
    const { history } = scenario();
    const f1 = open('fracao_em_ativos', 'ITSA4', '2025-12-15', '0.2');
    const a1 = open('leilao_de_fracao', 'ITSA4', '2025-12-15', '0.2', '12.50');
    const f2 = open('fracao_em_ativos', 'ITSA4', '2026-01-05', '0.2');
    const a2 = open('leilao_de_fracao', 'ITSA4', '2026-06-20', '0.2', '12.50');
    const outcomes = resolve([f1, a1, f2, a2], history);
    for (const row of [f1, a1, f2, a2]) {
      expect(outcomeOf(outcomes, row)).toMatchObject({
        status: 'refused',
        refusal: 'ambiguous_origin',
      });
    }
  });
});

describe('#113 BR-005-20b / BR-007-04b — a grupamento fraction sold at auction', () => {
  /**
   * Buy 105 @ 10,00 → 1.050,00. Grupamento ×0,1 on 2024-05-28 (factor 0.1,
   * data com 2024-05-24): 105 × 0,1 = 10,5 = R → 10,5 shares, 1.050,00, average
   * 100,00. Fractional part 0,5 → Fração em Ativos 0,5 on 2024-05-30, auction
   * 0,5 @ 98,00 on 2024-06-10.
   */
  function scenario(fractionDate = '2024-05-30') {
    const history = [buy('GRND3', '2024-05-01', '105', '10')];
    const grupamento = open('grupamento', 'GRND3', '2024-05-28', '10.5');
    const fraction = open('fracao_em_ativos', 'GRND3', fractionDate, '0.5');
    const auction = open('leilao_de_fracao', 'GRND3', '2024-06-10', '0.5', '98');
    const factors = [factor('GRND', 'grupamento', '0.1', '2024-05-24')];
    return { history, grupamento, fraction, auction, factors };
  }

  it('sells the fraction at the auction price on its own date, realising −1,00, and consumes the auction', () => {
    const { history, grupamento, fraction, auction, factors } = scenario();
    const outcomes = resolve([auction, fraction, grupamento], history, factors);
    const grouped = written(outcomes, grupamento);
    const sale = outcomeOf(outcomes, fraction);
    expect(sale).toMatchObject({ status: 'resolved' });
    if (sale.status !== 'resolved' || sale.movement !== 'fracao_em_ativos') return;
    expect(sale.transaction).toMatchObject({ type: 'sell', status: 'active' });
    expect(sale.transaction.tradeDate).toBe('2024-05-30');
    expect(sale.transaction.unitPrice.toString()).toBe('98');
    expect(sale.evidence.origin).toMatchObject({
      id: grupamento.transaction.id,
      type: 'grupamento',
    });
    expect(str(sale.evidence.origin?.quantityAfter)).toBe('10.5');

    const consumed = outcomeOf(outcomes, auction);
    expect(consumed).toMatchObject({ status: 'consumed' });
    if (consumed.status !== 'consumed') return;
    expect(consumed.transaction).toMatchObject({
      id: auction.transaction.id,
      status: 'superseded',
    });

    // Sale: proceeds 0,5 × 98,00 = 49,00; cost out 0,5 × 100,00 = 50,00;
    // realised 49,00 − 50,00 = −1,00. Remaining 10 shares, 1.000,00, average 100,00.
    // The superseded auction enters no replay.
    const position = replayed([...history, grouped, sale.transaction, consumed.transaction]);
    expect(position.quantity.toString()).toBe('10');
    expect(position.totalCost.toString()).toBe('1000');
    expect(position.averageCost.toString()).toBe('100');
    expect(position.realizedGain.toString()).toBe('-1');
  });

  it('resolves a fraction dated the same day as its grupamento: the event is walked first', () => {
    const { history, grupamento, fraction, auction, factors } = scenario('2024-05-28');
    const outcomes = resolve([fraction, auction, grupamento], history, factors);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ status: 'resolved' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ status: 'consumed' });
  });

  it('refuses the fraction as origin_unresolved when the grupamento itself is unresolved', () => {
    const { history, grupamento, fraction, auction } = scenario();
    const outcomes = resolve([grupamento, fraction, auction], history);
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'no_factor' });
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'origin_unresolved' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'origin_unresolved' });
  });

  it('consumes the auction when the fraction was already stored as a sell', () => {
    const { history, grupamento, fraction, auction, factors } = scenario();
    const first = resolve([grupamento, fraction, auction], history, factors);
    const storedGrupamento = written(first, grupamento);
    const storedSale = written(first, fraction);
    const outcomes = resolve(
      [
        settled('grupamento', 'GRND3', storedGrupamento),
        settled('fracao_em_ativos', 'GRND3', storedSale),
        auction,
      ],
      [...history, storedGrupamento, storedSale],
      factors,
    );
    expect(outcomes.size).toBe(1);
    expect(outcomeOf(outcomes, auction)).toMatchObject({ status: 'consumed' });
  });

  it('refuses the open side of a pair a settled partner contradicts', () => {
    const { history, grupamento, fraction, auction, factors } = scenario();
    const storedGrupamento = written(resolve([grupamento], history, factors), grupamento);
    const ledger = [...history, storedGrupamento];

    // A split fraction booked by hand as a bonificação removal: the auction cannot be consumed.
    const asBonusRemoval: Transaction = {
      ...fraction.transaction,
      type: 'fracao_bonificacao',
      status: 'active',
    };
    expect(
      outcomeOf(
        resolve(
          [settled('fracao_em_ativos', 'GRND3', asBonusRemoval), auction],
          [...ledger, asBonusRemoval],
          factors,
        ),
        auction,
      ),
    ).toMatchObject({ refusal: 'partner_conflict' });

    // The auction booked by hand as income: selling the fraction too would count its cash twice.
    const asIncome: Transaction = {
      ...auction.transaction,
      type: 'leilao_fracoes',
      status: 'active',
    };
    expect(
      outcomeOf(
        resolve(
          [fraction, settled('leilao_de_fracao', 'GRND3', asIncome)],
          [...ledger, asIncome],
          factors,
        ),
        fraction,
      ),
    ).toMatchObject({ refusal: 'partner_conflict' });
  });

  it('refuses an open auction whose settled fraction has no origin, with that reason', () => {
    // The fraction was classified by hand, but no event left 0,5 on the position.
    const history = [buy('GRND3', '2024-05-01', '10.5', '100')];
    const handSale: Transaction = {
      ...storedRow('GRND3', '2024-05-30', '0.5', '98'),
      type: 'sell',
      status: 'active',
    };
    const auction = open('leilao_de_fracao', 'GRND3', '2024-06-10', '0.5', '98');
    const outcomes = resolve(
      [settled('fracao_em_ativos', 'GRND3', handSale), auction],
      [...history, handSale],
    );
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'no_origin' });
  });

  it('lets a resolved fraction sale feed P for a later desdobro, and an unresolved one make it disagree', () => {
    // After the sale: 10 shares. 2025-03-10 desdobro Δ = 10, factor 100 → m = 2;
    // 10 × (2 − 1) = 10 = Δ → applied. 20 shares, 1.000,00, average 50,00, realised −1,00.
    const { history, grupamento, fraction, auction, factors } = scenario();
    const desdobro = open('desdobro', 'GRND3', '2025-03-10', '10');
    const allFactors = [...factors, factor('GRND', 'desdobramento', '100', '2025-03-07')];
    const outcomes = resolve([desdobro, auction, fraction, grupamento], history, allFactors);
    const split = written(outcomes, desdobro);
    expect(str(split.ratio)).toBe('2');
    const position = replayed([
      ...history,
      written(outcomes, grupamento),
      written(outcomes, fraction),
      split,
    ]);
    expect(position.quantity.toString()).toBe('20');
    expect(position.totalCost.toString()).toBe('1000');
    expect(position.averageCost.toString()).toBe('50');
    expect(position.realizedGain.toString()).toBe('-1');

    // Without the auction the fraction stays: P = 10,5; 10,5 × 1 = 10,5 ≠ 10.
    // Derived (10,5 + 10) ÷ 10,5 = 1,952380952… → 1,95238095 at eight places.
    const unpaired = resolve([desdobro, fraction, grupamento], history, allFactors);
    expect(outcomeOf(unpaired, fraction)).toMatchObject({ refusal: 'no_pair' });
    const disagrees = outcomeOf(unpaired, desdobro);
    expect(disagrees).toMatchObject({ refusal: 'disagrees' });
    if (disagrees.movement === 'desdobro') {
      expect(str(disagrees.evidence.basis)).toBe('10.5');
      expect(asStored(disagrees.evidence.derivedRatio as Quantity)).toBe('1.95238095');
    }
  });

  it('is independent of input order: every permutation of the four rows gives the same outcomes', () => {
    const { history, grupamento, fraction, auction, factors } = scenario();
    const desdobro = open('desdobro', 'GRND3', '2025-03-10', '10');
    const allFactors = [...factors, factor('GRND', 'desdobramento', '100', '2025-03-07')];
    const summary = (outcomes: ReadonlyMap<string, CorporateEventOutcome>) =>
      [...outcomes.entries()]
        .map(([id, o]) =>
          o.status === 'refused'
            ? `${id}:refused:${o.refusal}`
            : `${id}:${o.status}:${o.transaction.type}:${o.transaction.status}:${str(o.transaction.ratio)}:${o.transaction.unitPrice.toString()}`,
        )
        .sort();
    const rows = [grupamento, fraction, auction, desdobro];
    const expected = summary(resolve(rows, history, allFactors));
    const permutations = (items: readonly CorporateEventRow[]): CorporateEventRow[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const all = permutations(rows);
    expect(all).toHaveLength(24);
    for (const order of all) expect(summary(resolve(order, history, allFactors))).toEqual(expected);
  });
});
