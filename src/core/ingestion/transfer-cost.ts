import { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { TransactionType } from '@/core/ledger/transaction';
import { replayPosition } from '@/core/positions/replay';

/**
 * #110 — the cost a price-less custody transfer carries.
 *
 * B3's Movimentação leaves the price blank (`-`) on a `Transferência` between
 * brokers. A `transfer_in` opens the destination lot at the cost on its
 * `unitPrice` (`core/positions/apply-transaction.ts`, SPEC-007 BR-007-08), and
 * that cost is not a price anyone typed: it is the *preço médio* the shares
 * already had at the source broker.
 *
 * So a price-less credit is paired with the debit leaving the source — same
 * asset, same date, same quantity, another institution, in the same batch —
 * and takes the source position's average cost **as of the day before**.
 * The day before, not the day itself, so the answer does not change once the
 * debit is committed: re-importing the file must compute the same figure
 * (BR-005-17). An average cost is untouched by a withdrawal, so nothing the
 * source held that morning is lost by it.
 *
 * No carry — the row stays `unclassified` (BR-005-19) — when there is no
 * unambiguous debit, when the source ledger cannot be replayed, or when it
 * held fewer shares than left it or held them at no cost. Each of those means
 * the source history is not in the ledger, and a guessed cost is the silent
 * wrong number the calculation engine exists to prevent.
 */
export interface TransferLeg {
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly ledgerType: TransactionType;
  /** `true` for a `transfer_in` whose extract gave no price. */
  readonly needsCarriedCost: boolean;
}

/** Keyed by the index of each `transfer_in` leg a cost could be carried onto. */
export async function carriedTransferCosts(
  transactions: Pick<TransactionRepository, 'listForPosition'>,
  legs: readonly TransferLeg[],
): Promise<ReadonlyMap<number, Money>> {
  const costs = new Map<number, Money>();
  const pairedDebits = new Set<number>();

  for (const [index, leg] of legs.entries()) {
    if (!leg.needsCarriedCost) continue;

    const matches = [...legs.entries()].filter(
      ([other, debit]) =>
        !pairedDebits.has(other) &&
        debit.ledgerType === 'transfer_out' &&
        debit.assetId === leg.assetId &&
        debit.institutionId !== leg.institutionId &&
        debit.tradeDate === leg.tradeDate &&
        debit.quantity.equals(leg.quantity),
    );
    const source = matches[0];
    if (source === undefined) continue;
    pairedDebits.add(source[0]);

    const history = await transactions.listForPosition(leg.assetId, source[1].institutionId);
    const before = history.filter((t) => BusinessDate.isBefore(t.tradeDate, leg.tradeDate));
    const replayed = replayPosition(before);
    if (!replayed.ok) continue;
    const { quantity, averageCost } = replayed.value;
    if (quantity.comparedTo(leg.quantity) < 0 || !averageCost.isPositive()) continue;

    costs.set(index, averageCost);
  }

  return costs;
}
