import { resolveConfig } from '@/config/resolve';
import { SystemClock, type Clock } from '@/core/shared/clock';
import type { AssetId, OpportunityRuleId, UserId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { evaluateRule, type EvaluatedResult } from '@/core/opportunity/evaluate';
import type { EvaluatedState, OpportunityBound, OpportunityState } from '@/core/opportunity/ports';

import { canCarryRule } from '@/core/opportunity/rule';
import type { AssetClass } from '@/core/quotes/ports';
import { previousTradingDay } from '@/core/quotes/staleness';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { buildWatchDeps } from '@/app/(app)/watch/composition';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';

/**
 * SPEC-018 — the read model behind the watch rules (`/settings/watch`) and the Painel card, in the shape of
 * `src/app/(app)/wallets/data.ts`. AR-31: the page (a Server Component) calls
 * `loadWatchView` directly; nothing here decides anything `core/opportunity`
 * hasn't already decided — `evaluateRule` and `canCarryRule` are called, not
 * reimplemented (AR-35).
 *
 * Everything below stays a Server Component prop, never a server-action
 * return value or a Client Component prop, so `Money`/`Date` cross no JSON
 * boundary here (the hazard AR-06–AR-10 name) — the same reasoning
 * `goals-data.ts#loadGoalsView` gives for handing `WalletGoal` (which also
 * carries `Money`) straight to its page.
 */

export interface WatchRuleRow {
  readonly assetId: AssetId;
  readonly ruleId: OpportunityRuleId;
  readonly code: string;
  readonly name: string;
  readonly lower: OpportunityBound | null;
  readonly upper: OpportunityBound | null;
  readonly defaultState: OpportunityState;
  readonly muted: boolean;
  /** BR-018-12/16 — the same `evaluateRule` the worker's evaluation pass uses, over the same stored quote (BR-018-14). */
  readonly evaluatedState: EvaluatedState;
  /** `null` exactly when `evaluatedState` is `'unknown'` or the default band matched — see `evaluate.ts`'s own doc comment. */
  readonly matched: 'lower' | 'upper' | 'default' | null;
  readonly threshold: Money | null;
  readonly currentPrice: Money | null;
  readonly quotedAt: Date | null;
  readonly source: string | null;
  /** BR-018-20/23 — the last time an email actually went out for this rule, or `null` if none ever has. */
  readonly lastEmailSentAt: Date | null;
}

export interface WatchAvailableAsset {
  readonly assetId: AssetId;
  readonly code: string;
  readonly name: string;
}

export interface WatchIneligibleAsset {
  readonly assetId: AssetId;
  readonly code: string;
  readonly name: string;
  readonly assetClass: AssetClass;
}

/**
 * BR-018-03 — a rule whose position closed to zero. Retained, not deleted,
 * and reactivated automatically on a rebuy; it evaluates nothing and sends
 * nothing while it sits here.
 *
 * It gets its own list rather than being folded into `watched` because it has
 * no current price, no state and no holding behind it — everything
 * `WatchRuleRow` exists to carry. Leaving it out of the view altogether (as
 * this file first did) made it unreachable: a user could neither see the
 * thresholds still on file nor delete them, and would meet them again months
 * later as an email about a rule they could not have removed.
 */
export interface WatchRetainedRule {
  readonly assetId: AssetId;
  readonly ruleId: OpportunityRuleId;
  readonly code: string;
  readonly name: string;
  readonly lower: OpportunityBound | null;
  readonly upper: OpportunityBound | null;
  readonly defaultState: OpportunityState;
}

export interface WatchView {
  /** BR-018-01/02/20 — held, eligible, already has a rule. */
  readonly watched: readonly WatchRuleRow[];
  /** Held, eligible, no rule yet — the assets a "create a rule" form may target (BR-018-01/02). */
  readonly available: readonly WatchAvailableAsset[];
  /** Held, but no market price to watch (BR-018-02) — CDB, LCI, LCA. */
  readonly ineligible: readonly WatchIneligibleAsset[];
  /** BR-018-03 — rules kept through a closed position, paused rather than deleted. */
  readonly retained: readonly WatchRetainedRule[];
  /** BR-018-15/19 — the same `quotes.cadence_minutes` SPEC-008 polls at, for the delay disclosure. */
  readonly delayMinutes: number;
  /** BR-018-25/26 — whether `email_reminders` is currently granted, so the page can point at `/privacy` rather than imply email is on when it is off. */
  readonly emailConsented: boolean;
}

export async function loadWatchView(userId: UserId): Promise<WatchView> {
  const clock = new SystemClock();
  const calendar = new B3TradingCalendar();
  const now = clock.now();
  const sessionOpen = calendar.isSessionOpen(now);
  // BR-018-16's daily-tier floor, from the same calendar `opportunity.evaluate`
  // reads — so this screen and the job cannot disagree about whether a
  // published close is still current.
  const dailyQuoteFloor = previousTradingDay((date) => calendar.isTradingDay(date), clock.today());

  return withTenant(
    userId,
    async (tx) => {
      const deps = buildWatchDeps(tx, userId);

      const [held, allRules, cadenceCfg, consent] = await Promise.all([
        deps.heldAssets.listHeld(),
        deps.rules.listAll(),
        // BR-018-14: the exact key SPEC-008 polls at — reading a second,
        // feature-local cadence would let this screen disagree with the
        // worker about whether a quote is stale (BR-018-16).
        resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
        deps.consents.findByPurpose(userId, 'email_reminders'),
      ]);

      // BR-018-01: "non-zero position" — a closed-out lot is not a holding.
      const heldNonZero = held.filter((row) => !row.quantity.isZero());
      const ruleByAsset = new Map(allRules.map((rule) => [rule.assetId, rule]));

      const relevantAssetIds = [
        ...new Set([
          ...heldNonZero.map((row) => row.assetId),
          ...allRules.map((rule) => rule.assetId),
        ]),
      ];
      const ruleIds = allRules.map((rule) => rule.id);

      const [assets, quotesByAsset, lastSentByRule] = await Promise.all([
        deps.catalog.findByIds(relevantAssetIds),
        deps.quotes.latestFor(relevantAssetIds),
        deps.notificationLog.lastSentAtByRule(ruleIds),
      ]);
      const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

      const watched: WatchRuleRow[] = [];
      const available: WatchAvailableAsset[] = [];
      const ineligible: WatchIneligibleAsset[] = [];
      const retained: WatchRetainedRule[] = [];
      const heldAssetIds = new Set(heldNonZero.map((row) => row.assetId));

      for (const holding of heldNonZero) {
        const asset = assetsById.get(holding.assetId);
        const code = asset?.code ?? '—';
        const name = asset?.name ?? '—';
        const rule = ruleByAsset.get(holding.assetId);

        if (rule !== undefined) {
          const quote = quotesByAsset.get(holding.assetId) ?? null;
          const evaluated = evaluateRule(rule, quote, {
            sessionOpen,
            cadenceMinutes: cadenceCfg.value,
            now,
            dailyQuoteFloor,
          });

          watched.push({
            assetId: holding.assetId,
            ruleId: rule.id,
            code,
            name,
            lower: rule.lower,
            upper: rule.upper,
            defaultState: rule.defaultState,
            muted: rule.muted,
            evaluatedState: evaluated.state,
            matched: evaluated.state === 'unknown' ? null : evaluated.matched,
            threshold: evaluated.state === 'unknown' ? null : evaluated.threshold,
            currentPrice: quote?.price ?? null,
            quotedAt: quote?.quotedAt ?? null,
            source: quote?.source ?? null,
            lastEmailSentAt: lastSentByRule.get(rule.id) ?? null,
          });
        } else if (canCarryRule(holding.assetClass, holding.quantity)) {
          available.push({ assetId: holding.assetId, code, name });
        } else {
          ineligible.push({ assetId: holding.assetId, code, name, assetClass: holding.assetClass });
        }
      }

      // BR-018-03 — every rule on an asset this user no longer holds. Read
      // from `allRules` rather than from the holdings loop above, which by
      // construction can only see assets that *are* held.
      for (const rule of allRules) {
        if (heldAssetIds.has(rule.assetId)) continue;
        const asset = assetsById.get(rule.assetId);
        retained.push({
          assetId: rule.assetId,
          ruleId: rule.id,
          code: asset?.code ?? '—',
          name: asset?.name ?? '—',
          lower: rule.lower,
          upper: rule.upper,
          defaultState: rule.defaultState,
        });
      }

      return {
        watched,
        available,
        ineligible,
        retained,
        delayMinutes: cadenceCfg.value,
        emailConsented:
          consent !== null && consent.grantedAt !== null && consent.revokedAt === null,
      };
    },
    db,
  );
}

/**
 * Every rule on an asset the user holds now, evaluated (BR-018-12/16) — the
 * one read behind both the Composição badge and the Painel's watch-state card.
 *
 * Narrower than `loadWatchView` above: that function also builds the
 * "available" and "ineligible" lists, resolves consent and reads the
 * notification log, none of which a badge or a card needs. It reuses the same
 * `evaluateRule` over the same stored quote and the same
 * `quotes.cadence_minutes`, which is what BR-018-14 requires — no two screens
 * can disagree about a state, because none of them decides one.
 *
 * **Reads only.** `latest_quotes` is what `quotes.poll` last wrote; nothing on
 * this path can reach a provider (BR-018-11), so a render adds nothing to the
 * request budget (#212's integration test holds the counter to that).
 *
 * Rules whose position has closed are excluded (BR-018-03: they are
 * deactivated and retained), so a holding that no longer exists cannot put a
 * badge on a row, or a line on the Painel, that no longer exists either.
 */
async function evaluateHeldRules(userId: UserId, clock: Clock): Promise<HeldRuleEvaluations> {
  const calendar = new B3TradingCalendar();
  const now = clock.now();
  const sessionOpen = calendar.isSessionOpen(now);
  const dailyQuoteFloor = previousTradingDay((date) => calendar.isTradingDay(date), clock.today());

  return withTenant(
    userId,
    async (tx) => {
      const deps = buildWatchDeps(tx, userId);
      const [rules, held, cadenceCfg] = await Promise.all([
        deps.rules.listAll(),
        deps.heldAssets.listHeld(),
        resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
      ]);

      /*
       * BR-018-14 — **held, not `active`**, and the difference is a bug this
       * once had. `active` is only flipped back by `reconcileActivation`
       * inside an evaluation pass, and a pass runs only when `quotes.poll`
       * actually writes a quote. So between rebuying an asset and the next
       * cadence window — every evening, every weekend — a rule was `active:
       * false` on a position the user genuinely holds. The rules screen
       * rendered its state (it filters on the holding) and the badge rendered
       * nothing, which is exactly the "two screens disagreeing about one
       * asset" that rule exists to forbid. Every reader now asks the same
       * question of the same data, so none can wait on a job to agree.
       */
      const heldAssetIds = new Set(
        held.filter((row) => !row.quantity.isZero()).map((row) => row.assetId),
      );
      const active = rules.filter((rule) => heldAssetIds.has(rule.assetId));
      if (active.length === 0) return { ruleCount: rules.length, rows: [] };

      const assetIds = active.map((rule) => rule.assetId);
      const [quotesByAsset, assets] = await Promise.all([
        deps.quotes.latestFor(assetIds),
        deps.catalog.findByIds(assetIds),
      ]);
      const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

      const rows = active.map((rule) => {
        const quote = quotesByAsset.get(rule.assetId) ?? null;
        const asset = assetsById.get(rule.assetId);
        return {
          assetId: rule.assetId,
          code: asset?.code ?? '—',
          name: asset?.name ?? '—',
          evaluated: evaluateRule(rule, quote, {
            sessionOpen,
            cadenceMinutes: cadenceCfg.value,
            now,
            dailyQuoteFloor,
          }),
        };
      });
      return { ruleCount: rules.length, rows };
    },
    db,
  );
}

interface HeldRuleEvaluations {
  /** Every rule the user has, retained ones included (BR-018-03). */
  readonly ruleCount: number;
  readonly rows: readonly HeldRuleEvaluation[];
}

interface HeldRuleEvaluation {
  readonly assetId: AssetId;
  readonly code: string;
  readonly name: string;
  readonly evaluated: EvaluatedResult;
}

/**
 * SPEC-018 BR-018-19 — the same states the rules screen shows, keyed by asset,
 * for the badge in the Composição holdings list.
 */
export async function loadWatchStates(
  userId: UserId,
  clock: Clock = new SystemClock(),
): Promise<ReadonlyMap<AssetId, EvaluatedState>> {
  const { rows } = await evaluateHeldRules(userId, clock);
  return new Map(rows.map((row) => [row.assetId, row.evaluated.state]));
}

/** One line of the Painel's watch-state card: a held asset in a buy or sell state. */
export interface WatchOpportunity {
  readonly assetId: AssetId;
  readonly code: string;
  readonly name: string;
  readonly state: 'buy' | 'sell';
  /** Which band matched — the card names the user's own bound (BR-018-18). */
  readonly matched: 'lower' | 'upper' | 'default';
  /** `null` exactly when the default band matched. */
  readonly threshold: Money | null;
  /** The stored quote the state was read from (BR-018-14). */
  readonly price: Money;
}

export interface WatchOpportunities {
  /**
   * Whether the user has any rule at all, a retained one included — "you have
   * no rules" is false for someone whose only rule is paused (BR-018-03).
   */
  readonly hasRules: boolean;
  /** BR-022-07 — buy and sell only, by asset code. Hold is not news. */
  readonly items: readonly WatchOpportunity[];
  /**
   * BR-018-16 — held rules with no usable quote. They are not listed, but the
   * card says how many there are: "nothing is in buy or sell" is not a claim
   * a missing price can support.
   */
  readonly unknownCount: number;
}

/**
 * SPEC-022 BR-022-07 — the Painel's card listing held assets currently in a
 * buy or sell state (SPEC-018). It reads the existing evaluation and adds
 * nothing to it: no state is decided here, and no quote is requested.
 */
export async function loadWatchOpportunities(
  userId: UserId,
  clock: Clock = new SystemClock(),
): Promise<WatchOpportunities> {
  const { ruleCount, rows } = await evaluateHeldRules(userId, clock);
  const items: WatchOpportunity[] = [];
  let unknownCount = 0;
  for (const row of rows) {
    const { evaluated } = row;
    if (evaluated.state === 'unknown') {
      unknownCount += 1;
      continue;
    }
    if (evaluated.state === 'hold') continue;
    items.push({
      assetId: row.assetId,
      code: row.code,
      name: row.name,
      state: evaluated.state,
      matched: evaluated.matched,
      threshold: evaluated.threshold,
      price: evaluated.quote.price,
    });
  }
  items.sort((a, b) => a.code.localeCompare(b.code, 'pt-BR'));
  return { hasRules: ruleCount > 0, items, unknownCount };
}
