import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import type { AssetId, InstitutionId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { aggregate, buildHoldingSet, totalsOf } from '@/core/reporting/base-query';
import { applyScope } from '@/core/reporting/scope';
import {
  GROUPINGS,
  UNASSIGNED_GROUP_ID,
  type AssetDescriptor,
  type ReportAllocation,
  type ReportHolding,
  type ReportPosition,
  type Scope,
} from '@/core/reporting/ports';
import { aPosition, assetIdOf, institutionIdOf, walletIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-011 BR-011-08 / AC-6, DL-011-03, TS-12 — **the highest-value test in
 * this issue.**
 *
 * "Switching the grouping must never change any scope-level total." The rule
 * is cheap to state and expensive to verify by inspection, which is exactly
 * why DL-011-03 turns it into an automated assertion: nearly every aggregation
 * bug surfaces as a total that moves when the grouping changes.
 *
 * Concretely, this test fails if any of the following is ever introduced:
 *
 *  - a holding dropped because its sector is null (BR-011-10 violated — the
 *    sector total would fall short of the asset-class total);
 *  - a missing Unassigned bucket (BR-011-09 violated — the wallet total would
 *    fall short by the unallocated remainder);
 *  - an asset split across two wallets counted once per wallet at full value
 *    (the wallet total would exceed the asset total);
 *  - an asset held at two institutions double-counted by the pro-rata split;
 *  - a rounding mode that loses a sliver on division, so grouping by wallet
 *    quietly returns less money than grouping by asset class;
 *  - a stale allocation for a closed position conjuring value from nothing.
 *
 * TS-04: the invariant is asserted as **exact** `Money` equality. An
 * approximate comparison would pass straight over the rounding-drift class of
 * bug, which is the one this framework's arithmetic is most exposed to.
 *
 * Determinism (TS-23): the portfolios are generated from a fixed seed with a
 * local PRNG. Nothing here reads `Math.random`, so a failure is reproducible
 * from the seed printed in the test name.
 */

/** mulberry32 — a small, fast, fully deterministic PRNG. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSET_CLASSES: readonly AssetClass[] = [
  'stock',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
];

/** BR-011-10: fixed income and Tesouro have no sector — the "Not classified" driver. */
const FIXED_INCOME: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'cdb',
  'lci',
  'lca',
  'tesouro_direto',
]);

const SECTORS = ['Bancos', 'Energia', 'Petróleo e Gás', 'Consumo'] as const;

/**
 * Unit prices chosen to force **non-terminating division** through the
 * pro-rata split. A price like 12.345678 over a prime quantity such as 997,
 * apportioned three ways, produces a repeating decimal in every share — which
 * is precisely where a naive proportional split silently loses value.
 */
const UNIT_PRICES = ['12.345678', '3.33', '107.07', '0.87', '1234.5678', '19.999999'] as const;

/** Prime-ish quantities, so nothing divides evenly by accident. */
const QUANTITIES = [997, 101, 37, 13, 7, 3, 1, 499, 251, 61] as const;

interface GeneratedPortfolio {
  readonly positions: readonly ReportPosition[];
  readonly allocations: readonly ReportAllocation[];
  readonly assets: readonly AssetDescriptor[];
  readonly walletIds: readonly WalletId[];
}

/**
 * A portfolio built to stress every path the invariant can break on, rather
 * than an average one. Each seed varies the mix; every seed contains at least
 * one of each awkward case.
 */
