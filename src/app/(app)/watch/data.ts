import { resolveConfig } from '@/config/resolve';
import { SystemClock } from '@/core/shared/clock';
import type { AssetId, OpportunityRuleId, UserId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { evaluateRule } from '@/core/opportunity/evaluate';
import type { EvaluatedState, OpportunityBound, OpportunityState } from '@/core/opportunity/ports';
import { canCarryRule } from '@/core/opportunity/rule';
import type { AssetClass } from '@/core/quotes/ports';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { buildWatchDeps } from '@/app/(app)/watch/composition';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';

/**
 * SPEC-018 — the read model behind `/watch`, in the shape of
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

export interface WatchView {
  /** BR-018-01/02/20 — held, eligible, already has a rule. */
  readonly watched: readonly WatchRuleRow[];
  /** Held, eligible, no rule yet — the assets a "create a rule" form may target (BR-018-01/02). */
  readonly available: readonly WatchAvailableAsset[];
  /** Held, but no market price to watch (BR-018-02) — CDB, LCI, LCA. */
  readonly ineligible: readonly WatchIneligibleAsset[];
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

      return {
        watched,
        available,
        ineligible,
        delayMinutes: cadenceCfg.value,
        emailConsented:
          consent !== null && consent.grantedAt !== null && consent.revokedAt === null,
      };
    },
    db,
  );
}

/**
 * SPEC-018 BR-018-19 — the same states `/watch` shows, keyed by asset, for the
 * badge in the Composição holdings list.
 *
 * A second, narrower read rather than a call to `loadWatchView` above: that
 * function also builds the "available" and "ineligible" lists, resolves
 * consent and reads the notification log, none of which a badge column needs.
 * It reuses the same `evaluateRule` over the same stored quote and the same
 * `quotes.cadence_minutes`, which is what BR-018-14 requires — the two screens
 * cannot disagree about a state, because neither of them decides one.
 *
 * Rules whose position has closed are excluded here (BR-018-03: they are
 * deactivated and retained), so a holding that no longer exists cannot put a
 * badge on a row that no longer exists either.
 */
export async function loadWatchStates(
  userId: UserId,
): Promise<ReadonlyMap<AssetId, EvaluatedState>> {
  const clock = new SystemClock();
  const calendar = new B3TradingCalendar();
  const now = clock.now();
  const sessionOpen = calendar.isSessionOpen(now);

  return withTenant(
    userId,
    async (tx) => {
      const deps = buildWatchDeps(tx, userId);
      const [rules, cadenceCfg] = await Promise.all([
        deps.rules.listAll(),
        resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
      ]);

      const active = rules.filter((rule) => rule.active);
      if (active.length === 0) return new Map<AssetId, EvaluatedState>();

      const assetIds = active.map((rule) => rule.assetId);
      const quotesByAsset = await deps.quotes.latestFor(assetIds);

      const states = new Map<AssetId, EvaluatedState>();
      for (const rule of active) {
        const evaluated = evaluateRule(rule, quotesByAsset.get(rule.assetId) ?? null, {
          sessionOpen,
          cadenceMinutes: cadenceCfg.value,
          now,
        });
        states.set(rule.assetId, evaluated.state);
      }
      return states;
    },
    db,
  );
}
