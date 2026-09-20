import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import { asStored, Money, type Quantity } from '@/core/shared/money';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import { compareForReplay } from '@/core/positions/ordering';
import { replayPosition } from '@/core/positions/replay';
import type { ImportRow } from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-20a (#110) — the cost a price-less custody transfer carries.
 *
 * B3's Movimentação leaves the price blank (`-`) on a `Transferência` between
 * brokers. A `transfer_in` opens the destination lot at the cost on its
 * `unitPrice` (`core/positions/apply-transaction.ts`), and that cost is not a
 * price anyone typed: it is the *preço médio* the shares had at the source.
 *
 * Everything here is pure: `commit-batch.ts` loads the ledger and hands it in
 * (AR-01), which is what lets the same answer be recomputed on a re-import.
 */

/** A staged row that can only enter the ledger with a carried cost. */
export function isCarryCandidate(row: ImportRow): boolean {
  return (
    row.ledgerType === 'transfer_in' && row.record.kind === 'transaction' && !row.record.priceStated
  );
}

export interface TransferLeg {
  readonly id: string;
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
}

/**
 * BR-005-20a — which debit a credit came from.
 *
 * A debit matches a credit on the same asset, trade date and quantity, at a
 * **known** institution (a debit with no institution names no source position
 * to read). A pair is formed only where the relation is one-to-one on **both**
 * sides: two candidate debits for one credit, or two credits for one debit,
 * pair nothing. Computed over the whole relation, never by walking the file,
 * so file order cannot choose a source.
 *
 * **The institution may be the credit's own** (#135). B3 recorded the July
 * 2023 Energias do Brasil buyout as a price-less `Transferência` debit *and*
 * credit at one broker — 101 at Clear, 99 at Inter — and the earlier rule,
 * which required a *different* institution, formed no pair. The credit took no
 * cost and stayed `unclassified` while the debit, needing none, applied: the
 * position went to zero and 200 shares left the ledger silently.
 *
 * Such a pair moves nothing. Read through `resolveCarriedCosts` below it is
 * not a special case at all — the source position *is* the destination, so the
 * credit carries the average the debit removed the shares at: the quantity
 * comes back exactly and the cost to the scale the ledger stores (see
 * `withCarriedCost`). Nothing is invented: the figure is the ledger's own.
 *
 * `credits` should be every `transfer_in` leg of the batch — priced or not —
 * so a debit that could equally have fed a priced credit is ambiguous too.
 * Admitting same-institution debits can only ever *withdraw* a pair the
 * earlier rule formed, never redirect one: a credit that now sees two
 * candidate debits is ambiguous and pairs with neither.
 */
export function pairTransfers(
  credits: readonly TransferLeg[],
  debits: readonly TransferLeg[],
): ReadonlyMap<string, string> {
  const debitsOf = new Map<string, readonly string[]>();
  const creditCount = new Map<string, number>();
  for (const credit of credits) {
    const matching = debits
      .filter(
        (debit) =>
          debit.institutionId !== null &&
          debit.assetId === credit.assetId &&
          debit.tradeDate === credit.tradeDate &&
          debit.quantity.equals(credit.quantity),
      )
      .map((debit) => debit.id);
    debitsOf.set(credit.id, matching);
    for (const id of matching) creditCount.set(id, (creditCount.get(id) ?? 0) + 1);
  }

  const pairs = new Map<string, string>();
  for (const [creditId, matching] of debitsOf) {
    const [only, ...others] = matching;
    if (only !== undefined && others.length === 0 && creditCount.get(only) === 1) {
      pairs.set(creditId, only);
    }
  }
  return pairs;
}

export interface CarryLeg {
  readonly id: string;
  /** The credit as it would be written once carried — `active`, at its destination. Its price is replaced. */
  readonly credit: Transaction;
  /** The paired debit as the ledger holds it, or will once this commit writes it. `null` when it will not be in the ledger. */
  readonly debit: Transaction | null;
  /**
   * #112 — the cost already stored for a credit carried by an earlier import.
   * Kept when the carry cannot be resolved now (the debit or the source's
   * history is gone), so a re-import never takes a cost away; `null` for a
   * credit that has none yet.
   */
  readonly fallback: Money | null;
}

/**
 * The credit at the carried cost, **at the scale the column holds** (#135).
 *
 * A carried cost is a division, so it repeats as often as not: the owner's
 * ENBR3 is 2.074,64 ÷ 101. `NUMERIC(20,8)` keeps eight places, so writing the
 * full-precision figure here makes the position this commit *caches* — folded
 * from these in-memory rows — disagree with the position a **rebuild** folds
 * from the same rows read back. `verifyPositions` reports that as drift, and
 * DM-4 says the cache is a cache: it must equal its replay.
 *
 * Rounding once, here, is what keeps the two identical. It is the same reading
 * `commit-batch.ts` already takes when deciding whether a re-carry changed
 * anything (#112): a repeating average is compared at the column's scale,
 * because that is the only figure that survives a round trip.
 */
export function withCarriedCost(credit: Transaction, cost: Money): Transaction {
  const stored = Money.fromString(asStored(cost));
  return {
    ...credit,
    unitPrice: stored,
    totalValue: computeTotalValue(credit.type, credit.quantity, stored, credit.fees),
  };
}

/**
 * BR-005-20a — the source position's average cost **immediately before its
 * debit is applied**, in replay order (`compareForReplay`: date, type rank,
 * `created_at`, id).
 *
 * That cut includes every same-day row ranked before a `transfer_out` — a
 * bonificação (rank 0), a buy or another transfer in (rank 1), a bonificação
 * fraction removal (rank 2), an adjustment (rank 3) — and it is identical on
 * every re-import, because by then the
 * ledger holds the same rows with the same `created_at` and ids.
 *
 * `history(asset, institution)` is everything the ledger holds or this commit
 * will write for a position, **other than** the carry legs' credits: those
 * enter a source's history only once their own cost is resolved. So a chain
 * X→A→B resolves A's credit first; a credit into the source that sorts before
 * the debit and is still unresolved *blocks* the debit until it is. What never
 * unblocks (a same-day A→B / B→A swap) carries nothing.
 *
 * No carry — the credit stays `unclassified` (BR-005-19), or keeps its
 * `fallback` — when the debit is not in the ledger, the source prefix cannot
 * be replayed, it held fewer shares than leave, or it held them at no cost.
 *
 * Worked example (DV-17): the ledger holds 100 @ 10,00 at A (cost 1.000,00).
 * The batch has a bonificação of 100 at A on 2026-02-01 at zero attributed
 * value (BR-007-05: cost unchanged, 200 shares) and a transfer of 100 A→B on
 * 2026-03-10. Before the debit A holds 200 shares costing 1.000,00, so the
 * carried cost is 1.000,00 ÷ 200 = **5,00**.
 */
export function resolveCarriedCosts(
  legs: readonly CarryLeg[],
  history: (assetId: AssetId, institutionId: InstitutionId | null) => readonly Transaction[],
): ReadonlyMap<string, Money> {
  const resolved = new Map<string, Money>();
  const pending = new Map(legs.map((leg) => [leg.id, leg]));

  let progressed = true;
  const settleLeg = (leg: CarryLeg, cost: Money | null) => {
    pending.delete(leg.id);
    progressed = true;
    const final = cost ?? leg.fallback;
    if (final !== null) resolved.set(leg.id, final);
  };

  while (progressed) {
    progressed = false;
    for (const leg of [...pending.values()]) {
      const debit = leg.debit;
      if (debit === null) {
        settleLeg(leg, null);
        continue;
      }
      const atSource = (t: Transaction) =>
        t.assetId === debit.assetId && t.institutionId === debit.institutionId;

      const blocked = [...pending.values()].some(
        (other) =>
          other.id !== leg.id &&
          atSource(other.credit) &&
          compareForReplay(other.credit, debit) < 0,
      );
      if (blocked) continue;

      const carriedIn = legs.flatMap((other) => {
        const cost = resolved.get(other.id);
        return cost === undefined || !atSource(other.credit)
          ? []
          : [withCarriedCost(other.credit, cost)];
      });
      const before = [...history(debit.assetId, debit.institutionId), ...carriedIn].filter(
        (t) => compareForReplay(t, debit) < 0,
      );
      const replayed = replayPosition(before);
      const carriable =
        replayed.ok &&
        replayed.value.quantity.comparedTo(debit.quantity) >= 0 &&
        replayed.value.averageCost.isPositive();
      settleLeg(leg, carriable ? replayed.value.averageCost : null);
    }
  }

  // What never unblocked (a same-day swap) keeps whatever it already had.
  for (const leg of pending.values()) {
    if (leg.fallback !== null) resolved.set(leg.id, leg.fallback);
  }
  return resolved;
}

/**
 * SPEC-005 BR-005-20a (#135) — the debits a commit must **not** write.
 *
 * A `transfer_out` needs no price, so it applies on its own; its credit needs
 * a carried cost and stays `unclassified` without one. Where the two legs are
 * the same position — same asset, same institution — applying one alone is not
 * a partial import but a **loss**: the shares leave the position and nothing
 * records their return. That is what took 200 ENBR3 shares out of the owner's
 * *patrimônio*, silently, with no screen in the product to say so.
 *
 * So a same-position pair is all or nothing. Where the carry resolves, both
 * legs are written and net to zero; where it does not, the debit is refused
 * (`unresolved_transfer_pair`) rather than applied, nothing is written for it,
 * no occurrence is taken, and importing the file again applies it once the
 * credit can take its cost (BR-005-17).
 *
 * A **cross-institution** pair is deliberately not held back: the debit is the
 * whole record of shares genuinely leaving that broker, and BR-005-20a has
 * always let its credit wait for history that has not been imported yet. The
 * quantity is still visible at the destination as an `unclassified` row in
 * Needs attention, which a same-position pair's credit is too — but there the
 * debit erases the same position the credit would have restored.
 */
export function debitsHeldBack(
  legs: readonly CarryLeg[],
  resolved: ReadonlyMap<string, Money>,
): ReadonlySet<string> {
  return new Set(
    legs.flatMap((leg) =>
      leg.debit !== null &&
      !resolved.has(leg.id) &&
      leg.debit.assetId === leg.credit.assetId &&
      leg.debit.institutionId === leg.credit.institutionId
        ? [leg.debit.id]
        : [],
    ),
  );
}
