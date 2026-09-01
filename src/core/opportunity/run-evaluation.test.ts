import { describe, expect, it } from 'vitest';
import { OpportunityNotificationId } from '@/core/shared/ids';
import { evaluateOpportunities } from '@/core/opportunity/run-evaluation';
import type { EvaluateOpportunitiesOptions } from '@/core/opportunity/run-evaluation';
import {
  aBound,
  aConsent,
  anAsset,
  aQuote,
  aRule,
  assetIdOf,
  buildFakeOpportunityDeps,
  money,
  qty,
  ruleIdOf,
  userIdOf,
} from '@/core/opportunity/test-support';

/**
 * SPEC-018 — the orchestrating use case: BR-018-03's activation, BR-018-11's
 * "zero provider requests", BR-018-21..27's notification decision wired to a
 * real send, and AR-19 idempotency under a retried job.
 *
 * TS-04/TS-05: every expected count below is worked out by hand from the
 * scenario, never copied from a first run of the function.
 */

const USER = userIdOf('1');
const ASSET = assetIdOf('1');
const ASSET_2 = assetIdOf('2');

const BASE_OPTIONS: EvaluateOpportunitiesOptions = {
  sessionOpen: true,
  cadenceMinutes: 30,
  cooldownHours: 24,
  quietHours: null,
};

function consentedDeps() {
  const deps = buildFakeOpportunityDeps('2026-03-16T13:00:00Z');
  deps.consents.seed(aConsent({ userId: USER }));
  return deps;
}

describe('BR-018-11 — zero provider requests', () => {
  it('reads quotes only through StoredQuoteReader, which cannot fetch', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('100') }]);
    deps.rules.seed(aRule({ userId: USER, assetId: ASSET, lower: aBound('30', 'buy') }));
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('35') }));

    await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    // The fake's `calls` counter is the only thing that could represent a
    // provider request in this dependency graph — there is no provider port
    // at all (see `ports.ts`/`dependencies.ts`), so this count is a proxy for
    // the acceptance criterion "evaluating rules issues zero provider
    // requests": whatever it is, it is unrelated to any budget-spending call.
    expect(deps.quotes.calls).toBe(1);
  });

  it('returns the empty summary and touches nothing when no assets are given', async () => {
    const deps = consentedDeps();
    const summary = await evaluateOpportunities(deps, USER, [], BASE_OPTIONS);
    expect(summary).toEqual({ evaluated: 0, changed: 0, claimed: 0, suppressed: 0, alerts: [] });
    expect(deps.quotes.calls).toBe(0);
  });

  it('returns the empty summary when the asset has no active rule', async () => {
    const deps = consentedDeps();
    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);
    expect(summary).toEqual({ evaluated: 0, changed: 0, claimed: 0, suppressed: 0, alerts: [] });
  });
});

describe('BR-018-03 — activation is reconciled on every pass', () => {
  it('reactivates a retained rule once the asset is held again', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        active: false,
        lower: aBound('30', 'buy'),
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('35') }));

    await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.active).toBe(true);
  });

  it('deactivates a rule whose position has closed to zero, and evaluates nothing for it', async () => {
    const deps = consentedDeps();
    // heldAssets is empty: the position is at zero.
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        active: true,
        lower: aBound('30', 'buy'),
      }),
    );

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.active).toBe(false);
    expect(summary).toEqual({ evaluated: 0, changed: 0, claimed: 0, suppressed: 0, alerts: [] });
  });
});

describe('BR-018-16 — an unknown reading is evaluated but changes nothing', () => {
  it('leaves lastState untouched and reports it in `evaluated`', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'sell',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    // No quote stored at all — StoredQuoteReader.latestFor returns nothing for ASSET.

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary).toEqual({ evaluated: 1, changed: 0, claimed: 0, suppressed: 0, alerts: [] });
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('sell'); // untouched, not overwritten with a guess
  });
});