function generatePortfolio(seed: number): GeneratedPortfolio {
  const random = prng(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

  // Four wallets. The fourth is deliberately never allocated anything — an
  // empty wallet must still scope cleanly and total zero.
  const walletIds: readonly WalletId[] = [1, 2, 3, 4].map((n) => walletIdOf(String(n)));
  const institutions: readonly (InstitutionId | null)[] = [
    institutionIdOf('1'),
    institutionIdOf('2'),
    // BR-011-10: a position with no institution recorded → "Not classified".
    null,
  ];

  const assets: AssetDescriptor[] = [];
  const positions: ReportPosition[] = [];
  const allocations: ReportAllocation[] = [];

  const ASSET_COUNT = 14;
  for (let i = 0; i < ASSET_COUNT; i += 1) {
    const assetId = assetIdOf(String(i + 1));
    const assetClass =
      i < ASSET_CLASSES.length ? (ASSET_CLASSES[i] as AssetClass) : pick(ASSET_CLASSES);
    const sector = FIXED_INCOME.has(assetClass)
      ? null
      : // Some equities also lack sector data — the catalog has no sector
        // column at all today (PRD Q5), so null is the common case, not a rare one.
        random() < 0.4
        ? null
        : pick(SECTORS);

    assets.push({
      assetId,
      code: `AST${String(i + 1).padStart(2, '0')}`,
      name: `Ativo ${i + 1}`,
      assetClass,
      sector,
    });

    // Every fifth asset is CLOSED TO ZERO: no position at all, but a stale
    // allocation row left behind. It must contribute nothing to any total.
    if (i % 5 === 4) {
      allocations.push({
        walletId: pick(walletIds),
        assetId,
        quantity: Quantity.fromString('50'),
      });
      continue;
    }

    // One or two institutions for this asset.
    const institutionCount = random() < 0.5 ? 2 : 1;
    let heldTotal = 0;
    for (let j = 0; j < institutionCount; j += 1) {
      const quantity = pick(QUANTITIES);
      const unitPrice = pick(UNIT_PRICES);
      heldTotal += quantity;
      positions.push(
        aPosition({
          assetId,
          institutionId: institutions[(i + j) % institutions.length] ?? null,
          quantity: Quantity.fromString(String(quantity)),
          // value = quantity × unit price, exact decimal arithmetic throughout.
          value: Money.fromString(unitPrice).times(Quantity.fromString(String(quantity))),
          costBasis: Money.fromString(unitPrice)
            .times(Quantity.fromString(String(quantity)))
            .times('0.8'),
          // BR-011-15: fixed income is accrued, therefore estimated.
          estimated: FIXED_INCOME.has(assetClass),
        }),
      );
    }

    // Allocation shape: none, partial, full, or split across several wallets.
    // Integer quantities, as a real allocation would be, and never exceeding
    // what is held (SPEC-010 BR-010-05).
    const shape = Math.floor(random() * 4);
    if (shape === 0) {
      // Wholly unassigned — the Unassigned bucket must carry all of it.
    } else if (shape === 1) {
      allocations.push({
        walletId: walletIds[0] as WalletId,
        assetId,
        quantity: Quantity.fromString(String(heldTotal)),
      });
    } else if (shape === 2) {
      // Partial: a third, leaving a remainder for Unassigned.
      const part = Math.floor(heldTotal / 3);
      if (part > 0) {
        allocations.push({
          walletId: walletIds[1] as WalletId,
          assetId,
          quantity: Quantity.fromString(String(part)),
        });
      }
    } else {
      // Split across three wallets, leaving a remainder.
      const a = Math.floor(heldTotal / 3);
      const b = Math.floor(heldTotal / 5);
      const c = Math.floor(heldTotal / 7);
      for (const [index, part] of [a, b, c].entries()) {
        if (part > 0) {
          allocations.push({
            walletId: walletIds[index] as WalletId,
            assetId,
            quantity: Quantity.fromString(String(part)),
          });
        }
      }
    }
  }

  return { positions, allocations, assets, walletIds };
}

function scopesFor(walletIds: readonly WalletId[]): readonly Scope[] {
  return [
    { kind: 'portfolio' },
    ...walletIds.map((walletId): Scope => ({ kind: 'wallet', walletId })),
  ];
}

const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 20260814, 987654321];

