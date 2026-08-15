import { describe, expect, it } from 'vitest';
import { aggregate, buildHoldingSet, totalsOf } from '@/core/reporting/base-query';
import { applyScope, isEmptyScope, resolveScope } from '@/core/reporting/scope';
import { ReportingErrorCode, type ReportWallet } from '@/core/reporting/ports';
import {
  aHolding,
  anAsset,
  aPosition,
  assetIdOf,
  institutionIdOf,
  money,
  qty,
  walletIdOf,
} from '@/core/reporting/test-support';

/**
 * SPEC-011 BR-011-02 / AC-3 — "scoping to a wallet excludes all other holdings
 * from every figure on every report."
 */

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

const walletA = walletIdOf('1');
const walletB = walletIdOf('2');

describe('applyScope — BR-011-02', () => {
  const holdings = [
    aHolding({ walletId: walletA, value: money('600') }),
    aHolding({ walletId: walletB, value: money('300') }),
    aHolding({ walletId: null, value: money('100') }),
  ];

  it('portfolio scope includes everything, allocated and unallocated alike', () => {
    expect(applyScope(holdings, { kind: 'portfolio' })).toHaveLength(3);
    expect(totalsOf(applyScope(holdings, { kind: 'portfolio' })).value.toString()).toBe('1000');
  });

  it('wallet scope excludes every other wallet', () => {
    const scoped = applyScope(holdings, { kind: 'wallet', walletId: walletA });
    expect(scoped).toHaveLength(1);
    expect(totalsOf(scoped).value.toString()).toBe('600');
  });

  it('wallet scope excludes the unallocated remainder', () => {
    // Unassigned is a GROUP at portfolio scope (BR-011-09), not a member of
    // any wallet — nothing in it has been filed anywhere.
    const scoped = applyScope(holdings, { kind: 'wallet', walletId: walletB });
    expect(scoped.every((h) => h.walletId === walletB)).toBe(true);
    expect(totalsOf(scoped).value.toString()).toBe('300');
  });

  it('an empty wallet yields no holdings rather than an error', () => {
    expect(applyScope(holdings, { kind: 'wallet', walletId: walletIdOf('9') })).toEqual([]);
  });
});