describe('BR-018-21 — a state change with notifications enabled sends exactly one email', () => {
  it('sends when the state genuinely changed and every gate is clear', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        upper: aBound('40', 'sell'),
        defaultState: 'hold',
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET, code: 'PETR4', name: 'Petrobras PN' }));
    deps.quotes.set(ASSET, aQuote({ price: money('25'), source: 'brapi' }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary).toEqual({
      evaluated: 1,
      changed: 1,
      claimed: 1,
      suppressed: 0,
      alerts: expect.any(Array),
    });
    expect(summary.alerts).toHaveLength(1);
    expect(summary.alerts[0]).toEqual({
      assetCode: 'PETR4',
      assetName: 'Petrobras PN',
      price: money('25'),
      quotedAt: expect.any(Date),
      source: 'brapi',
      state: 'buy',
      matched: 'lower',
      threshold: money('30'),
      // BR-018-15 — the cadence this evaluation judged freshness by, so the
      // message cannot quote a different delay than the screen.
      delayMinutes: BASE_OPTIONS.cadenceMinutes,
    });
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy');
  });

  it('the first observation of a rule sends nothing and only sets the baseline', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: null,
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') })); // already below the buy threshold

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary.claimed).toBe(0);
    expect(summary.changed).toBe(0); // no prior real state to have changed from
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy');
  });

  it('a repeat evaluation producing the same state sends nothing', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'buy',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary).toEqual({ evaluated: 1, changed: 0, claimed: 0, suppressed: 0, alerts: [] });
  });
});

describe('AR-19 — idempotent under a retried job over the same quote', () => {
  it('running the evaluation twice over the same stored quote sends exactly one email', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(
      ASSET,
      aQuote({ price: money('10'), quotedAt: new Date('2026-03-16T12:45:00Z') }),
    );

    const first = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);
    const second = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(first.claimed).toBe(1);
    expect(first.alerts).toHaveLength(1);
    // lastState now equals 'buy' too, so the second pass is simply "unchanged"
    expect(second.claimed).toBe(0);
    expect(second.alerts).toHaveLength(0);
  });

  it('a very late redelivery of the same observation is caught by the log, not by cooldown', async () => {
    // The scenario the notification log exists for (DL-018-08) is narrower
    // than "any retry": a retry *inside* the cooldown window never reaches
    // the log's claim at all, because `decideNotification`'s own cooldown
    // check already refuses it first (see the test above). The log's own
    // dedup only matters for a redelivery so late the cooldown has since
    // expired — a message stuck behind an outage, say — where `lastState`
    // was never advanced (the handler crashed straight after `claim`
    // succeeded, before `recordObservation`), so `decideNotification`
    // legitimately recomputes `state_changed` a second time.
    const deps = consentedDeps();
    const quotedAt = new Date('2026-03-16T09:00:00Z');
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold', // never advanced — the simulated crash happened before this write
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10'), quotedAt }));
    // The original attempt's claim, 2 hours before `now` (2026-03-16T13:00:00Z) —
    // outside a 1-hour cooldown, so this redelivery is not blocked by it.
    await deps.notificationLog.claim({
      id: OpportunityNotificationId.generate(),
      userId: USER,
      ruleId: ruleIdOf('1'),
      state: 'buy',
      quoteObservedAt: quotedAt,
      sentAt: new Date('2026-03-16T11:00:00Z'),
    });

    const redelivery = await evaluateOpportunities(deps, USER, [ASSET], {
      ...BASE_OPTIONS,
      cooldownHours: 1,
    });

    // `decideNotification` said send — the log is what actually stopped it.
    expect(redelivery.claimed).toBe(0);
    expect(redelivery.alerts).toHaveLength(0);
    // In-app state still catches up, independent of the suppressed resend.
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy');
  });
});

describe('BR-018-22/23 — cooldown suppresses a second state change inside the window', () => {
  it('sends nothing while the in-app state still updates', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        upper: aBound('40', 'sell'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));

    // Morning: crosses the lower bound, sends.
    deps.quotes.set(
      ASSET,
      aQuote({ price: money('25'), quotedAt: new Date('2026-03-16T12:00:00Z') }),
    );
    const morning = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);
    expect(morning.claimed).toBe(1);

    // Afternoon, same day: crosses the upper bound — a genuine second
    // crossing, deliberately suppressed by BR-018-23.
    deps.quotes.set(
      ASSET,
      aQuote({ price: money('45'), quotedAt: new Date('2026-03-16T18:00:00Z') }),
    );
    const afternoon = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(afternoon).toEqual({
      evaluated: 1,
      changed: 1,
      claimed: 0,
      suppressed: 1,
      alerts: [],
    });
    // In-app state is current regardless of the suppressed email.
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('sell');
  });
});

