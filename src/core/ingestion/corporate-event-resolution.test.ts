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
  declined?: ReadonlySet<string>,
  windows: CorporateEventWindows = WINDOWS,
) {
  const byIssuer = new Map<string, CorporateEventFactor[]>();
  for (const f of factors) byIssuer.set(f.issuerCode, [...(byIssuer.get(f.issuerCode) ?? []), f]);
  return resolveCorporateEvents({
    rows,
    history: (key) => ledger.filter((t) => positionKeyString(t) === positionKeyString(key)),
    factors: byIssuer,
    windows,
    declined,
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

  it('refuses a desdobro and a grupamento on one position and date that fit no order — both disagrees', () => {
    // #139: P = 100, m = 3,37 and 0,01. Desdobro first: 100 × 2,37 = 237 = Δ,
    // then 337 × 0,01 = 3,37 ≠ 3,75. Grupamento first: 100 × 0,01 = 1 ≠ 3,75.
    // No sequence; the pair refuses whole, P shown on both.
    const history = [buy('VIVT3', '2025-01-02', '100', '50')];
    const desdobro = open('desdobro', 'VIVT3', '2025-04-16', '237');
    const grupamento = open('grupamento', 'VIVT3', '2025-04-16', '3.75');
    const outcomes = resolve([desdobro, grupamento], history, [
      factor('VIVT', 'desdobramento', '237', '2025-04-15'),
      factor('VIVT', 'grupamento', '0.01', '2025-04-15'),
    ]);
    for (const row of [desdobro, grupamento]) {
      const outcome = outcomeOf(outcomes, row);
      expect(outcome).toMatchObject({ status: 'refused', refusal: 'disagrees' });
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

  it('refuses a declined ratio row as conflicts_with_ledger, and blocks what follows it', () => {
    // Both would agree (80 × 3 = 240; 320 × 0,1 = 32), but commit gave the desdobro up.
    const history = [buy('MGLU3', '2020-09-01', '80', '20')];
    const desdobro = open('desdobro', 'MGLU3', '2020-10-15', '240');
    const grupamento = open('grupamento', 'MGLU3', '2024-05-28', '32');
    const outcomes = resolve(
      [desdobro, grupamento],
      history,
      [
        factor('MGLU', 'desdobramento', '300', '2020-10-13'),
        factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
      ],
      new Set([desdobro.id]),
    );
    const declined = outcomeOf(outcomes, desdobro);
    expect(declined).toMatchObject({ refusal: 'conflicts_with_ledger' });
    if (declined.movement === 'desdobro') expect(str(declined.evidence.basis)).toBe('80');
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'blocked' });
  });

  it('treats a ratio row unclassified in the ledger, outside this import, as unresolved', () => {
    const history = [buy('MGLU3', '2020-09-01', '80', '20')];
    const factors = [
      factor('MGLU', 'desdobramento', '300', '2020-10-13'),
      factor('MGLU', 'grupamento', '0.1', '2024-05-24'),
    ];
    const elsewhere = settled('desdobro', 'MGLU3', storedRow('MGLU3', '2020-10-15', '240'));
    // Later: blocked. It gets no outcome itself — it is not this call's to resolve.
    const later = open('grupamento', 'MGLU3', '2024-05-28', '32');
    const outcomes = resolve([elsewhere, later], history, factors);
    expect(outcomes.has(elsewhere.id)).toBe(false);
    expect(outcomeOf(outcomes, later)).toMatchObject({ refusal: 'blocked' });
    // Same day: combined.
    const sameDay = open('grupamento', 'MGLU3', '2020-10-15', '32');
    expect(outcomeOf(resolve([elsewhere, sameDay], history, factors), sameDay)).toMatchObject({
      refusal: 'combined_same_day',
    });
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

  it('accepts an origin exactly 45 calendar days before the fraction and refuses one 46 days before', () => {
    // SPEC-005 BR-005-20b (#113 decision 35): the configured origin window is
    // inclusive. 2025-01-01 → 2025-02-15 is 45 days; → 2025-02-16 is 46.
    const history = [
      buy('BOUND3', '2024-12-01', '100', '10'),
      bonus('BOUND3', '2025-01-01', '5.2'),
    ];
    const auction = open('leilao_de_fracao', 'BOUND3', '2025-03-01', '0.2', '11');
    const atBoundary = open('fracao_em_ativos', 'BOUND3', '2025-02-15', '0.2');
    expect(
      outcomeOf(
        resolve([atBoundary, auction], history, [], undefined, {
          factorDays: 7,
          originDays: 45,
          auctionDays: 180,
        }),
        atBoundary,
      ),
    ).toMatchObject({ status: 'resolved' });

    const outside = open('fracao_em_ativos', 'BOUND3', '2025-02-16', '0.2');
    const outsideAuction = open('leilao_de_fracao', 'BOUND3', '2025-03-01', '0.2', '11');
    expect(
      outcomeOf(
        resolve([outside, outsideAuction], history, [], undefined, {
          factorDays: 7,
          originDays: 45,
          auctionDays: 180,
        }),
        outside,
      ),
    ).toMatchObject({ status: 'refused', refusal: 'no_origin' });
  });

  it('resolves the three ALUP11 yearly chains at 45 days; a 30-day window misses the first two and changes replay so the third also has no origin', () => {
    // Hand calculation (TS-04/TS-05): 130 + 5,2 − 0,2 + 5,4 − 0,4
    // + 5,6 − 0,6 = 145. With 30 days the 37- and 38-day removals do not
    // apply, so the 2025 bonus sees 140,6 + 5,6 = 146,2; its fractional part
    // is then 0,2 rather than the stated 0,6, blocking the third chain too.
    const history = [
      buy('ALUP11', '2023-01-02', '130', '10'),
      bonus('ALUP11', '2023-04-19', '5.2'),
      bonus('ALUP11', '2024-04-23', '5.4'),
      bonus('ALUP11', '2025-04-22', '5.6'),
    ];
    const fractions = [
      open('fracao_em_ativos', 'ALUP11', '2023-05-26', '0.2'),
      open('fracao_em_ativos', 'ALUP11', '2024-05-31', '0.4'),
      open('fracao_em_ativos', 'ALUP11', '2025-05-21', '0.6'),
    ];
    const auctions = [
      open('leilao_de_fracao', 'ALUP11', '2023-06-15', '0.2', '10'),
      open('leilao_de_fracao', 'ALUP11', '2024-06-20', '0.4', '10'),
      open('leilao_de_fracao', 'ALUP11', '2025-06-20', '0.6', '10'),
    ];
    const rows = [...fractions, ...auctions];
    const underThirty = resolve(rows, history, [], undefined, {
      factorDays: 7,
      originDays: 30,
      auctionDays: 180,
    });
    expect(fractions.map((row) => outcomeOf(underThirty, row))).toEqual([
      expect.objectContaining({ status: 'refused', refusal: 'no_origin' }),
      expect.objectContaining({ status: 'refused', refusal: 'no_origin' }),
      expect.objectContaining({ status: 'refused', refusal: 'no_origin' }),
    ]);

    const atFortyFive = resolve(rows, history, [], undefined, {
      factorDays: 7,
      originDays: 45,
      auctionDays: 180,
    });
    const removals = fractions.map((row) => written(atFortyFive, row));
    const incomes = auctions.map((row) => written(atFortyFive, row));
    expect(removals.map((transaction) => transaction.type)).toEqual([
      'fracao_bonificacao',
      'fracao_bonificacao',
      'fracao_bonificacao',
    ]);
    expect(incomes.map((transaction) => transaction.type)).toEqual([
      'leilao_fracoes',
      'leilao_fracoes',
      'leilao_fracoes',
    ]);
    expect(replayed([...history, ...removals, ...incomes]).quantity.toString()).toBe('145');
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

  it('leaves settled fractions alone — unpaired, or paired with a settled auction — beside an open row', () => {
    const { history, fraction, auction } = scenario();
    const removal: Transaction = {
      ...fraction.transaction,
      type: 'fracao_bonificacao',
      status: 'active',
    };
    const income: Transaction = {
      ...auction.transaction,
      type: 'leilao_fracoes',
      status: 'active',
    };
    const openAuction = open('leilao_de_fracao', 'ITSA4', '2026-03-02', '0.7', '12.50');
    const ledger = [...history, removal, income];
    // Unpaired settled fraction: only the unrelated open auction gets an outcome.
    const unpaired = resolve(
      [settled('fracao_em_ativos', 'ITSA4', removal), openAuction],
      [...history, removal],
    );
    expect([...unpaired.keys()]).toEqual([openAuction.id]);
    // Settled pair: nothing about either changes.
    const pair = resolve(
      [
        settled('fracao_em_ativos', 'ITSA4', removal),
        settled('leilao_de_fracao', 'ITSA4', income),
        openAuction,
      ],
      ledger,
    );
    expect([...pair.keys()]).toEqual([openAuction.id]);
  });

  it('refuses a declined fraction and its auction as conflicts_with_ledger', () => {
    const { history, fraction, auction } = scenario();
    const outcomes = resolve([fraction, auction], history, [], new Set([fraction.id]));
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'conflicts_with_ledger' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'conflicts_with_ledger' });
  });

  it('refuses the open side of a pair whose partner is unclassified outside this import: partner_unresolved', () => {
    const { history, fraction, auction } = scenario();
    const outcomes = resolve(
      [fraction, settled('leilao_de_fracao', 'ITSA4', auction.transaction)],
      history,
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'partner_unresolved' });
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

/**
 * SPEC-005 BR-005-20b (#129 D1) — **a fraction on a conversion target.**
 *
 * KLBN3 and KLBN4 own no share-base event: their only prior row is a
 * `conversion_in`, so every candidate list was empty and both fractions
 * refused `no_origin` for good. The origin is reached one asset upstream,
 * through the group's outgoing leg, and only where the trail is exact.
 *
 * Hand-computed (DV-17): KLBN11 holds 100 and a bonificação of 6,6 takes it to
 * **106,6**, leaving 0,6 — precisely what the group moved out. KLBN4 receives
 * 2 and 0,4 on one date, so the group leaves it **2,4**, whose fractional part
 * is the 0,4 B3 auctioned.
 */
describe('#129 BR-005-20b — a fraction whose origin is one asset upstream', () => {
  const GROUP = '00000000-c0de-7000-8000-00000000abcd';

  const klbn11 = [
    buy('KLBN11', '2023-01-02', '100', '10.66'),
    bonus('KLBN11', '2025-12-19', '6.6'),
    aTransaction()
      .conversionOut(GROUP, '6')
      .of('KLBN11')
      .at(BROKER)
      .on('2025-12-23')
      .quantity('0.6')
      .build(),
  ];
  const into = (ticker: string, quantity: string, costBasis: string) =>
    aTransaction()
      .conversionIn(costBasis, GROUP)
      .of(ticker)
      .at(BROKER)
      .on('2025-12-23')
      .quantity(quantity)
      .build();

  /** The group's legs, as commit supplies them: both sides, one lookup. */
  const legs = [...klbn11.slice(2), into('KLBN3', '0.6', '1.2')];

  function resolveTraced(
    rows: readonly CorporateEventRow[],
    ledger: readonly Transaction[],
    groupLegs: readonly Transaction[] = legs,
    windows: CorporateEventWindows = { factorDays: 7, originDays: 60, auctionDays: 180 },
  ) {
    return resolveCorporateEvents({
      rows,
      history: (key) => ledger.filter((t) => positionKeyString(t) === positionKeyString(key)),
      factors: new Map(),
      windows,
      conversionLegs: (groupId) => (groupId === GROUP ? groupLegs : []),
    });
  }

  it("takes a target fraction's origin from the bonificação behind the group's outgoing leg", () => {
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolveTraced([fraction, auction], [...klbn11, into('KLBN3', '0.6', '1.2')]);

    // A bonificação origin, so the fraction leaves at unchanged total cost and
    // its auction is a provento: 0,6 × 3,942 = 2,3652 (SPEC-014 BR-014-01).
    expect(written(outcomes, fraction)).toMatchObject({
      type: 'fracao_bonificacao',
      status: 'active',
    });
    const paid = written(outcomes, auction);
    expect(paid.type).toBe('leilao_fracoes');
    expect(paid.totalValue.toString()).toBe('2.3652');
    // The trail is recorded, not just its conclusion.
    const outcome = outcomeOf(outcomes, fraction);
    const traced =
      outcome.movement === 'fracao_em_ativos' ? outcome.evidence.origin?.tracedFrom : undefined;
    expect(traced?.event.type).toBe('bonificacao');
    expect(traced?.event.tradeDate).toBe('2025-12-19');
  });

  it('reads the group as one arrival, so repeated same-day credits leave one fraction', () => {
    // Taken singly the two legs' replay order is a UUID tiebreak, and one
    // ordering leaves 0,4 twice — `ambiguous_origin` by coin flip.
    const fraction = open('fracao_em_ativos', 'KLBN4', '2026-01-22', '0.4');
    const auction = open('leilao_de_fracao', 'KLBN4', '2026-02-24', '0.4', '3.943');
    const credits = [into('KLBN4', '2', '4'), into('KLBN4', '0.4', '0.8')];
    for (const order of [credits, [...credits].reverse()]) {
      const outcomes = resolveTraced(
        [fraction, auction],
        [...klbn11, ...order],
        [...klbn11.slice(2), ...credits],
      );
      expect(written(outcomes, fraction)).toMatchObject({ type: 'fracao_bonificacao' });
      expect(written(outcomes, auction).totalValue.toString()).toBe('1.5772');
    }
  });

  it('refuses when the outgoing quantity is not a fraction the source event left', () => {
    // A whole position converted: 100,6 out, and nothing leaves 100,6.
    const wholeOut = aTransaction()
      .conversionOut(GROUP, '1066')
      .of('KLBN11')
      .at(BROKER)
      .on('2025-12-23')
      .quantity('106.6')
      .build();
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolveTraced(
      [fraction, auction],
      [...klbn11.slice(0, 2), wholeOut, into('KLBN3', '0.6', '1.2')],
      [wholeOut, into('KLBN3', '0.6', '1.2')],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
  });

  it('measures the origin window from the source event, not from the conversion', () => {
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const ledger = [...klbn11, into('KLBN3', '0.6', '1.2')];
    // 2025-12-19 → 2026-01-22 is 34 days; 2025-12-23 → 2026-01-22 is 30.
    // A 32-day window therefore reaches the conversion but not the bonificação.
    const outcomes = resolveTraced([fraction, auction], ledger, legs, {
      factorDays: 7,
      originDays: 32,
      auctionDays: 180,
    });
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
  });

  it('refuses while a ratio event on the source is still unresolved in this batch', () => {
    // #129 review — the guard that was dead on a first import. KLBN11 holds a
    // bonificação leaving 0,6 *and* a grupamento whose ratio has not settled.
    // Either could be the real origin, and they disagree on the answer: a
    // bonificação makes the auction exempt income, a grupamento makes the
    // fraction a realised sale. A staged ratio row is `unclassified`, so it is
    // in no history until it commits — it must be seen through `rows`.
    const grupamento = storedRow('KLBN11', '2026-01-10', '100');
    const pending: CorporateEventRow = {
      id: grupamento.id,
      movement: 'grupamento',
      ticker: 'KLBN11',
      transaction: grupamento,
      open: true,
    };
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const ledger = [...klbn11, into('KLBN3', '0.6', '1.2')];

    const outcomes = resolveCorporateEvents({
      rows: [pending, fraction, auction],
      history: (key) => ledger.filter((t) => positionKeyString(t) === positionKeyString(key)),
      factors: new Map(),
      windows: { factorDays: 7, originDays: 60, auctionDays: 180 },
      conversionLegs: (groupId) => (groupId === GROUP ? legs : []),
    });

    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'origin_unresolved',
    });
    expect(outcomeOf(outcomes, auction)).toMatchObject({
      status: 'refused',
      refusal: 'origin_unresolved',
    });
  });

  it('refuses while a ratio event on the source sits unclassified in the ledger', () => {
    // An earlier import left it `unclassified` under the unmapped key, which
    // is where a stored corporate row keeps its B3 type.
    const base = storedRow('KLBN11', '2026-01-10', '100');
    const stale: Transaction = {
      ...base,
      naturalKey: importNaturalKeyFor(
        {
          assetId: base.assetId,
          institutionId: base.institutionId,
          tradeDate: base.tradeDate,
          type: 'rendimento',
          quantity: base.quantity,
          unitPrice: base.unitPrice,
        },
        'Grupamento',
      ),
    };
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolveTraced(
      [fraction, auction],
      [...klbn11, stale, into('KLBN3', '0.6', '1.2')],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'origin_unresolved',
    });
  });

  it('traces nothing without the group lookup, which is how the defect read', () => {
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolve([fraction, auction], [...klbn11, into('KLBN3', '0.6', '1.2')]);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
    expect(outcomeOf(outcomes, auction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
  });

  it('is ambiguous when the position has its own event leaving the same fraction', () => {
    // KLBN3 receives 0,6 through the group and its own bonificação of 1 takes
    // it to 1,6 — the same 0,6. Two readings, neither preferred.
    const credit = into('KLBN3', '0.6', '1.2');
    const own = bonus('KLBN3', '2026-01-05', '1');
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolveTraced([fraction, auction], [...klbn11, credit, own]);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'ambiguous_origin',
    });
  });

  it('ignores a conversion that arrives after the fraction', () => {
    const late = aTransaction()
      .conversionIn('1.2', GROUP)
      .of('KLBN3')
      .at(BROKER)
      .on('2026-02-01')
      .quantity('0.6')
      .build();
    const fraction = open('fracao_em_ativos', 'KLBN3', '2026-01-22', '0.6');
    const auction = open('leilao_de_fracao', 'KLBN3', '2026-02-24', '0.6', '3.942');
    const outcomes = resolveTraced([fraction, auction], [...klbn11, late]);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
  });
});

/**
 * SPEC-005 BR-005-20b (#143) — **a fraction the conversion itself created.**
 *
 * Generated shape of the BPFF11/HGFF11 → RVBI11 incorporation (DV-24): SRCA11
 * 90 whole and SRCB11 70 whole convert into 83,89 + 75,36 = **159,25** TGT11 on
 * 2025-10-06 at 15.925,00 (average 100,00). B3 removes the 0,25 on 2025-10-20
 * and auctions it on 2025-11-06 at 59,43. No share-base event anywhere left
 * that 0,25; the group's own ratio did, so the group is the origin, read as a
 * split's is (BR-007-04b): a `sell` of 0,25 at 59,43 on the fraction's date,
 * the auction consumed. Replayed: proceeds 14,8575, cost out 0,25 × 100,00 =
 * 25,00, **realised −10,1425**, 159 left at 15.900,00.
 */
describe('#143 BR-005-20b — a fraction whose origin is the conversion itself', () => {
  const GROUP = '00000000-c0de-7000-8000-00000000f143';
  const sources = [
    buy('SRCA11', '2024-03-01', '90', '100'),
    buy('SRCB11', '2024-03-01', '70', '97.5'),
    aTransaction()
      .conversionOut(GROUP, '9000')
      .of('SRCA11')
      .at(BROKER)
      .on('2025-10-14')
      .quantity('90')
      .price('2.239')
      .build(),
    aTransaction()
      .conversionOut(GROUP, '6825')
      .of('SRCB11')
      .at(BROKER)
      .on('2025-10-14')
      .quantity('70')
      .price('1.983')
      .build(),
  ];
  const into = (quantity: string, costBasis: string, date = '2025-10-06') =>
    aTransaction()
      .conversionIn(costBasis, GROUP)
      .of('TGT11')
      .at(BROKER)
      .on(date)
      .quantity(quantity)
      .build();
  // 9.000,00 + 6.825,00 − (201,51 + 138,81) = 15.484,68 — any split conserves;
  // the test reads quantities, and the replay below reads its own figures.
  const credits = [into('83.89', '8157.06'), into('75.36', '7327.62')];

  function resolveGroup(
    rows: readonly CorporateEventRow[],
    ledger: readonly Transaction[],
    groupLegs: readonly Transaction[],
    originDays = 60,
  ) {
    return resolveCorporateEvents({
      rows,
      history: (key) => ledger.filter((t) => positionKeyString(t) === positionKeyString(key)),
      factors: new Map(),
      windows: { factorDays: 7, originDays, auctionDays: 180 },
      conversionLegs: (groupId) => (groupId === GROUP ? groupLegs : []),
    });
  }

  it('sells the fraction at the auction price and consumes the auction', () => {
    const fraction = open('fracao_em_ativos', 'TGT11', '2025-10-20', '0.25');
    const auction = open('leilao_de_fracao', 'TGT11', '2025-11-06', '0.25', '59.43');
    const ledger = [...sources, ...credits];
    const outcomes = resolveGroup([fraction, auction], ledger, [...sources.slice(2), ...credits]);

    const sale = written(outcomes, fraction);
    expect(sale).toMatchObject({ type: 'sell', status: 'active', tradeDate: '2025-10-20' });
    expect(sale.unitPrice.toString()).toBe('59.43');
    // 0,25 × 59,43 = 14,8575.
    expect(sale.totalValue.toString()).toBe('14.8575');
    expect(outcomeOf(outcomes, auction)).toMatchObject({
      status: 'consumed',
      transaction: { status: 'superseded' },
    });
    const outcome = outcomeOf(outcomes, fraction);
    expect(outcome.movement === 'fracao_em_ativos' && outcome.evidence.origin).toMatchObject({
      id: GROUP,
      type: 'conversion',
      tradeDate: '2025-10-06',
      tracedFrom: null,
    });

    // With a 15.925,00 arrival (average 100,00), as in the chain's own figures:
    const target = replayed([into('83.89', '8389'), into('75.36', '7536'), sale]);
    expect(target.quantity.toString()).toBe('159');
    expect(target.totalCost.toString()).toBe('15900');
    expect(target.realizedGain.toString()).toBe('-10.1425');
  });

  it('measures the origin window from the conversion', () => {
    // 2025-10-06 → 2025-10-20 is 14 days: a 13-day window misses it.
    const fraction = open('fracao_em_ativos', 'TGT11', '2025-10-20', '0.25');
    const auction = open('leilao_de_fracao', 'TGT11', '2025-11-06', '0.25', '59.43');
    const outcomes = resolveGroup(
      [fraction, auction],
      [...sources, ...credits],
      [...sources.slice(2), ...credits],
      13,
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'no_origin',
    });
  });

  it('refuses origin_unresolved while a ratio event on a source is pending', () => {
    // The trail cannot be read, which outranks the conversion reading.
    const grupamento = storedRow('SRCA11', '2025-10-01', '9');
    const pending: CorporateEventRow = {
      id: grupamento.id,
      movement: 'grupamento',
      ticker: 'SRCA11',
      transaction: grupamento,
      open: true,
    };
    const fraction = open('fracao_em_ativos', 'TGT11', '2025-10-20', '0.25');
    const auction = open('leilao_de_fracao', 'TGT11', '2025-11-06', '0.25', '59.43');
    const outcomes = resolveGroup(
      [pending, fraction, auction],
      [...sources, ...credits],
      [...sources.slice(2), ...credits],
    );
    expect(outcomeOf(outcomes, fraction)).toMatchObject({
      status: 'refused',
      refusal: 'origin_unresolved',
    });
  });

  it('leaves a whole-quantity rename out, so a target bonificação keeps its one origin', () => {
    // 180 SRCA11 → 180 TGT11 (no fraction created), then TGT11's own
    // bonificação of 2,4 → 182,4 leaves the 0,4 B3 auctions: a bonificação
    // fraction, not `ambiguous_origin`.
    const rename = [
      buy('SRCA11', '2024-03-01', '180', '10'),
      aTransaction()
        .conversionOut(GROUP, '1800')
        .of('SRCA11')
        .at(BROKER)
        .on('2025-10-06')
        .quantity('180')
        .build(),
    ];
    const arrival = into('180', '1800');
    const own = bonus('TGT11', '2025-10-10', '2.4');
    const fraction = open('fracao_em_ativos', 'TGT11', '2025-10-20', '0.4');
    const auction = open('leilao_de_fracao', 'TGT11', '2025-11-06', '0.4', '12.5');
    const outcomes = resolveGroup(
      [fraction, auction],
      [...rename, arrival, own],
      [rename[1]!, arrival],
    );
    expect(written(outcomes, fraction)).toMatchObject({ type: 'fracao_bonificacao' });
    // 0,4 × 12,50 = 5,00, a provento.
    expect(written(outcomes, auction).totalValue.toString()).toBe('5');
  });
});

/**
 * SPEC-005 BR-005-20b (#120) — B3 publishes share-ratio factors only for
 * **listed companies**, so a fund or a delisted issuer has no factor of any
 * kind, ever, and every split or reverse split of theirs refused `no_factor`
 * permanently. Only there may positions corroborate each other.
 *
 * `FNDX11`, `FNDY11` and `FNDZ11` are invented tickers (DV-24); their issuer
 * codes `FNDX`/`FNDY`/`FNDZ` are simply absent from the factor map, which is
 * what "B3 publishes nothing for this issuer" looks like here.
 */
describe('#120 BR-005-20b — a ratio corroborated across positions', () => {
  const JULY = '2025-07-09';

  /** The same open row at a named institution — corroboration spans positions, so a test needs several. */
  function openAt(
    institution: string,
    movement: CorporateEventMovement,
    ticker: string,
    date: string,
    quantity: string,
  ): CorporateEventRow {
    const transaction = aTransaction()
      .rendimento()
      .status('unclassified')
      .of(ticker)
      .at(institution)
      .on(date)
      .quantity(quantity)
      .price('0')
      .imported()
      .build();
    return { id: transaction.id, movement, ticker, transaction, open: true };
  }

  const buyAt = (
    institution: string,
    ticker: string,
    date: string,
    quantity: string,
    price: string,
  ) =>
    aTransaction()
      .buy()
      .of(ticker)
      .at(institution)
      .on(date)
      .quantity(quantity)
      .price(price)
      .build();

  const sellAt = (
    institution: string,
    ticker: string,
    date: string,
    quantity: string,
    price: string,
  ) =>
    aTransaction()
      .sell()
      .of(ticker)
      .at(institution)
      .on(date)
      .quantity(quantity)
      .price(price)
      .build();

  it('resolves a desdobro two positions derive the same ratio for, where B3 publishes no factor at all', () => {
    // The fund shape. XP holds 16 bought at 100,00 → 1.600,00; BTG holds 49 at
    // 100,00 → 4.900,00. The Desdobro credits Δ = 112 and Δ = 343 on one date.
    //   (16 + 112) ÷ 16 = 128 ÷ 16 = 8
    //   (49 + 343) ÷ 49 = 392 ÷ 49 = 8
    // Two positions, one figure, exact at eight places → ratio 8 for both.
    // BR-007-04: total cost is unchanged, so 1.600 ÷ 128 = 12,50 and
    // 4.900 ÷ 392 = 12,50 — the same average, as one event on one asset must give.
    const xpHistory = [buyAt('XP', 'FNDX11', '2025-01-02', '16', '100')];
    const btgHistory = [buyAt('BTG', 'FNDX11', '2025-01-02', '49', '100')];
    const atXp = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDX11', JULY, '343');

    const outcomes = resolve([atXp, atBtg], [...xpHistory, ...btgHistory]);

    const xp = outcomeOf(outcomes, atXp);
    expect(xp).toMatchObject({ status: 'resolved', movement: 'desdobro' });
    if (xp.status !== 'resolved' || xp.movement !== 'desdobro') return;
    expect(str(xp.transaction.ratio)).toBe('8');
    expect(str(xp.evidence.basis)).toBe('16');
    expect(str(xp.evidence.derivedRatio)).toBe('8');
    // Nothing published: the batch page has no factor to show beside it.
    expect(xp.evidence.factors).toEqual([]);

    const btg = outcomeOf(outcomes, atBtg);
    expect(btg).toMatchObject({ status: 'resolved', movement: 'desdobro' });
    if (btg.status !== 'resolved' || btg.movement !== 'desdobro') return;
    expect(str(btg.transaction.ratio)).toBe('8');
    expect(str(btg.evidence.basis)).toBe('49');

    const xpAfter = replayed([...xpHistory, xp.transaction]);
    expect(xpAfter.quantity.toString()).toBe('128');
    expect(xpAfter.totalCost.toString()).toBe('1600');
    expect(xpAfter.averageCost.toString()).toBe('12.5');
    const btgAfter = replayed([...btgHistory, btg.transaction]);
    expect(btgAfter.quantity.toString()).toBe('392');
    expect(btgAfter.totalCost.toString()).toBe('4900');
    expect(btgAfter.averageCost.toString()).toBe('12.5');
  });

  it('corroborates a grupamento the same way: 22 ÷ 220 and 50 ÷ 500 are both 0,1', () => {
    // XP: 220 at 10,00 → 2.200,00; R = 22 → 22 ÷ 220 = 0,1.
    // BTG: 500 at 10,00 → 5.000,00; R = 50 → 50 ÷ 500 = 0,1.
    // After ×0,1: 22 shares at 2.200 ÷ 22 = 100,00 and 50 at 5.000 ÷ 50 = 100,00.
    const xpHistory = [buyAt('XP', 'FNDY11', '2025-01-02', '220', '10')];
    const btgHistory = [buyAt('BTG', 'FNDY11', '2025-01-02', '500', '10')];
    const atXp = openAt('XP', 'grupamento', 'FNDY11', JULY, '22');
    const atBtg = openAt('BTG', 'grupamento', 'FNDY11', JULY, '50');

    const outcomes = resolve([atXp, atBtg], [...xpHistory, ...btgHistory]);
    const xp = written(outcomes, atXp);
    const btg = written(outcomes, atBtg);
    expect([str(xp.ratio), str(btg.ratio)]).toEqual(['0.1', '0.1']);
    expect(xp.type).toBe('grupamento');

    const xpAfter = replayed([...xpHistory, xp]);
    expect(xpAfter.quantity.toString()).toBe('22');
    expect(xpAfter.averageCost.toString()).toBe('100');
    const btgAfter = replayed([...btgHistory, btg]);
    expect(btgAfter.quantity.toString()).toBe('50');
    expect(btgAfter.averageCost.toString()).toBe('100');
  });

  it('refuses no_factor when only one position has a usable basis — one position never confirms itself', () => {
    // XP bought 16 and sold all 16: P = 0, so it derives nothing and refuses
    // `no_basis`. BTG derives (49 + 343) ÷ 49 = 8, alone, which is the row
    // restating its own arithmetic — not evidence.
    const xpHistory = [
      buyAt('XP', 'FNDX11', '2025-01-02', '16', '100'),
      sellAt('XP', 'FNDX11', '2025-02-03', '16', '110'),
    ];
    const btgHistory = [buyAt('BTG', 'FNDX11', '2025-01-02', '49', '100')];
    const atXp = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDX11', JULY, '343');

    const closed = resolve([atXp, atBtg], [...xpHistory, ...btgHistory]);
    expect(outcomeOf(closed, atXp)).toMatchObject({ refusal: 'no_basis' });
    const alone = outcomeOf(closed, atBtg);
    expect(alone).toMatchObject({ refusal: 'no_factor' });
    if (alone.movement === 'desdobro') expect(str(alone.evidence.derivedRatio)).toBe('8');

    // The same with an unreplayable prefix: 16 bought, 20 sold.
    const broken = resolve(
      [atXp, atBtg],
      [
        buyAt('XP', 'FNDX11', '2025-01-02', '16', '100'),
        sellAt('XP', 'FNDX11', '2025-02-03', '20', '110'),
        ...btgHistory,
      ],
    );
    expect(outcomeOf(broken, atXp)).toMatchObject({ refusal: 'no_basis' });
    expect(outcomeOf(broken, atBtg)).toMatchObject({ refusal: 'no_factor' });

    // And a single position on its own, with nothing to corroborate against.
    const only = resolve([atBtg], btgHistory);
    expect(outcomeOf(only, atBtg)).toMatchObject({ refusal: 'no_factor' });
  });

  it('refuses the whole set as disagrees when two positions derive different ratios', () => {
    // XP: (16 + 112) ÷ 16 = 8. BTG: (56 + 336) ÷ 56 = 392 ÷ 56 = 7.
    // One of the two bases is wrong and nothing says which, so neither applies
    // and both show their own figure.
    const history = [
      buyAt('XP', 'FNDX11', '2025-01-02', '16', '100'),
      buyAt('BTG', 'FNDX11', '2025-01-02', '56', '100'),
    ];
    const atXp = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDX11', JULY, '336');

    const outcomes = resolve([atXp, atBtg], history);
    const xp = outcomeOf(outcomes, atXp);
    const btg = outcomeOf(outcomes, atBtg);
    expect(xp).toMatchObject({ status: 'refused', refusal: 'disagrees' });
    expect(btg).toMatchObject({ status: 'refused', refusal: 'disagrees' });
    if (xp.movement === 'desdobro') expect(str(xp.evidence.derivedRatio)).toBe('8');
    if (btg.movement === 'desdobro') expect(str(btg.evidence.derivedRatio)).toBe('7');
  });

  it('refuses a corroborated ratio the ledger cannot hold exactly as not_representable', () => {
    // A 3:1 grupamento. XP: 100 ÷ 300; BTG: 200 ÷ 600. Both are the same
    // repeating 0,333…, so the set agrees — but stored at NUMERIC(20,8) that
    // is 0,33333333, a different number, and the ledger would hold a ratio
    // nothing published or derived.
    const history = [
      buyAt('XP', 'FNDY11', '2025-01-02', '300', '10'),
      buyAt('BTG', 'FNDY11', '2025-01-02', '600', '10'),
    ];
    const atXp = openAt('XP', 'grupamento', 'FNDY11', JULY, '100');
    const atBtg = openAt('BTG', 'grupamento', 'FNDY11', JULY, '200');

    const outcomes = resolve([atXp, atBtg], history);
    const xp = outcomeOf(outcomes, atXp);
    expect(xp).toMatchObject({ status: 'refused', refusal: 'not_representable' });
    expect(outcomeOf(outcomes, atBtg)).toMatchObject({ refusal: 'not_representable' });
    if (xp.movement === 'grupamento') {
      expect(asStored(xp.evidence.derivedRatio as Quantity)).toBe('0.33333333');
    }
  });

  it('keeps refusing no_factor for an issuer B3 publishes for, even with two positions corroborating', () => {
    // **The regression that protects the guard.** FNDZ has a desdobramento
    // published with última data com 2014-05-02 — far outside the 7-day
    // window, so it confirms nothing. But B3 *does* publish for this issuer,
    // so the absence of a factor near the row is real evidence that this event
    // is not one B3 recorded: a 2014 desdobramento does not license a 2025
    // one. Both positions derive 8 and neither applies.
    const history = [
      buyAt('XP', 'FNDZ11', '2025-01-02', '16', '100'),
      buyAt('BTG', 'FNDZ11', '2025-01-02', '49', '100'),
    ];
    const atXp = openAt('XP', 'desdobro', 'FNDZ11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDZ11', JULY, '343');

    const outcomes = resolve([atXp, atBtg], history, [
      factor('FNDZ', 'desdobramento', '700', '2014-05-02'),
    ]);
    const xp = outcomeOf(outcomes, atXp);
    expect(xp).toMatchObject({ status: 'refused', refusal: 'no_factor' });
    expect(outcomeOf(outcomes, atBtg)).toMatchObject({ refusal: 'no_factor' });
    // Derived 8 on both, and no factor in the window to show beside it.
    if (xp.movement === 'desdobro') {
      expect(str(xp.evidence.derivedRatio)).toBe('8');
      expect(xp.evidence.factors).toEqual([]);
    }
  });

  it('lets a published factor in the window win over two corroborating positions: disagrees', () => {
    // FNDZ published a desdobramento of 900 % — m = 1 + 900 ÷ 100 = 10 — two
    // days before the row. XP: 16 × (10 − 1) = 144 ≠ 112. BTG: 49 × 9 = 441 ≠
    // 343. Both derive 8, and agreeing with each other does not outrank B3.
    const history = [
      buyAt('XP', 'FNDZ11', '2025-01-02', '16', '100'),
      buyAt('BTG', 'FNDZ11', '2025-01-02', '49', '100'),
    ];
    const atXp = openAt('XP', 'desdobro', 'FNDZ11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDZ11', JULY, '343');

    const published = factor('FNDZ', 'desdobramento', '900', '2025-07-07');
    const outcomes = resolve([atXp, atBtg], history, [published]);
    const xp = outcomeOf(outcomes, atXp);
    expect(xp).toMatchObject({ status: 'refused', refusal: 'disagrees' });
    expect(outcomeOf(outcomes, atBtg)).toMatchObject({ refusal: 'disagrees' });
    if (xp.movement === 'desdobro') {
      expect(str(xp.evidence.derivedRatio)).toBe('8');
      expect(xp.evidence.factors).toEqual([published]);
    }
  });

  it('never lets one position confirm itself through a same-day pair of its own', () => {
    // Two Desdobro rows on the XP position on one date: which applies first is
    // not stated, so both are `combined_same_day` before any ratio is derived
    // and neither can join a corroboration set. BTG is then alone.
    const history = [
      buyAt('XP', 'FNDX11', '2025-01-02', '16', '100'),
      buyAt('BTG', 'FNDX11', '2025-01-02', '49', '100'),
    ];
    const first = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const second = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const atBtg = openAt('BTG', 'desdobro', 'FNDX11', JULY, '343');

    const outcomes = resolve([first, second, atBtg], history);
    expect(outcomeOf(outcomes, first)).toMatchObject({ refusal: 'combined_same_day' });
    expect(outcomeOf(outcomes, second)).toMatchObject({ refusal: 'combined_same_day' });
    expect(outcomeOf(outcomes, atBtg)).toMatchObject({ refusal: 'no_factor' });
  });

  it('corroborates a second generation: the event behind a corroborated one resolves too', () => {
    // A ratio event behind an unresolved one is `blocked`, never `no_factor`,
    // so it cannot corroborate anything until the one before it settles.
    //
    // XP: 16 at 100,00 → 1.600,00.
    //   03/03 Δ = 16 → (16 + 16) ÷ 16 = 2 → 32 shares, 1.600 ÷ 32 = 50,00.
    //   09/07 Δ = 128 → (32 + 128) ÷ 32 = 160 ÷ 32 = 5 → 160 shares, 10,00.
    // BTG: 25 at 64,00 → 1.600,00.
    //   03/03 Δ = 25 → (25 + 25) ÷ 25 = 2 → 50 shares, 32,00.
    //   09/07 Δ = 200 → (50 + 200) ÷ 50 = 250 ÷ 50 = 5 → 250 shares, 6,40.
    const xpHistory = [buyAt('XP', 'FNDX11', '2025-01-02', '16', '100')];
    const btgHistory = [buyAt('BTG', 'FNDX11', '2025-01-02', '25', '64')];
    const xpMarch = openAt('XP', 'desdobro', 'FNDX11', '2025-03-03', '16');
    const btgMarch = openAt('BTG', 'desdobro', 'FNDX11', '2025-03-03', '25');
    const xpJuly = openAt('XP', 'desdobro', 'FNDX11', JULY, '128');
    const btgJuly = openAt('BTG', 'desdobro', 'FNDX11', JULY, '200');

    const outcomes = resolve([xpJuly, btgMarch, xpMarch, btgJuly], [...xpHistory, ...btgHistory]);
    expect(str(written(outcomes, xpMarch).ratio)).toBe('2');
    expect(str(written(outcomes, btgMarch).ratio)).toBe('2');
    expect(str(written(outcomes, xpJuly).ratio)).toBe('5');
    expect(str(written(outcomes, btgJuly).ratio)).toBe('5');

    const xpAfter = replayed([...xpHistory, written(outcomes, xpMarch), written(outcomes, xpJuly)]);
    expect(xpAfter.quantity.toString()).toBe('160');
    expect(xpAfter.totalCost.toString()).toBe('1600');
    expect(xpAfter.averageCost.toString()).toBe('10');
    const btgAfter = replayed([
      ...btgHistory,
      written(outcomes, btgMarch),
      written(outcomes, btgJuly),
    ]);
    expect(btgAfter.quantity.toString()).toBe('250');
    expect(btgAfter.averageCost.toString()).toBe('6.4');
  });

  it('measures a position that unblocks after the set was decided against it, never carries it along', () => {
    // XP and BTG settle the July set at 8 on the first round. NU is `blocked`
    // there behind its own March Desdobro, which RICO corroborates at 2 in the
    // same round — so NU only reaches July on the next one, by which time the
    // set has a figure.
    //
    // NU: 10 at 100,00. 03/03 Δ = 10 → (10 + 10) ÷ 10 = 2 → 20 shares.
    //     09/07 Δ = 100 → (20 + 100) ÷ 20 = 120 ÷ 20 = 6 ≠ 8.
    // Applying the set's 8 to a position deriving 6 would put a ratio in the
    // ledger that nothing on that position supports, so NU refuses `disagrees`.
    const history = [
      buyAt('XP', 'FNDX11', '2025-01-02', '16', '100'),
      buyAt('BTG', 'FNDX11', '2025-01-02', '49', '100'),
      buyAt('NU', 'FNDX11', '2025-01-02', '10', '100'),
      buyAt('RICO', 'FNDX11', '2025-01-02', '25', '40'),
    ];
    const xpJuly = openAt('XP', 'desdobro', 'FNDX11', JULY, '112');
    const btgJuly = openAt('BTG', 'desdobro', 'FNDX11', JULY, '343');
    const nuMarch = openAt('NU', 'desdobro', 'FNDX11', '2025-03-03', '10');
    const ricoMarch = openAt('RICO', 'desdobro', 'FNDX11', '2025-03-03', '25');
    const nuJuly = openAt('NU', 'desdobro', 'FNDX11', JULY, '100');

    const outcomes = resolve([xpJuly, btgJuly, nuMarch, ricoMarch, nuJuly], history);
    expect(str(written(outcomes, xpJuly).ratio)).toBe('8');
    expect(str(written(outcomes, btgJuly).ratio)).toBe('8');
    expect(str(written(outcomes, nuMarch).ratio)).toBe('2');
    expect(str(written(outcomes, ricoMarch).ratio)).toBe('2');

    const late = outcomeOf(outcomes, nuJuly);
    expect(late).toMatchObject({ status: 'refused', refusal: 'disagrees' });
    if (late.movement === 'desdobro') {
      expect(str(late.evidence.basis)).toBe('20');
      expect(str(late.evidence.derivedRatio)).toBe('6');
    }
  });
});

describe('#139 BR-005-20b / BR-007-04a / BR-007-04b — a same-date Desdobro and Grupamento pair', () => {
  /**
   * The VIVT3 re-denomination shape, generated (DV-24). Buy 150 @ 50,00 →
   * 7.500,00. On 2025-04-16 B3 states a `Desdobro` of Δ = 237 and a
   * `Grupamento` of R = 3,75, then removes a 0,75 fraction; the auction sells
   * it on 2025-05-28 @ 2.131,357. Factors: desdobramento `7900` (percent
   * added, m = 80) and grupamento `0.025`, both *última data com* 2025-04-14.
   *
   * Grupamento first: 150 × 0,025 = 3,75 = R; 0,75 removed; desdobro on 3:
   * 3 × 79 = 237 = Δ → 240. (Desdobro first: 150 × 79 = 11.850 ≠ 237.)
   */
  function scenario(desdobroDelta = '237') {
    const history = [buy('VIVT3', '2025-01-02', '150', '50')];
    const desdobro = open('desdobro', 'VIVT3', '2025-04-16', desdobroDelta);
    const grupamento = open('grupamento', 'VIVT3', '2025-04-16', '3.75');
    const fraction = open('fracao_em_ativos', 'VIVT3', '2025-04-16', '0.75');
    const auction = open('leilao_de_fracao', 'VIVT3', '2025-05-28', '0.75', '2131.357');
    const factors = [
      factor('VIVT', 'desdobramento', '7900', '2025-04-14'),
      factor('VIVT', 'grupamento', '0.025', '2025-04-14'),
    ];
    return { history, desdobro, grupamento, fraction, auction, factors };
  }

  it('resolves the pair in the order the quantities prove, each at its own factor, with its own basis', () => {
    const { history, desdobro, grupamento, fraction, auction, factors } = scenario();
    const outcomes = resolve([desdobro, grupamento, fraction, auction], history, factors);
    const grouped = outcomeOf(outcomes, grupamento);
    const split = outcomeOf(outcomes, desdobro);
    expect(grouped).toMatchObject({ status: 'resolved' });
    expect(split).toMatchObject({ status: 'resolved' });
    if (grouped.status !== 'resolved' || grouped.movement !== 'grupamento') return;
    if (split.status !== 'resolved' || split.movement !== 'desdobro') return;
    expect(grouped.transaction).toMatchObject({ type: 'grupamento', status: 'active' });
    expect(str(grouped.transaction.ratio)).toBe('0.025');
    expect(split.transaction).toMatchObject({ type: 'split', status: 'active' });
    expect(str(split.transaction.ratio)).toBe('80');
    // The grupamento met P = 150 (3,75 ÷ 150 = 0,025); the desdobro met 3
    // ((3 + 237) ÷ 3 = 80).
    expect(str(grouped.evidence.basis)).toBe('150');
    expect(str(grouped.evidence.derivedRatio)).toBe('0.025');
    expect(str(split.evidence.basis)).toBe('3');
    expect(str(split.evidence.derivedRatio)).toBe('80');
  });

  it('sells the fraction removed between the two at the desdobro scale, and the position lands on 240', () => {
    const { history, desdobro, grupamento, fraction, auction, factors } = scenario();
    const outcomes = resolve([auction, fraction, grupamento, desdobro], history, factors);
    const sale = outcomeOf(outcomes, fraction);
    expect(sale).toMatchObject({ status: 'resolved' });
    if (sale.status !== 'resolved' || sale.movement !== 'fracao_em_ativos') return;
    // Origin: the grupamento, which left 3,75 and a 0,75 fraction.
    expect(sale.evidence.origin).toMatchObject({
      id: grupamento.transaction.id,
      type: 'grupamento',
    });
    expect(str(sale.evidence.origin?.quantityAfter)).toBe('3.75');
    expect(str(sale.evidence.origin?.fractionalPart)).toBe('0.75');
    // 0,75 × 80 = 60 shares at 2.131,357 ÷ 80 = 26,6419625.
    expect(sale.transaction).toMatchObject({ type: 'sell', status: 'active' });
    expect(sale.transaction.tradeDate).toBe('2025-04-16');
    expect(str(sale.transaction.quantity)).toBe('60');
    expect(sale.transaction.unitPrice.toString()).toBe('26.6419625');
    // Proceeds unchanged: 60 × 26,6419625 = 1.598,51775 = 0,75 × 2.131,357.
    expect(sale.transaction.totalValue.toString()).toBe('1598.51775');
    expect(outcomeOf(outcomes, auction)).toMatchObject({ status: 'consumed' });

    // Replay: 150 → (×0,025, ×80) 300, cost 7.500,00, average 25,00; sell 60:
    // cost out 60 × 25,00 = 1.500,00 (20 % — as 0,75 of 3,75); realised
    // 1.598,51775 − 1.500,00 = 98,51775. 240 shares, 6.000,00, average 25,00.
    const position = replayed([
      ...history,
      written(outcomes, grupamento),
      written(outcomes, desdobro),
      sale.transaction,
    ]);
    expect(position.quantity.toString()).toBe('240');
    expect(position.totalCost.toString()).toBe('6000');
    expect(position.averageCost.toString()).toBe('25');
    expect(position.realizedGain.toString()).toBe('98.51775');
  });

  it('is independent of input order: every permutation of the four rows gives the same outcomes', () => {
    const { history, desdobro, grupamento, fraction, auction, factors } = scenario();
    const rows = [desdobro, grupamento, fraction, auction];
    const signature = (order: readonly CorporateEventRow[]) =>
      rows
        .map((row) => {
          const outcome = outcomeOf(resolve(order, history, factors), row);
          return outcome.status === 'refused'
            ? `${row.id}:${outcome.refusal}`
            : `${row.id}:${outcome.status}:${outcome.transaction.type}:${str(outcome.transaction.quantity)}:${str(outcome.transaction.ratio)}`;
        })
        .join('|');
    const expected = signature(rows);
    const permutations = (list: readonly CorporateEventRow[]): CorporateEventRow[][] =>
      list.length <= 1
        ? [[...list]]
        : list.flatMap((head, i) =>
            permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((tail) => [
              head,
              ...tail,
            ]),
          );
    for (const order of permutations(rows)) expect(signature(order)).toBe(expected);
  });

  it('resolves the fraction against a pair an earlier import settled (incremental = from scratch)', () => {
    const { history, desdobro, grupamento, fraction, auction, factors } = scenario();
    const first = resolve([desdobro, grupamento], history, factors);
    const storedPair = [written(first, grupamento), written(first, desdobro)];
    const outcomes = resolve(
      [
        settled('grupamento', 'VIVT3', storedPair[0] as Transaction),
        settled('desdobro', 'VIVT3', storedPair[1] as Transaction),
        fraction,
        auction,
      ],
      [...history, ...storedPair],
      factors,
    );
    const sale = written(outcomes, fraction);
    expect(str(sale.quantity)).toBe('60');
    expect(sale.unitPrice.toString()).toBe('26.6419625');
    expect(outcomeOf(outcomes, auction)).toMatchObject({ status: 'consumed' });
  });

  it('refuses the whole pair when one quantity disagrees — never one of the two — and the fraction waits', () => {
    // Δ = 236: grupamento first leaves 3 → 3 × 79 = 237 ≠ 236; on 3,75 → 296,25.
    const { history, desdobro, grupamento, fraction, auction, factors } = scenario('236');
    const outcomes = resolve([desdobro, grupamento, fraction, auction], history, factors);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'disagrees' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'disagrees' });
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'origin_unresolved' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'origin_unresolved' });
  });

  it('refuses combined_same_day where the two factors do not identify the order', () => {
    // A 0 % desdobramento (m = 1, Δ = 0) and a grupamento ×0,5 (100 → 50):
    // desdobro first, 100 × 0 = 0 = Δ then 100 × 0,5 = 50 = R; grupamento
    // first, 50 = R then 50 × 0 = 0 = Δ. Two sequences — neither applies.
    const history = [buy('ABCD3', '2025-01-02', '100', '10')];
    const desdobro = open('desdobro', 'ABCD3', '2025-04-16', '0');
    const grupamento = open('grupamento', 'ABCD3', '2025-04-16', '50');
    const outcomes = resolve([desdobro, grupamento], history, [
      factor('ABCD', 'desdobramento', '0', '2025-04-14'),
      factor('ABCD', 'grupamento', '0.5', '2025-04-14'),
    ]);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'combined_same_day' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'combined_same_day' });
  });

  it('refuses the pair as not_representable when either factor cannot be stored exactly', () => {
    const { history, desdobro, grupamento } = scenario();
    const outcomes = resolve([desdobro, grupamento], history, [
      factor('VIVT', 'desdobramento', '7900', '2025-04-14'),
      factor('VIVT', 'grupamento', '0.333333333333', '2025-04-14'),
    ]);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'not_representable' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'not_representable' });
  });

  it('refuses the pair as no_factor when only one of the two is published', () => {
    const { history, desdobro, grupamento } = scenario();
    const outcomes = resolve([desdobro, grupamento], history, [
      factor('VIVT', 'grupamento', '0.025', '2025-04-14'),
    ]);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'no_factor' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'no_factor' });
  });

  it('refuses both as conflicts_with_ledger when commit gives up either one', () => {
    const { history, desdobro, grupamento, factors } = scenario();
    const outcomes = resolve([desdobro, grupamento], history, factors, new Set([desdobro.id]));
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ refusal: 'conflicts_with_ledger' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ refusal: 'conflicts_with_ledger' });
  });

  it('refuses the scaled sale as scale_not_representable, leaving the pair resolved', () => {
    // m = 3 (factor 200): 150 → 3,75 → 3 → 3 × 2 = 6 = Δ → 9. The sale would be
    // 0,75 × 3 = 2,25 @ 2.131,357 ÷ 3 = 710,4523333… — not exact at 8 places.
    const history = [buy('VIVT3', '2025-01-02', '150', '50')];
    const desdobro = open('desdobro', 'VIVT3', '2025-04-16', '6');
    const grupamento = open('grupamento', 'VIVT3', '2025-04-16', '3.75');
    const fraction = open('fracao_em_ativos', 'VIVT3', '2025-04-16', '0.75');
    const auction = open('leilao_de_fracao', 'VIVT3', '2025-05-28', '0.75', '2131.357');
    const outcomes = resolve([desdobro, grupamento, fraction, auction], history, [
      factor('VIVT', 'desdobramento', '200', '2025-04-14'),
      factor('VIVT', 'grupamento', '0.025', '2025-04-14'),
    ]);
    expect(outcomeOf(outcomes, desdobro)).toMatchObject({ status: 'resolved' });
    expect(outcomeOf(outcomes, grupamento)).toMatchObject({ status: 'resolved' });
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'scale_not_representable' });
    expect(outcomeOf(outcomes, auction)).toMatchObject({ refusal: 'scale_not_representable' });
  });

  it('sells a fraction the second event left at its own scale: desdobro ×2, then grupamento ×0,0125', () => {
    // P = 100: desdobro first, 100 × 1 = 100 = Δ → 200; 200 × 0,0125 = 2,5 = R.
    // (Grupamento first: 100 × 0,0125 = 1,25 ≠ 2,5.) The fraction 0,5 is the
    // grupamento's own, removed after both: a sale of 0,5 @ 40,00, unscaled.
    const history = [buy('ABCD3', '2025-01-02', '100', '10')];
    const desdobro = open('desdobro', 'ABCD3', '2025-04-16', '100');
    const grupamento = open('grupamento', 'ABCD3', '2025-04-16', '2.5');
    const fraction = open('fracao_em_ativos', 'ABCD3', '2025-04-16', '0.5');
    const auction = open('leilao_de_fracao', 'ABCD3', '2025-05-28', '0.5', '40');
    const outcomes = resolve([desdobro, grupamento, fraction, auction], history, [
      factor('ABCD', 'desdobramento', '100', '2025-04-14'),
      factor('ABCD', 'grupamento', '0.0125', '2025-04-14'),
    ]);
    const sale = outcomeOf(outcomes, fraction);
    expect(sale).toMatchObject({ status: 'resolved' });
    if (sale.status !== 'resolved' || sale.movement !== 'fracao_em_ativos') return;
    expect(sale.evidence.origin).toMatchObject({ id: grupamento.transaction.id });
    expect(str(sale.transaction.quantity)).toBe('0.5');
    expect(sale.transaction.unitPrice.toString()).toBe('40');
    // 100 × 2 × 0,0125 = 2,5 − 0,5 = 2 shares, cost 1.000,00 × 0,8 = 800,00.
    const position = replayed([
      ...history,
      written(outcomes, desdobro),
      written(outcomes, grupamento),
      sale.transaction,
    ]);
    expect(position.quantity.toString()).toBe('2');
    expect(position.totalCost.toString()).toBe('800');
  });

  it('reads no origin figures for a date with a hand-classified pair its quantities do not fit', () => {
    // Stored split ×2 and grupamento ×0,5 with stated quantities of 1 each fit
    // no sequence, so a fraction on that date cannot be decided.
    const history = [
      buy('ABCD3', '2025-01-02', '100', '10'),
      aTransaction()
        .split()
        .of('ABCD3')
        .at(BROKER)
        .on('2025-04-16')
        .quantity('1')
        .ratio('2')
        .build(),
      aTransaction()
        .grupamento()
        .of('ABCD3')
        .at(BROKER)
        .on('2025-04-16')
        .quantity('1')
        .ratio('0.5')
        .build(),
    ];
    const fraction = open('fracao_em_ativos', 'ABCD3', '2025-04-16', '0.5');
    const auction = open('leilao_de_fracao', 'ABCD3', '2025-05-28', '0.5', '40');
    const outcomes = resolve([fraction, auction], history);
    expect(outcomeOf(outcomes, fraction)).toMatchObject({ refusal: 'origin_unresolved' });
  });
});
