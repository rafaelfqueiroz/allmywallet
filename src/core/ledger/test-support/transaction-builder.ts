import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ImportBatchId, InstitutionId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import {
  computeTotalValue,
  type Transaction,
  type TransactionStatus,
  type TransactionType,
} from '@/core/ledger/transaction';

/**
 * TS-22: domain fixtures are builders with sensible defaults, so a test states
 * only what it cares about — `aTransaction().buy().of('PETR4').quantity('100')`
 * rather than fourteen fields of which two matter.
 *
 * **Every identifier here is deterministic**, derived from the name or the
 * sequence number rather than randomly generated. That is not tidiness: the
 * replay order's final tiebreak is the transaction id (`ordering.ts`), so a
 * random id would make a same-date, same-rank, same-timestamp pair sort
 * differently on different runs, and TS-08's rebuild-equals-incremental
 * property would fail once in a while for a reason nobody could reproduce.
 *
 * Likewise `createdAt` advances one millisecond per built row, so insertion
 * order is recoverable — which is exactly what the ordering rule promises to
 * respect for a batch of same-day trades.
 */

/**
 * A valid UUID built from a kind tag and an index. Hex only, and the variant
 * nibble is `8`, because `ids.ts` validates the shape rather than trusting it.
 */
function testUuid(kind: number, index: number): string {
  return `${index.toString(16).padStart(8, '0')}-${kind.toString(16).padStart(4, '0')}-7000-8000-000000000000`;
}

const ASSET_KIND = 0xa55e;
const INSTITUTION_KIND = 0x1451;
const BATCH_KIND = 0xba7c;
const TRANSACTION_KIND = 0x7c;

const assetIds = new Map<string, AssetId>();
const institutionIds = new Map<string, InstitutionId>();
const batchIds = new Map<string, ImportBatchId>();

/** Stable id for an asset code — `assetIdFor('PETR4')` is the same every time. */
export function assetIdFor(code: string): AssetId {
  const existing = assetIds.get(code);
  if (existing !== undefined) return existing;
  const created = AssetId.of(testUuid(ASSET_KIND, assetIds.size + 1));
  assetIds.set(code, created);
  return created;
}

export function institutionIdFor(name: string): InstitutionId {
  const existing = institutionIds.get(name);
  if (existing !== undefined) return existing;
  const created = InstitutionId.of(testUuid(INSTITUTION_KIND, institutionIds.size + 1));
  institutionIds.set(name, created);
  return created;
}

export function importBatchIdFor(name: string): ImportBatchId {
  const existing = batchIds.get(name);
  if (existing !== undefined) return existing;
  const created = ImportBatchId.of(testUuid(BATCH_KIND, batchIds.size + 1));
  batchIds.set(name, created);
  return created;
}

export const TEST_USER_ID: UserId = UserId.of(testUuid(0x115e, 1));

/** Monotonic, so ids and `createdAt` both follow build order. */
let sequence = 0;

/**
 * Resets the id/timestamp sequence. Tests that compare two independently built
 * histories call this so both start from the same point — otherwise the second
 * history's ids sort after the first's and a comparison that should be about
 * arithmetic becomes about build order.
 */
export function resetTransactionSequence(): void {
  sequence = 0;
}

const EPOCH = Date.UTC(2026, 0, 1, 12, 0, 0);

interface BuilderState {
  readonly assetCode: string;
  readonly institutionName: string | null;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  readonly ratio: Quantity | null;
  readonly importBatchName: string | null;
  readonly createdAt: Date | null;
}

const DEFAULTS: BuilderState = {
  assetCode: 'PETR4',
  institutionName: null,
  type: 'buy',
  status: 'active',
  tradeDate: BusinessDate.of('2026-01-05'),
  quantity: Quantity.fromString('100'),
  unitPrice: Money.fromString('10'),
  fees: Money.zero(),
  ratio: null,
  importBatchName: null,
  createdAt: null,
};

export class TransactionBuilder {
  readonly #state: BuilderState;

  constructor(state: BuilderState = DEFAULTS) {
    this.#state = state;
  }