describe('BR-018-25 — consent gates the send, not the in-app state', () => {
  it('sends no email when the user has never granted email_reminders', async () => {
    const deps = buildFakeOpportunityDeps('2026-03-16T13:00:00Z'); // no consent seeded at all
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary).toEqual({ evaluated: 1, changed: 1, claimed: 0, suppressed: 1, alerts: [] });
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy'); // in-app state still updates
  });

  it('sends no email when consent was granted but never activated (grantedAt null)', async () => {
    const deps = buildFakeOpportunityDeps('2026-03-16T13:00:00Z');
    deps.consents.seed(aConsent({ userId: USER, grantedAt: null }));
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);
    expect(summary.claimed).toBe(0);
    expect(summary.suppressed).toBe(1);
  });

  it('sends no email once consent has been revoked', async () => {
    const deps = buildFakeOpportunityDeps('2026-03-16T13:00:00Z');
    deps.consents.seed(aConsent({ userId: USER, revokedAt: new Date('2026-02-01T00:00:00Z') }));
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);
    expect(summary.claimed).toBe(0);
    expect(summary.suppressed).toBe(1);
  });
});

describe('BR-018-26 — per-asset mute suppresses only the email', () => {
  it('updates the in-app state and sends nothing while muted', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
        muted: true,
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary).toEqual({ evaluated: 1, changed: 1, claimed: 0, suppressed: 1, alerts: [] });
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy');
  });
});

describe('BR-018-27 — quiet hours suppress the send', () => {
  it('sends nothing inside the configured window', async () => {
    const deps = consentedDeps(); // clock defaults to 2026-03-16T13:00:00Z = 10:00 São Paulo
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], {
      ...BASE_OPTIONS,
      quietHours: { start: '09:00', end: '11:00' },
    });

    expect(summary.claimed).toBe(0);
    expect(summary.suppressed).toBe(1);
  });
});

describe('an asset missing from the catalog is skipped defensively', () => {
  it('does not send and does not throw', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([{ assetId: ASSET, assetClass: 'stock', quantity: qty('10') }]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    // Deliberately not added to deps.catalog.
    deps.quotes.set(ASSET, aQuote({ price: money('10') }));

    const summary = await evaluateOpportunities(deps, USER, [ASSET], BASE_OPTIONS);

    expect(summary.claimed).toBe(0);
    expect(summary.alerts).toHaveLength(0);
    // The observation is still persisted — the gap is in the catalog, not in evaluation.
    const reloaded = await deps.rules.findByAsset(ASSET);
    expect(reloaded?.lastState).toBe('buy');
  });
});

describe('evaluates several rules across several assets in one pass', () => {
  it('reports independent per-rule outcomes in one summary', async () => {
    const deps = consentedDeps();
    deps.heldAssets.set([
      { assetId: ASSET, assetClass: 'stock', quantity: qty('10') },
      { assetId: ASSET_2, assetClass: 'fii', quantity: qty('20') },
    ]);
    deps.rules.seed(
      aRule({
        id: ruleIdOf('1'),
        userId: USER,
        assetId: ASSET,
        lower: aBound('30', 'buy'),
        lastState: 'hold',
      }),
    );
    deps.rules.seed(
      aRule({
        id: ruleIdOf('2'),
        userId: USER,
        assetId: ASSET_2,
        lower: aBound('100', 'buy'),
        lastState: 'buy', // already at buy — this one is a repeat, not a change
      }),
    );
    deps.catalog.add(anAsset({ id: ASSET, code: 'PETR4' }));
    deps.catalog.add(anAsset({ id: ASSET_2, code: 'HGLG11' }));
    deps.quotes.set(ASSET, aQuote({ price: money('10') })); // crosses -> buy (changed)
    deps.quotes.set(ASSET_2, aQuote({ price: money('50') })); // stays buy (unchanged)

    const summary = await evaluateOpportunities(deps, USER, [ASSET, ASSET_2], BASE_OPTIONS);

    expect(summary).toEqual({
      evaluated: 2,
      changed: 1,
      claimed: 1,
      suppressed: 0,
      alerts: expect.any(Array),
    });
  });
});