describe('BR-011-08 / AC-6 / TS-12 — totals are invariant across every grouping', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every grouping of every scope sums to the same scope total`, () => {
      const portfolio = generatePortfolio(seed);
      const built = buildHoldingSet(portfolio);
      if (!built.ok) throw new Error(`holding set failed: ${built.error.code}`);
      const holdings = built.value;

      expect(holdings.length).toBeGreaterThan(0);

      for (const scope of scopesFor(portfolio.walletIds)) {
        const scoped = applyScope(holdings, scope);
        // The reference figure, computed once, straight from the holdings.
        const reference = totalsOf(scoped);

        for (const grouping of GROUPINGS) {
          const report = aggregate(scoped, grouping);

          // (1) The report's own scope total must not move with the grouping.
          expect(
            report.total.value.equals(reference.value),
            `${grouping} changed the scope total: ${report.total.value.toString()} vs ${reference.value.toString()}`,
          ).toBe(true);
          expect(report.total.costBasis.equals(reference.costBasis)).toBe(true);
          expect(report.total.quantity.equals(reference.quantity)).toBe(true);

          // (2) The group subtotals must sum EXACTLY to it — no holding
          //     dropped, none counted twice, no sliver lost to division.
          const summed = report.groups.reduce(
            (acc, group) => acc.plus(group.totals.value),
            Money.zero(),
          );
          expect(
            summed.equals(reference.value),
            `${grouping} groups sum to ${summed.toString()}, scope total is ${reference.value.toString()}`,
          ).toBe(true);

          // (3) Every holding lands in exactly one group.
          const partitioned = report.groups.reduce((acc, group) => acc + group.holdings.length, 0);
          expect(partitioned).toBe(scoped.length);
        }
      }
    });
  }

  it('holds when switching asset class → wallet → asset class, the AC-6 round trip', () => {
    const portfolio = generatePortfolio(2026);
    const built = buildHoldingSet(portfolio);
    if (!built.ok) throw new Error(built.error.code);

    const first = aggregate(built.value, 'asset_class').total.value;
    const middle = aggregate(built.value, 'wallet').total.value;
    const last = aggregate(built.value, 'asset_class').total.value;

    expect(first.equals(middle)).toBe(true);
    expect(first.equals(last)).toBe(true);
    expect(first.toString()).toBe(last.toString());
  });
});

describe('BR-011-09 — Unassigned keeps the wallet view whole', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: wallet groups plus Unassigned sum to the portfolio`, () => {
      const portfolio = generatePortfolio(seed);
      const built = buildHoldingSet(portfolio);
      if (!built.ok) throw new Error(built.error.code);

      const report = aggregate(built.value, 'wallet');
      const portfolioTotal = totalsOf(built.value).value;

      const allocated = report.groups
        .filter((group) => !group.key.synthetic)
        .reduce((acc, group) => acc.plus(group.totals.value), Money.zero());
      const unassigned =
        report.groups.find((group) => group.key.id === UNASSIGNED_GROUP_ID)?.totals.value ??
        Money.zero();

      expect(allocated.plus(unassigned).equals(portfolioTotal)).toBe(true);
      // The generator always leaves something unallocated somewhere.
      expect(unassigned.isPositive()).toBe(true);
    });
  }
});