  /** Every mutator returns a new builder, so a shared base fixture cannot be corrupted by a test that extends it. */
  #with(patch: Partial<BuilderState>): TransactionBuilder {
    return new TransactionBuilder({ ...this.#state, ...patch });
  }

  buy(): TransactionBuilder {
    return this.#with({ type: 'buy' });
  }
  sell(): TransactionBuilder {
    return this.#with({ type: 'sell' });
  }
  split(): TransactionBuilder {
    // A split's effect is carried entirely by the ratio, so the quantity and
    // price default away — a split row with a price is a mis-typed row.
    return this.#with({ type: 'split', quantity: Quantity.zero(), unitPrice: Money.zero() });
  }
  grupamento(): TransactionBuilder {
    return this.#with({ type: 'grupamento', quantity: Quantity.zero(), unitPrice: Money.zero() });
  }
  bonificacao(): TransactionBuilder {
    // BR-007-05: the default is zero attributed value, which is the common case
    // and the one people get wrong.
    return this.#with({ type: 'bonificacao', unitPrice: Money.zero() });
  }
  subscription(): TransactionBuilder {
    return this.#with({ type: 'subscription' });
  }
  transferIn(): TransactionBuilder {
    return this.#with({ type: 'transfer_in' });
  }
  transferOut(): TransactionBuilder {
    return this.#with({ type: 'transfer_out' });
  }
  adjustment(): TransactionBuilder {
    return this.#with({ type: 'adjustment' });
  }
  dividend(): TransactionBuilder {
    return this.#with({ type: 'dividend' });
  }
  jcp(): TransactionBuilder {
    return this.#with({ type: 'jcp' });
  }
  rendimento(): TransactionBuilder {
    return this.#with({ type: 'rendimento' });
  }
  amortization(): TransactionBuilder {
    return this.#with({ type: 'amortization' });
  }

  of(assetCode: string): TransactionBuilder {
    return this.#with({ assetCode });
  }
  at(institutionName: string | null): TransactionBuilder {
    return this.#with({ institutionName });
  }
  on(tradeDate: string): TransactionBuilder {
    return this.#with({ tradeDate: BusinessDate.of(tradeDate) });
  }
  quantity(value: string): TransactionBuilder {
    return this.#with({ quantity: Quantity.fromString(value) });
  }
  price(value: string): TransactionBuilder {
    return this.#with({ unitPrice: Money.fromString(value) });
  }
  fees(value: string): TransactionBuilder {
    return this.#with({ fees: Money.fromString(value) });
  }
  ratio(value: string): TransactionBuilder {
    return this.#with({ ratio: Quantity.fromString(value) });
  }
  status(status: TransactionStatus): TransactionBuilder {
    return this.#with({ status });
  }
  imported(batchName = 'batch-1'): TransactionBuilder {
    return this.#with({ importBatchName: batchName });
  }
  /** For the ordering tests, where "which row was entered first" is the subject. */
  createdAt(instant: string): TransactionBuilder {
    return this.#with({ createdAt: new Date(instant) });
  }

  build(): Transaction {
    sequence += 1;
    const state = this.#state;
    const createdAt = state.createdAt ?? new Date(EPOCH + sequence);
    const importBatchId =
      state.importBatchName === null ? null : importBatchIdFor(state.importBatchName);
    return {
      id: TransactionId.of(testUuid(TRANSACTION_KIND, sequence)),
      userId: TEST_USER_ID,
      assetId: assetIdFor(state.assetCode),
      institutionId:
        state.institutionName === null ? null : institutionIdFor(state.institutionName),
      type: state.type,
      status: state.status,
      tradeDate: state.tradeDate,
      quantity: state.quantity,
      unitPrice: state.unitPrice,
      fees: state.fees,
      totalValue: computeTotalValue(state.type, state.quantity, state.unitPrice, state.fees),
      ratio: state.ratio,
      naturalKey: `${state.tradeDate}|${state.assetCode}|${state.type}|${state.quantity.toString()}|${state.unitPrice.toString()}`,
      occurrence: 1,
      importBatchId,
      isManual: importBatchId === null,
      isUserModified: false,
      createdAt,
      updatedAt: createdAt,
    };
  }
}

export function aTransaction(): TransactionBuilder {
  return new TransactionBuilder();
}
