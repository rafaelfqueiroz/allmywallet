import { asStored, Money, type Quantity, sumMoney } from '@/core/shared/money';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { compareForReplay } from '@/core/positions/ordering';
import {
  positionKeyString,
  type PositionKey,
  replayPositionWithEstimate,
} from '@/core/positions/replay';
import {
  type CarriedCost,
  type CarryLeg,
  pairTransfers,
  resolveCarriedCosts,
  type TransferLeg,
  withCarriedCost,
} from '@/core/ingestion/transfer-cost';
import type { DomainError } from '@/core/shared/domain-error';
import { type Result, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import { recalculatePositionFrom, type RecalculationOutcome } from '@/core/ledger/recalculate-from';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { isActive, type Transaction } from '@/core/ledger/transaction';

/**
 * SPEC-007 BR-007-06 / DL-007-12 (#144 review F6) — a ledger write re-derives
 * the **carried legs** downstream of the positions it changed.
 *
 * Two kinds of leg store a cost that is not a price anyone stated but a figure
 * read off another position:
 *
 *   - a price-less `transfer_in` credit carries its source's *preço médio*
 *     immediately before the paired debit (SPEC-005 BR-005-20a);
 *   - an import-resolved conversion group's `conversion_out` legs remove their
 *     source's proportional cost and its `conversion_in` legs receive it
 *     (SPEC-007 BR-007-05b).
 *
 * Each also stores the cost-estimate marker of the source it read (BR-007-06:
 * "the marker travels with a carried transfer or conversion"). Both are
 * snapshots. When the user corrects the estimated subscription price at A,
 * A's own position is recalculated — but the credit A sent to B still holds
 * A's old estimated average *and* its marker, so B keeps reading "Custo
 * estimado" until a re-import re-carries it, and an import-resolved conversion
 * is never re-resolved at all. That contradicts the AC: "…through transfers and
 * conversions, until it closes; editing the price clears it."
 *
 * So a user write re-derives them, by **the same rule import uses** — the cost
 * and marker of the source at the moment of the debit — and never the marker
 * alone. Clearing the marker while the leg still holds a cost computed from the
 * estimate would show an estimated figure as exact, which is the one failure
 * DL-007-12 exists to prevent; re-deriving both keeps the marker honest by
 * construction.
 *
 * **Scope — what is re-derived, and what is left alone:**
 *
 *   - only legs whose **source position changed** (transitively: a re-derived
 *     leg changes its own position, whose outgoing legs are then re-derived —
 *     X→A→B chains);
 *   - only legs import wrote and nobody edited: imported (`importBatchId`),
 *     not manual, not `isUserModified`. A user who edited a carried leg has
 *     stated its figure (BR-006-16) — the same convention import's re-carry
 *     follows (`commit-batch.ts`, #112). A manual conversion group's
 *     allocation is the user's; its marker is recomputed when they edit the
 *     group (`manage-asset-conversion.ts`). Either keeps whatever marker it
 *     has, which errs toward "estimated", never toward a false "exact";
 *   - a transfer credit only where its debit pairs one-to-one over the stored
 *     ledger (`pairTransfers`); an ambiguous pair keeps its stored figure.
 *
 * Rebuild-equals-incremental (DM-4) is untouched: carried figures are stored
 * on the legs, a rebuild replays the legs as stored, and every position a
 * re-derived leg sits in is recalculated by the caller.
 */

/**
 * A `transfer_in` that took its cost by carry rather than from a stated price.
 *
 * Import keys such a credit at the price B3 stated — none — while it stores
 * the carried cost (SPEC-005 BR-005-17, `keepsImportKey` in
 * `edit-transaction.ts`), so its key is not the one its own fields derive. A
 * priced B3 credit is keyed at its own price and never matches. A carried cost
 * is always positive (`resolveCarriedCosts` carries no zero average), so the
 * two keys can never coincide by accident.
 */
function isCarriedCredit(transaction: Transaction): boolean {
  return (
    transaction.type === 'transfer_in' &&
    isImportOwned(transaction) &&
    transaction.naturalKey !== naturalKeyFor(transaction)
  );
}

/** Written by import and never edited by a user (BR-006-16). */
function isImportOwned(transaction: Transaction): boolean {
  return transaction.importBatchId !== null && !transaction.isManual && !transaction.isUserModified;
}

/**
 * Re-derives every carried leg downstream of `seeds` over `ledger` — the whole
 * ledger as it will stand once the triggering write is applied — and returns
 * the legs whose stored cost or marker changes, at their final value.
 *
 * Pure: the caller loads the ledger and writes the result (AR-01).
 *
 * Runs in rounds to a fixed point. A round re-derives the legs whose source is
 * a changed ("dirty") position; each leg it changes dirties the position it
 * lands in, whose own outgoing legs the next round re-derives. It terminates
 * because a carried figure depends only on rows **before** its debit in replay
 * order: a change can only flow forward in time, and a same-day swap, which
 * could feed itself, is left blocked by `resolveCarriedCosts` and keeps its
 * stored figure. A round that changes nothing ends the loop.
 */
export function rederiveCarriedLegs(
  ledger: readonly Transaction[],
  seeds: readonly PositionKey[],
  now: Date,
): readonly Transaction[] {
  const current = new Map(ledger.map((transaction) => [transaction.id, transaction]));
  const dirty = new Set(seeds.map(positionKeyString));
  const changed = new Map<string, Transaction>();

  const replace = (next: Transaction) => {
    const updated = { ...next, updatedAt: now };
    current.set(updated.id, updated);
    changed.set(updated.id, updated);
    dirty.add(positionKeyString(updated));
  };

  // Bounded for safety only: each productive round advances at least one
  // leg, and there are fewer legs than rows.
  for (let round = 0; round <= ledger.length; round += 1) {
    const rows = [...current.values()];
    const transfers = rederiveTransfers(rows, dirty);
    for (const next of transfers) replace(next);
    const conversions = rederiveConversions([...current.values()], dirty);
    for (const next of conversions) replace(next);
    if (transfers.length + conversions.length === 0) return [...changed.values()];
  }
  throw new Error('SPEC-007 BR-007-06: carried legs did not settle');
}

/**
 * SPEC-005 BR-005-20a, over the stored ledger: every carried credit whose
 * paired debit leaves a dirty position, at the cost and marker the source had
 * immediately before that debit.
 */
function rederiveTransfers(
  rows: readonly Transaction[],
  dirty: ReadonlySet<string>,
): readonly Transaction[] {
  const active = rows.filter(isActive);
  const legOf = (transaction: Transaction): TransferLeg => ({
    id: transaction.id,
    assetId: transaction.assetId,
    institutionId: transaction.institutionId,
    tradeDate: transaction.tradeDate,
    quantity: transaction.quantity,
    priceStated: !isCarriedCredit(transaction),
  });
  const credits = active.filter((t) => t.type === 'transfer_in');
  const debits = active.filter((t) => t.type === 'transfer_out');
  const byId = new Map<string, Transaction>(active.map((t) => [t.id, t]));
  const pairs = pairTransfers(credits.map(legOf), debits.map(legOf));

  const legs: CarryLeg[] = [];
  for (const [creditId, debitId] of pairs) {
    const credit = byId.get(creditId) as Transaction;
    const debit = byId.get(debitId) as Transaction;
    if (!isCarriedCredit(credit) || !dirty.has(positionKeyString(debit))) continue;
    // #112: the stored figure is the fallback, so a leg that cannot be
    // re-derived now keeps what it has rather than losing its cost.
    legs.push({ id: creditId, credit, debit, fallback: credit.unitPrice });
  }
  if (legs.length === 0) return [];

  const legIds = new Set(legs.map((leg) => leg.id));
  const history = (assetId: AssetId, institutionId: InstitutionId | null) =>
    rows.filter(
      (t) => t.assetId === assetId && t.institutionId === institutionId && !legIds.has(t.id),
    );
  const carried = resolveCarriedCosts(legs, history);

  const updates: Transaction[] = [];
  for (const leg of legs) {
    // Every leg has a fallback, so every leg resolves to something.
    const result = carried.get(leg.id) as CarriedCost;
    const sameCost = asStored(result.cost) === asStored(leg.credit.unitPrice);
    if (sameCost && result.estimated === leg.credit.costIsEstimate) continue;
    updates.push(withCarriedCost(leg.credit, result));
  }
  return updates;
}

/**
 * SPEC-007 BR-007-05b, over the stored ledger: every import-resolved
 * conversion group with an outgoing leg at a dirty position, its costs
 * re-read from its sources.
 */
function rederiveConversions(
  rows: readonly Transaction[],
  dirty: ReadonlySet<string>,
): readonly Transaction[] {
  const active = rows.filter(isActive);
  const groupIds = new Set(
    active
      .filter((t) => t.type === 'conversion_out' && dirty.has(positionKeyString(t)))
      .map((t) => t.conversionGroupId),
  );
  const updates: Transaction[] = [];
  for (const groupId of groupIds) {
    const legs = active.filter((t) => t.conversionGroupId === groupId);
    updates.push(...rederiveConversionGroup(legs, rows));
  }
  return updates;
}

/**
 * One group, re-derived the way `resolveAssetConversion` derived it:
 *
 *   - each outgoing leg removes its source's cost immediately before it, in
 *     replay order — the whole total when it takes every share, else
 *     `total × removed ÷ held`, stored at the column's eight places;
 *   - the incoming legs share the removed total in the proportions import
 *     gave them, the storage residual on the last positive share, so the sum
 *     in equals the sum out exactly (BR-007-05b);
 *   - every incoming leg is marked when any source was an estimate at its cut.
 *
 * The proportions are the stored allocations because the ledger keeps nothing
 * else of the definition's weights; for the single-target case, the only one
 * the owner's ledger has, the proportion is the whole.
 *
 * Worked example (DV-17): A held 100 @ 10,00 plus an estimated subscription of
 * 20 @ 114,90 — 120 shares, 3.298,00 — and converted all 120 into 60 B at
 * 3.298,00, estimated. Corrected to 112,95, A holds 3.259,00 before the leg:
 * out 3.259,00, in 3.259,00 (54,31666… each), exact.
 *
 * Returns nothing — the group keeps its stored figures — where the group is
 * not import's, a source prefix does not replay or holds fewer shares than
 * leave, or the stored proportions cannot say how to share the cost.
 */
function rederiveConversionGroup(
  legs: readonly Transaction[],
  rows: readonly Transaction[],
): readonly Transaction[] {
  if (!legs.every(isImportOwned)) return [];
  const outgoing = legs.filter((leg) => leg.type === 'conversion_out');
  const incoming = legs.filter((leg) => leg.type === 'conversion_in');

  let estimated = false;
  const nextOut: Transaction[] = [];
  for (const out of outgoing) {
    const before = rows.filter(
      (t) =>
        t.assetId === out.assetId &&
        t.institutionId === out.institutionId &&
        compareForReplay(t, out) < 0,
    );
    const replayed = replayPositionWithEstimate(before);
    if (!replayed.ok) return [];
    const { state, costEstimated } = replayed.value;
    const held = state.quantity.comparedTo(out.quantity);
    if (held < 0) return [];
    estimated = estimated || costEstimated;
    const removed =
      held === 0 ? state.totalCost : proportion(state.totalCost, out.quantity, state.quantity);
    nextOut.push({ ...out, costBasis: stored(removed) });
  }

  const total = sumMoney(nextOut.map((leg) => leg.costBasis as Money));
  const allocations = allocateLike(
    total,
    incoming.map((leg) => leg.costBasis as Money),
  );
  if (allocations === null) return [];
  const nextIn = incoming.map((leg, index) => ({
    ...leg,
    costBasis: allocations[index] as Money,
    // SPEC-007 BR-007-06: see `withSourceEstimate` in manage-asset-conversion.
    costIsEstimate: estimated,
    estimateCloseDate: null,
  }));

  return [...outgoing, ...incoming].flatMap((leg, index) => {
    const next = [...nextOut, ...nextIn][index] as Transaction;
    const same =
      (next.costBasis as Money).equals(leg.costBasis as Money) &&
      next.costIsEstimate === leg.costIsEstimate;
    return same ? [] : [next];
  });
}

/**
 * `total` shared in the proportions of `weights`, each share stored at eight
 * places and the residual on the last positive weight, so the shares sum to
 * `total` exactly. `null` when no weight is positive — nothing says how to
 * share it — unless there is only one leg to give it to.
 */
function allocateLike(total: Money, weights: readonly Money[]): readonly Money[] | null {
  const weightTotal = sumMoney(weights);
  if (!weightTotal.isPositive()) return weights.length === 1 ? [total] : null;
  const residualIndex = weights.reduce(
    (last, weight, index) => (weight.isPositive() ? index : last),
    -1,
  );
  const shares = weights.map((weight, index) =>
    index === residualIndex || !weight.isPositive()
      ? Money.zero()
      : stored(total.times(weight.toDecimal()).dividedBy(weightTotal.toDecimal())),
  );
  shares[residualIndex] = total.minus(sumMoney(shares));
  return shares;
}

function proportion(total: Money, part: Quantity, whole: Quantity): Money {
  return total.times(part).dividedBy(whole);
}

function stored(value: Money): Money {
  return Money.fromString(asStored(value));
}

/**
 * The async edge: loads what `rederiveCarriedLegs` needs, and only when it can
 * matter. A write whose positions send nothing on — no `transfer_out`, no
 * `conversion_out` — cannot reach a carried leg, so the whole-ledger read is
 * skipped; that is every write on a position that never left its broker.
 *
 * `project` turns the stored ledger into the ledger as the write will leave it
 * (edits in place, deletions gone), so the result can be guarded and written
 * together with the write itself.
 */
export async function planCarriedLegUpdates(
  deps: LedgerDependencies,
  seeds: readonly PositionKey[],
  project: (ledger: readonly Transaction[]) => readonly Transaction[],
): Promise<readonly Transaction[]> {
  let sendsOn = false;
  for (const seed of seeds) {
    const own = project(await deps.transactions.listForPosition(seed.assetId, seed.institutionId));
    if (
      own.some((t) => isActive(t) && (t.type === 'transfer_out' || t.type === 'conversion_out'))
    ) {
      sendsOn = true;
    }
  }
  if (!sendsOn) return [];
  return rederiveCarriedLegs(project(await deps.transactions.listAll()), seeds, deps.clock.now());
}

/**
 * BR-006-15 for the positions re-derived legs land in: each must replay with
 * the triggering write's removals and every re-derived leg in place. Run
 * before anything is written, so a refused write leaves nothing behind.
 */
export async function guardCarriedLegs(
  deps: LedgerDependencies,
  legs: readonly Transaction[],
  removed: ReadonlySet<string>,
): Promise<Result<void, DomainError>> {
  const replacing = new Set<string>([...removed, ...legs.map((leg) => leg.id)]);
  for (const key of positionsOf(legs)) {
    const guard = await guardReplayable(deps, key, (existing) => [
      ...without(existing, replacing),
      ...legs.filter((leg) => positionKeyString(leg) === positionKeyString(key)),
    ]);
    if (!guard.ok) return guard;
  }
  return ok(undefined);
}

/**
 * Recalculates every position a re-derived leg sits in, other than those the
 * caller already recalculates, each forward from its earliest re-derived leg
 * (DL-006-03). The legs must already be written.
 */
export async function recalculateCarriedPositions(
  deps: LedgerDependencies,
  legs: readonly Transaction[],
  alreadyRecalculated: readonly PositionKey[],
): Promise<Result<readonly RecalculationOutcome[], DomainError>> {
  const skip = new Set(alreadyRecalculated.map(positionKeyString));
  const outcomes: RecalculationOutcome[] = [];
  for (const key of positionsOf(legs)) {
    if (skip.has(positionKeyString(key))) continue;
    const outcome = await recalculatePositionFrom(deps, key);
    if (!outcome.ok) return outcome;
    outcomes.push(outcome.value);
  }
  return ok(outcomes);
}

/** One entry per position, dated its earliest leg. */
function positionsOf(
  legs: readonly Transaction[],
): readonly (PositionKey & { readonly fromDate: Transaction['tradeDate'] })[] {
  const byKey = new Map<string, PositionKey & { fromDate: Transaction['tradeDate'] }>();
  for (const leg of legs) {
    const id = positionKeyString(leg);
    const seen = byKey.get(id);
    if (seen === undefined || leg.tradeDate < seen.fromDate) {
      byKey.set(id, {
        assetId: leg.assetId,
        institutionId: leg.institutionId,
        fromDate: leg.tradeDate,
      });
    }
  }
  return [...byKey.values()];
}
