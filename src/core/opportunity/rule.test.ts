import { describe, expect, it } from 'vitest';
import { Quantity } from '@/core/shared/money';
import { OPPORTUNITY_STATES } from '@/core/opportunity/ports';
import { OpportunityErrorCode } from '@/core/opportunity/errors';
import {
  WATCHABLE_ASSET_CLASSES,
  canCarryRule,
  createRule,
  reconcileActivation,
  updateRule,
} from '@/core/opportunity/rule';
import {
  aBound,
  aRule,
  assetIdOf,
  buildFakeOpportunityDeps,
  qty,
  ruleIdOf,
  userIdOf,
} from '@/core/opportunity/test-support';

/**
 * SPEC-018 BR-018-01..10 — eligibility, the rule model and BR-018-03's
 * activation.
 *
 * TS-04/TS-05: every expected value below is written as a literal and
 * hand-reasoned against the business rule cited, never against what the
 * function under test happens to return.
 */

const USER = userIdOf('1');
const OTHER_USER = userIdOf('2');
const ASSET = assetIdOf('1');

describe('BR-018-06 — OPPORTUNITY_STATES', () => {
  it('names exactly buy, hold and sell', () => {
    expect(OPPORTUNITY_STATES).toEqual(['buy', 'hold', 'sell']);
  });
});

describe('BR-018-02 — canCarryRule / WATCHABLE_ASSET_CLASSES', () => {
  it('names the five classes with an observable market price, and no others', () => {
    expect(WATCHABLE_ASSET_CLASSES).toEqual(['stock', 'fii', 'bdr', 'etf', 'tesouro_direto']);
  });

  it.each(['stock', 'fii', 'bdr', 'etf', 'tesouro_direto'] as const)(
    'allows %s when the position is non-zero',
    (assetClass) => {
      expect(canCarryRule(assetClass, qty('10'))).toBe(true);
    },
  );

  it.each(['cdb', 'lci', 'lca'] as const)('refuses %s regardless of position', (assetClass) => {
    expect(canCarryRule(assetClass, qty('10'))).toBe(false);
  });

  it('refuses a watchable class held at zero (BR-018-01)', () => {
    expect(canCarryRule('stock', Quantity.zero())).toBe(false);
  });
});

describe('BR-018-01/02 — createRule eligibility', () => {
  it('refuses an asset the user does not hold', async () => {
    const deps = buildFakeOpportunityDeps();
    // heldAssets is empty — ASSET is not held.
    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('30', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(OpportunityErrorCode.ASSET_NOT_HELD);
      expect(result.error.context.assetId).toBe(ASSET);
    }
  });

  it('refuses an asset held at exactly zero', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: Quantity.zero() }]);
    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('30', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.ASSET_NOT_HELD);
  });

  it('refuses CDB — no market price to watch (BR-018-02)', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'cdb', quantity: qty('1000') }]);
    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('30', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(OpportunityErrorCode.ASSET_CLASS_NOT_WATCHABLE);
      expect(result.error.context.assetClass).toBe('cdb');
    }
  });

  it('refuses a second rule on an asset that already has one', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    deps.rules.seed(aRule({ userId: USER, assetId: ASSET }));

    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('30', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.RULE_ALREADY_EXISTS);
  });

  it('creates an active rule, defaulting to hold and unmuted', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);

    const result = await createRule(deps, USER, {
      assetId: ASSET,
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.defaultState).toBe('hold');
      expect(result.value.active).toBe(true);
      expect(result.value.muted).toBe(false);
      expect(result.value.lastState).toBeNull();
      expect(result.value.lastEvaluatedAt).toBeNull();
      expect(await deps.rules.findByAsset(ASSET)).toEqual(result.value);
    }
  });

  it('accepts a caller-chosen default state', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'etf', quantity: qty('5') }]);

    const result = await createRule(deps, USER, {
      assetId: ASSET,
      lower: aBound('30', 'buy'),
      defaultState: 'sell',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.defaultState).toBe('sell');
  });
});

describe('BR-018-05/08/10 — bound validation, shared by create and update', () => {
  it('refuses a rule with neither bound set', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, { assetId: ASSET });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.NO_BOUNDS_SET);
  });

  it('accepts a rule with only a lower bound', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('30', 'buy') });
    expect(result.ok).toBe(true);
  });

  it('accepts a rule with only an upper bound', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, { assetId: ASSET, upper: aBound('40', 'sell') });
    expect(result.ok).toBe(true);
  });

  it('refuses a non-positive lower threshold', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, { assetId: ASSET, lower: aBound('0', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(OpportunityErrorCode.INVALID_THRESHOLD);
      expect(result.error.context.bound).toBe('lower');
    }
  });

  it('refuses a non-positive upper threshold', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, { assetId: ASSET, upper: aBound('-5', 'sell') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(OpportunityErrorCode.INVALID_THRESHOLD);
      expect(result.error.context.bound).toBe('upper');
    }
  });

  it('refuses a lower bound equal to the upper bound (no overlap, BR-018-08)', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, {
      assetId: ASSET,
      lower: aBound('30', 'buy'),
      upper: aBound('30', 'sell'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.LOWER_NOT_BELOW_UPPER);
  });

  it('refuses a lower bound above the upper bound', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const result = await createRule(deps, USER, {
      assetId: ASSET,
      lower: aBound('50', 'buy'),
      upper: aBound('40', 'sell'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.LOWER_NOT_BELOW_UPPER);
  });

  it('"below R$ 30 = buy" and "below R$ 30 = sell" both express and produce opposite states', async () => {
    const buyDeps = buildFakeOpportunityDeps();
    buyDeps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const buyResult = await createRule(buyDeps, USER, {
      assetId: ASSET,
      lower: aBound('30', 'buy'),
    });

    const sellDeps = buildFakeOpportunityDeps();
    sellDeps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    const sellResult = await createRule(sellDeps, USER, {
      assetId: ASSET,
      lower: aBound('30', 'sell'),
    });

    expect(buyResult.ok && buyResult.value.lower?.state).toBe('buy');
    expect(sellResult.ok && sellResult.value.lower?.state).toBe('sell');
  });
});