describe('wallet scope uses ALLOCATED quantities, never full positions', () => {
  const itsa = assetIdOf('1');

  it('a 60/40 split shows 60 in one wallet and 40 in the other, not 100 in both', () => {
    // THE rule that is easiest to get quietly wrong. 100 ITSA4 worth R$ 1000,
    // split 60 to wallet A and 40 to wallet B.
    //   A → quantity 60, value 1000 × 60/100 = 600
    //   B → quantity 40, value 1000 − 600    = 400
    // A report that scoped by "which assets does this wallet touch" and then
    // valued the whole position would show 100 and R$ 1000 in BOTH, and the
    // portfolio would appear to be 200% of itself.
    const holdings = unwrap(
      buildHoldingSet({
        positions: [
          aPosition({
            assetId: itsa,
            quantity: qty('100'),
            value: money('1000'),
            costBasis: money('800'),
          }),
        ],
        allocations: [
          { walletId: walletA, assetId: itsa, quantity: qty('60') },
          { walletId: walletB, assetId: itsa, quantity: qty('40') },
        ],
        assets: [anAsset({ assetId: itsa, code: 'ITSA4' })],
      }),
    );

    const inA = totalsOf(applyScope(holdings, { kind: 'wallet', walletId: walletA }));
    const inB = totalsOf(applyScope(holdings, { kind: 'wallet', walletId: walletB }));

    expect(inA.quantity.toString()).toBe('60');
    expect(inA.value.toString()).toBe('600');
    expect(inA.costBasis.toString()).toBe('480'); // 800 × 60/100
    expect(inB.quantity.toString()).toBe('40');
    expect(inB.value.toString()).toBe('400');
    expect(inB.costBasis.toString()).toBe('320'); // 800 − 480

    // The two wallets sum to the whole position and no more.
    expect(inA.value.plus(inB.value).toString()).toBe('1000');
  });

  it('a partly-unallocated asset gives the wallet only its own slice', () => {
    // 100 held, only 25 allocated to A. A sees 25 / R$ 250, and the remaining
    // 75 / R$ 750 sits in Unassigned at portfolio scope.
    const holdings = unwrap(
      buildHoldingSet({
        positions: [aPosition({ assetId: itsa, quantity: qty('100'), value: money('1000') })],
        allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('25') }],
        assets: [anAsset({ assetId: itsa })],
      }),
    );

    expect(
      totalsOf(applyScope(holdings, { kind: 'wallet', walletId: walletA })).value.toString(),
    ).toBe('250');
    const byWallet = aggregate(holdings, 'wallet');
    expect(byWallet.groups.find((g) => g.key.synthetic)!.totals.value.toString()).toBe('750');
    expect(byWallet.total.value.toString()).toBe('1000');
  });

  it('a wallet scope can still be grouped by asset class — the controls are independent', () => {
    // DL-011-01: "this wallet, broken down by asset class" is exactly the
    // question a combined "view by" control could not express.
    const stock = assetIdOf('1');
    const fii = assetIdOf('2');
    const holdings = unwrap(
      buildHoldingSet({
        positions: [
          aPosition({ assetId: stock, quantity: qty('100'), value: money('1000') }),
          aPosition({ assetId: fii, quantity: qty('50'), value: money('500') }),
        ],
        allocations: [
          { walletId: walletA, assetId: stock, quantity: qty('60') },
          { walletId: walletA, assetId: fii, quantity: qty('50') },
        ],
        assets: [
          anAsset({ assetId: stock, code: 'ITSA4', assetClass: 'stock' }),
          anAsset({ assetId: fii, code: 'HGLG11', assetClass: 'fii' }),
        ],
      }),
    );

    // Inside wallet A: 60 of the stock (600) and all 50 of the FII (500).
    const scoped = applyScope(holdings, { kind: 'wallet', walletId: walletA });
    const report = aggregate(scoped, 'asset_class');
    expect(report.groups.map((g) => g.key.id)).toEqual(['fii', 'stock']);
    expect(report.groups.find((g) => g.key.id === 'stock')!.totals.value.toString()).toBe('600');
    expect(report.groups.find((g) => g.key.id === 'fii')!.totals.value.toString()).toBe('500');
    expect(report.total.value.toString()).toBe('1100');
  });
});

describe('resolveScope — BR-011-02', () => {
  const wallet: ReportWallet = { walletId: walletA, name: 'Aposentadoria' };
  const find = async (id: string) => (id === walletA ? wallet : null);

  it('resolves portfolio scope without a lookup', async () => {
    let called = false;
    const result = await resolveScope({ kind: 'portfolio' }, async () => {
      called = true;
      return null;
    });
    expect(unwrap(result)).toEqual({ scope: { kind: 'portfolio' }, wallet: null });
    expect(called).toBe(false);
  });

  it('resolves a wallet scope and carries the wallet name', async () => {
    const result = await resolveScope({ kind: 'wallet', walletId: walletA }, find);
    expect(unwrap(result).wallet).toEqual(wallet);
  });

  it('refuses a wallet the tenant does not have, rather than widening to the portfolio', async () => {
    // A bookmark outlives the wallet it names. Falling back to the portfolio
    // would show someone their entire patrimônio under a one-wallet heading —
    // every figure real, every one answering a different question.
    const result = await resolveScope({ kind: 'wallet', walletId: walletB }, find);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.WALLET_NOT_FOUND);
    expect(result.error.context.walletId).toBe(walletB);
  });
});

describe('isEmptyScope — BR-011-16 / AC-14', () => {
  it('is true when the scope contains no holdings at all', () => {
    expect(isEmptyScope([])).toBe(true);
  });

  it('is false when holdings exist but are currently worth nothing', () => {
    // The distinction the rule turns on. Both render R$ 0,00; only the first
    // means "there is nothing here yet". Showing the empty state for the
    // second would be as wrong as showing a zero for the first.
    expect(isEmptyScope([aHolding({ value: money('0'), quantity: qty('0') })])).toBe(false);
  });

  it('reports an empty wallet as empty after scoping', () => {
    const holdings = [aHolding({ walletId: walletA, institutionId: institutionIdOf('1') })];
    expect(isEmptyScope(applyScope(holdings, { kind: 'wallet', walletId: walletB }))).toBe(true);
    expect(isEmptyScope(applyScope(holdings, { kind: 'wallet', walletId: walletA }))).toBe(false);
  });
});
