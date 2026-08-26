import { inArray } from 'drizzle-orm';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { resolveConfig } from '@/config/resolve';
import { SystemClock } from '@/core/shared/clock';
import { AssetId, type UserId, type WalletId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { runReportQuery } from '@/core/reporting/base-query';
import type { ReportHolding } from '@/core/reporting/ports';
import { NeedsAttentionReason } from '@/core/valuation/ports';
import {
  listWalletBalances,
  type BalanceHolding,
  type WalletBalance,
} from '@/core/wallets/balance';
import { isPriceUsable } from '@/core/wallets/drift';
import { buildWalletDeps } from '@/app/(app)/wallets/composition';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { db } from '@/db/client';
import { latestQuotes } from '@/db/schema/market';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-017 — everything the balance surfaces need, in **one** tenant
 * transaction (AR-11).
 *
 * AR-31/AR-35: the Server Components under `/wallets` call this; none of them
 * touches `db`, and no rule lives here. Every figure below is produced by
 * `core/wallets/balance.ts`; this module's whole job is to hand it the two
 * things `core/` cannot obtain for itself — the market value of each wallet's
 * slice, and whether the price behind it may be used.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VALUATION COMES FROM SPEC-011 RATHER THAN A SECOND PATH.
 *
 * BR-017-03 measures targets against **market value**, and BR-017-13 measures
 * each asset as a share of the wallet's *allocated* market value. SPEC-011's
 * holding set already computes exactly that: `buildHoldingSet` slices every
 * position per `(asset, institution, wallet)` and apportions its value with
 * `distributeExact`, which is what makes a wallet-scoped Composition report
 * agree with the portfolio total (TS-12).
 *
 * Valuing wallets a second way here would produce a screen that disagrees with
 * Composition about what the same wallet holds — every figure real, none of
 * them reconcilable, and nothing on either page to say which is right. That is
 * DL-011-03's argument, applied one report later.
 *
 * **One query for every wallet, not one per wallet.** The "Needs attention"
 * queue (BR-017-17) needs the balance state of all of them, and the balance
 * view needs one. A per-wallet query would re-price the whole portfolio once
 * per wallet, and two of them could disagree if a quote landed in between.
 * ---------------------------------------------------------------------------
 */

export interface WalletBalancesData {
  readonly balances: readonly WalletBalance[];
  /** The tolerance actually in force, for the UI to state (AC-9). */
  readonly tolerancePp: Quantity;
}

export async function loadWalletBalances(userId: UserId): Promise<WalletBalancesData> {
  const today = new SystemClock().today();
  const now = new SystemClock().now();

  return withTenant(
    userId,
    async (tx) => {
      const port = new DrizzleReportDataPort(tx, userId);

      const [earliest, tolerance, cadence] = await Promise.all([
        port.earliestSnapshotDate(),
        // BR-017-15 / AC-9: the tolerance is the user's own, resolved per
        // request so a change takes effect with no deploy. A user-level key, so
        // it reads `config_overrides` and must be inside `withTenant` — outside
        // it the RLS policy's uuid cast raises 22P02 rather than failing closed.
        resolveConfig('wallets.drift_tolerance_pp', { db: tx, userId }),
        // SPEC-008: the cadence a quote is measured stale against, read through
        // the resolver so a runtime degradation (BR-008-22) is honoured here too.
        resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
      ]);

      /*
       * Portfolio scope, grouped by asset, over the single day `today`.
       *
       * The grouping is irrelevant to what follows — every holding is
       * recovered by flattening the groups, and `aggregate` puts each one in
       * exactly one group, so the flattened set is the scoped set precisely
       * once. The **period** is what is chosen deliberately: a balance view is
       * current-state (BR-017-25), and a one-day custom range is the smallest
       * snapshot fetch that still resolves `asOf` to today.
       */
      const query = await runReportQuery(
        port,
        {
          period: { kind: 'custom', from: today, to: today },
          scope: { kind: 'portfolio' },
          grouping: 'asset',
          today,
        },
        earliest,
      );

      const tolerancePp = Quantity.fromString(String(tolerance.value));
      if (!query.ok) {
        // The only reachable failures here are a bad period or an indivisible
        // value, neither of which a caller can act on differently from "there
        // is nothing to show". Wallets still render, with no targets computed.
        return { balances: [], tolerancePp };
      }

      const holdings = query.value.report.groups.flatMap((group) => group.holdings);
      const assetIds = [...new Set(holdings.map((holding) => holding.assetId))];
      const quotedAt = await latestQuotedAtByAsset(tx, assetIds);

      const sessionOpen = new B3TradingCalendar().isSessionOpen(now);
      const holdingsByWallet = groupByWallet(holdings, (holding) => ({
        assetId: holding.assetId,
        assetClass: holding.assetClass,
        quantity: holding.quantity,
        value: holding.value,
        // BR-017-21 — the rule lives in `core/wallets/drift.ts`; this supplies
        // the four facts it needs and decides nothing itself.
        priceUsable: isPriceUsable({
          priceUnavailable: holding.needsAttention === NeedsAttentionReason.PRICE_UNAVAILABLE,
          quotedAt: quotedAt.get(holding.assetId) ?? null,
          sessionOpen,
          cadenceMinutes: cadence.value,
          now,
        }),
      }));

      const balances = await listWalletBalances(buildWalletDeps(tx, userId), userId, {
        holdingsByWallet,
        tolerancePp,
      });

      return { balances, tolerancePp };
    },
    db,
  );
}

/** One wallet's balance, or `null` when the tenant has no such wallet. */
export async function loadWalletBalance(
  userId: UserId,
  walletId: WalletId,
): Promise<WalletBalance | null> {
  const { balances } = await loadWalletBalances(userId);
  return balances.find((balance) => balance.walletId === walletId) ?? null;
}

/**
 * BR-017-12 — the unallocated remainder is in no wallet, so it is dropped
 * here rather than filtered later. SPEC-011 marks it `walletId === null`;
 * there is no wallet for it to belong to and nothing about it to target.
 */
function groupByWallet(
  holdings: readonly ReportHolding[],
  toBalanceHolding: (holding: ReportHolding) => BalanceHolding,
): ReadonlyMap<WalletId, readonly BalanceHolding[]> {
  const byWallet = new Map<WalletId, BalanceHolding[]>();
  for (const holding of holdings) {
    if (holding.walletId === null) continue;
    const list = byWallet.get(holding.walletId) ?? [];
    list.push(toBalanceHolding(holding));
    byWallet.set(holding.walletId, list);
  }
  return byWallet;
}

/**
 * SPEC-008 — when each asset's intraday quote was last taken.
 *
 * Per asset rather than the single high-water mark
 * `DrizzleReportDataPort.latestQuoteAt` returns, because BR-017-21 is a
 * per-asset judgement: one suspended ticker whose quote stopped updating is
 * exactly the case the rule exists for, and a portfolio-wide maximum would
 * hide it behind every other asset's fresh price.
 *
 * AR-15: `latest_quotes` is shared reference data with no tenant column, so
 * this read needs no tenant context — but it runs on the caller's transaction
 * rather than the pool, for the same reason the asset catalog does in
 * `wallets/composition.ts`: a request already holding a pooled connection must
 * not go back for a second one, or concurrent requests deadlock waiting for
 * connections only their own transactions can release.
 *
 * `latest_quotes` is overwritten on every refresh (BR-008-10), so one row per
 * asset is all there is.
 */
async function latestQuotedAtByAsset(
  tx: Tx,
  assetIds: readonly AssetId[],
): Promise<ReadonlyMap<AssetId, Date>> {
  if (assetIds.length === 0) return new Map();
  const rows = await tx
    .select({ assetId: latestQuotes.assetId, quotedAt: latestQuotes.quotedAt })
    .from(latestQuotes)
    .where(inArray(latestQuotes.assetId, [...assetIds]));
  return new Map(rows.map((row) => [AssetId.of(row.assetId), row.quotedAt]));
}