describe('updateRule — keyed by assetId, not the rule id', () => {
  it('refuses when no rule exists on the asset', async () => {
    const deps = buildFakeOpportunityDeps();
    const result = await updateRule(deps, USER, { assetId: ASSET, defaultState: 'sell' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.RULE_NOT_FOUND);
  });

  it("refuses another user's rule (ownership, defence in depth over RLS)", async () => {
    const deps = buildFakeOpportunityDeps();
    deps.rules.seed(aRule({ userId: OTHER_USER, assetId: ASSET }));
    const result = await updateRule(deps, USER, { assetId: ASSET, defaultState: 'sell' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.RULE_NOT_FOUND);
  });

  it('leaves an omitted bound untouched', async () => {
    const deps = buildFakeOpportunityDeps();
    const existing = aRule({
      userId: USER,
      assetId: ASSET,
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
    });
    deps.rules.seed(existing);

    const result = await updateRule(deps, USER, { assetId: ASSET, defaultState: 'sell' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lower).toEqual(existing.lower);
      expect(result.value.upper).toEqual(existing.upper);
      expect(result.value.defaultState).toBe('sell');
    }
  });

  it('clears a bound when explicitly set to null', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.rules.seed(
      aRule({
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        upper: aBound('40', 'sell'),
      }),
    );

    const result = await updateRule(deps, USER, { assetId: ASSET, upper: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lower).not.toBeNull();
      expect(result.value.upper).toBeNull();
    }
  });

  it('refuses clearing the only remaining bound (still needs at least one)', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.rules.seed(
      aRule({ userId: USER, assetId: ASSET, lower: aBound('30', 'buy'), upper: null }),
    );
    const result = await updateRule(deps, USER, { assetId: ASSET, lower: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.NO_BOUNDS_SET);
  });

  it('replaces a bound with a new threshold and state', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.rules.seed(
      aRule({
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        upper: aBound('40', 'sell'),
      }),
    );
    const result = await updateRule(deps, USER, { assetId: ASSET, lower: aBound('25', 'hold') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lower?.price.toString()).toBe('25');
      expect(result.value.lower?.state).toBe('hold');
    }
  });

  it('re-validates the merged bounds — a new lower cannot cross the existing upper', async () => {
    const deps = buildFakeOpportunityDeps();
    deps.rules.seed(
      aRule({
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        upper: aBound('40', 'sell'),
      }),
    );
    const result = await updateRule(deps, USER, { assetId: ASSET, lower: aBound('45', 'buy') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(OpportunityErrorCode.LOWER_NOT_BELOW_UPPER);
  });

  it('toggles mute without touching bounds (BR-018-26)', async () => {
    const deps = buildFakeOpportunityDeps();
    const existing = aRule({ userId: USER, assetId: ASSET, muted: false });
    deps.rules.seed(existing);
    const result = await updateRule(deps, USER, { assetId: ASSET, muted: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.muted).toBe(true);
      expect(result.value.lower).toEqual(existing.lower);
    }
  });
});

describe('BR-018-03 — reconcileActivation is pure and recomputed, never hooked', () => {
  it('activates a retained, inactive rule whose asset is held again', () => {
    const rule = aRule({ id: ruleIdOf('1'), assetId: ASSET, active: false });
    const { activate, deactivate } = reconcileActivation([rule], new Set([ASSET]));
    expect(activate).toEqual([rule.id]);
    expect(deactivate).toEqual([]);
  });

  it('deactivates an active rule whose position closed to zero', () => {
    const rule = aRule({ id: ruleIdOf('1'), assetId: ASSET, active: true });
    const { activate, deactivate } = reconcileActivation([rule], new Set());
    expect(activate).toEqual([]);
    expect(deactivate).toEqual([rule.id]);
  });

  it('leaves an active-and-held rule alone', () => {
    const rule = aRule({ id: ruleIdOf('1'), assetId: ASSET, active: true });
    const { activate, deactivate } = reconcileActivation([rule], new Set([ASSET]));
    expect(activate).toEqual([]);
    expect(deactivate).toEqual([]);
  });

  it('leaves an inactive-and-unheld rule alone (retained, not reactivated)', () => {
    const rule = aRule({ id: ruleIdOf('1'), assetId: ASSET, active: false });
    const { activate, deactivate } = reconcileActivation([rule], new Set());
    expect(activate).toEqual([]);
    expect(deactivate).toEqual([]);
  });
});