describe('BR-011-10 — "Not classified" keeps the sector view whole', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: the sector view reconciles with the asset-class view`, () => {
      const portfolio = generatePortfolio(seed);
      const built = buildHoldingSet(portfolio);
      if (!built.ok) throw new Error(built.error.code);

      const bySector = aggregate(built.value, 'sector');
      const byClass = aggregate(built.value, 'asset_class');

      // The failure this catches: dropping sector-less holdings would make
      // the sector view quietly smaller than every other view of the same
      // scope, with nothing on screen to explain the difference.
      expect(bySector.total.value.equals(byClass.total.value)).toBe(true);

      const notClassified = bySector.groups.find((group) => group.key.synthetic);
      expect(notClassified, 'fixed income is present, so this bucket must exist').toBeDefined();
      expect(notClassified!.totals.value.isPositive()).toBe(true);
    });
  }
});

describe('TS-11 — adversarial precision: no drift across hundreds of holdings', () => {
  it('sums 600 slices whose three-way split never terminates', () => {
    // 200 assets, each held at one institution, each split three ways across
    // wallets — 600 slices. Every position value is a legal `NUMERIC(20,8)`
    // literal, because that is what actually comes back from the database;
    // it is the **apportionment** that divides awkwardly, dividing amounts
    // ending in ...0001 by three.
    //
    // This is the test that catches a JS `number` leaking into a money path:
    // float addition of 600 such values drifts around the 10th decimal place,
    // while exact decimal arithmetic does not move at all.
    const assets: AssetDescriptor[] = [];
    const positions: ReportPosition[] = [];
    const allocations: ReportAllocation[] = [];
    const wallets = [walletIdOf('1'), walletIdOf('2')];

    let expectedTotal = Money.zero();
    for (let i = 0; i < 200; i += 1) {
      const assetId = assetIdOf(String(i + 1)) as AssetId;
      // Full storage precision, and deliberately not divisible by three.
      const value = Money.fromString(`${1000 + i}.00000001`);
      assets.push({
        assetId,
        code: `AST${i}`,
        name: `Ativo ${i}`,
        assetClass: 'stock',
        sector: i % 2 === 0 ? 'Bancos' : null,
      });
      positions.push(
        aPosition({
          assetId,
          institutionId: institutionIdOf('1'),
          quantity: Quantity.fromString('99'),
          value,
          costBasis: Money.fromString(`${700 + i}.00000007`),
          estimated: false,
        }),
      );
      // 33 + 33 allocated of 99 held, leaving 33 unassigned: three slices,
      // each one third of a value with a 1 in the last stored decimal place.
      allocations.push({ walletId: wallets[0]!, assetId, quantity: Quantity.fromString('33') });
      allocations.push({ walletId: wallets[1]!, assetId, quantity: Quantity.fromString('33') });
      expectedTotal = expectedTotal.plus(value);
    }

    const built = buildHoldingSet({ positions, allocations, assets });
    if (!built.ok) throw new Error(built.error.code);
    expect(built.value).toHaveLength(600);

    for (const grouping of GROUPINGS) {
      const report = aggregate(built.value, grouping);
      // Exact equality against a total accumulated independently of the
      // splitting — not against the implementation's own answer.
      expect(
        report.total.value.equals(expectedTotal),
        `${grouping}: ${report.total.value.toString()} != ${expectedTotal.toString()}`,
      ).toBe(true);
      const summed = report.groups.reduce(
        (acc, group) => acc.plus(group.totals.value),
        Money.zero(),
      );
      expect(summed.equals(expectedTotal)).toBe(true);
    }
  });

  it('a three-way split of an indivisible amount loses nothing per asset', () => {
    // R$ 1.000,00000001 held as 99 units, split 33 / 33 / 33. By hand:
    //   share[0] = quantize(1000.00000001 × 33 ÷ 99) = quantize(333.333333336…)
    //            = 333.33333334
    //   share[1] = the same                          = 333.33333334
    //   share[2] = 1000.00000001 − 666.66666668      = 333.33333333
    //   Σ = 1000.00000001 exactly
    const assetId = assetIdOf('1');
    const value = Money.fromString('1000.00000001');
    const built = buildHoldingSet({
      positions: [
        aPosition({
          assetId,
          institutionId: institutionIdOf('1'),
          quantity: Quantity.fromString('99'),
          value,
          costBasis: Money.zero(),
        }),
      ],
      allocations: [
        { walletId: walletIdOf('1'), assetId, quantity: Quantity.fromString('33') },
        { walletId: walletIdOf('2'), assetId, quantity: Quantity.fromString('33') },
      ],
      assets: [{ assetId, code: 'X', name: 'X', assetClass: 'stock', sector: null }],
    });
    if (!built.ok) throw new Error(built.error.code);

    const slices: readonly ReportHolding[] = built.value;
    expect(slices).toHaveLength(3);
    expect(slices.map((h) => h.value.toString())).toEqual([
      '333.33333334',
      '333.33333334',
      '333.33333333',
    ]);
    const summed = slices.reduce((acc, h) => acc.plus(h.value), Money.zero());
    expect(summed.equals(value)).toBe(true);
    expect(summed.toString()).toBe('1000.00000001');
  });
});
