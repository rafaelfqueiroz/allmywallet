import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { Scope } from '@/core/reporting/ports';
import type {
  AssetDescriptor,
  DailyValuationSnapshot,
  ReportAllocation,
  ReportDataPort,
  ReportHolding,
  ReportInstitution,
  ReportPosition,
  ReportWallet,
} from '@/core/reporting/ports';

/**
 * TS-22 — builders with sensible defaults, so a test states only what it cares
 * about, and TS-02 — a **hand-written** fake implementing the real port. When
 * `ReportDataPort` changes this file stops compiling; a mocking library would
 * carry on lying.
 *
 * No default parameters anywhere in this file. `src/core/reporting/**` is held
 * to 100% *branch* coverage (TS-28), and an unexercised `= {}` default is a
 * branch — one that would have to be chased with a test written for the
 * builder rather than for the domain. Callers pass an object, always.
 */

/** Deterministic, readable ids. `n` is up to three hex digits. */
function uuid(prefix: string, n: string): string {
  return `01920000-0000-7000-8000-00000000${prefix}${n.padStart(3, '0')}`;
}

export const assetIdOf = (n: string): AssetId => AssetId.of(uuid('a', n));
export const walletIdOf = (n: string): WalletId => WalletId.of(uuid('b', n));
export const institutionIdOf = (n: string): InstitutionId => InstitutionId.of(uuid('c', n));

export const money = (value: string): Money => Money.fromString(value);
export const qty = (value: string): Quantity => Quantity.fromString(value);
export const day = (value: string): BusinessDate => BusinessDate.of(value);

const DEFAULT_HOLDING: ReportHolding = {
  assetId: assetIdOf('1'),
  assetCode: 'PETR4',
  assetName: 'Petrobras PN',
  assetClass: 'stock',
  sector: 'Petróleo e Gás',
  institutionId: institutionIdOf('1'),
  walletId: walletIdOf('1'),
  quantity: Quantity.fromString('100'),
  value: Money.fromString('1000'),
  costBasis: Money.fromString('800'),
  estimated: false,
  // SPEC-009 AC-3/9/11 — the observed-price defaults. A test that cares about
  // a carried-forward close or a needs-attention holding overrides them
  // explicitly, which keeps those cases visible in the test that asserts them.
  carriedForward: false,
  priceDate: BusinessDate.of('2026-03-20'),
  needsAttention: null,
  basis: null,
};

export function aHolding(overrides: Partial<ReportHolding>): ReportHolding {
  return { ...DEFAULT_HOLDING, ...overrides };
}

const DEFAULT_POSITION: ReportPosition = {
  assetId: assetIdOf('1'),
  institutionId: institutionIdOf('1'),
  quantity: Quantity.fromString('100'),
  value: Money.fromString('1000'),
  costBasis: Money.fromString('800'),
  estimated: false,
  // SPEC-009 AC-3/9/11 — the observed-price defaults. A test that cares about
  // a carried-forward close or a needs-attention holding overrides them
  // explicitly, which keeps those cases visible in the test that asserts them.
  carriedForward: false,
  priceDate: BusinessDate.of('2026-03-20'),
  needsAttention: null,
  basis: null,
};

export function aPosition(overrides: Partial<ReportPosition>): ReportPosition {
  return { ...DEFAULT_POSITION, ...overrides };
}

const DEFAULT_DESCRIPTOR: AssetDescriptor = {
  assetId: assetIdOf('1'),
  code: 'PETR4',
  name: 'Petrobras PN',
  assetClass: 'stock',
  sector: 'Petróleo e Gás',
};

export function anAsset(overrides: Partial<AssetDescriptor>): AssetDescriptor {
  return { ...DEFAULT_DESCRIPTOR, ...overrides };
}

export interface FakeReportData {
  positions: readonly ReportPosition[];
  allocations: readonly ReportAllocation[];
  wallets: readonly ReportWallet[];
  institutions: readonly ReportInstitution[];
  assets: readonly AssetDescriptor[];
  snapshots: readonly DailyValuationSnapshot[];
}

/**
 * TS-02: implements `ReportDataPort` by hand.
 *
 * It records what was asked of it, which is how the "reports read snapshots,
 * never the ledger" expectation is checked behaviourally in a use-case test —
 * the port has no method that could reach a transaction, and this fake proves
 * the read path only touches the ones that exist.
 */
export class FakeReportDataPort implements ReportDataPort {
  readonly calls: string[] = [];

  constructor(private readonly data: FakeReportData) {}

  async listValuedPositions(asOf: BusinessDate): Promise<readonly ReportPosition[]> {
    this.calls.push(`listValuedPositions:${asOf}`);
    return this.data.positions;
  }

  async listAllocations(): Promise<readonly ReportAllocation[]> {
    this.calls.push('listAllocations');
    return this.data.allocations;
  }

  async listWallets(): Promise<readonly ReportWallet[]> {
    this.calls.push('listWallets');
    return this.data.wallets;
  }

  async listInstitutions(): Promise<readonly ReportInstitution[]> {
    this.calls.push('listInstitutions');
    return this.data.institutions;
  }

  async describeAssets(assetIds: readonly AssetId[]): Promise<readonly AssetDescriptor[]> {
    this.calls.push(`describeAssets:${assetIds.length}`);
    const wanted = new Set<string>(assetIds);
    return this.data.assets.filter((asset) => wanted.has(asset.assetId));
  }

  async listSnapshots(
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly DailyValuationSnapshot[]> {
    this.calls.push(`listSnapshots:${from}:${to}`);
    return this.data.snapshots.filter(
      (snapshot) =>
        !BusinessDate.isBefore(snapshot.date, from) && !BusinessDate.isAfter(snapshot.date, to),
    );
  }

  /**
   * Strictly before `date`, latest first — the same comparison
   * `DrizzleReportDataPort.findSnapshotBefore` makes in SQL. An inclusive
   * comparison here would let the fake agree with a broken adapter, which is
   * the one thing a hand-written fake exists to prevent.
   */
  async findSnapshotBefore(date: BusinessDate): Promise<DailyValuationSnapshot | null> {
    this.calls.push(`findSnapshotBefore:${date}`);
    const before = this.data.snapshots.filter((snapshot) =>
      BusinessDate.isBefore(snapshot.date, date),
    );
    return (
      [...before].sort((a, b) => BusinessDate.compare(b.date, a.date))[0] ??
      // No baseline: the period starts at or before the first snapshot there is.
      null
    );
  }

  async findWallet(walletId: WalletId): Promise<ReportWallet | null> {
    this.calls.push(`findWallet:${walletId}`);
    return this.data.wallets.find((wallet) => wallet.walletId === walletId) ?? null;
  }
}

/* -------------------------------------------------------------------------
 * A GENERATED PORTFOLIO, SHARED BY EVERY CROSS-CUTTING REPORTING TEST
 *
 * Written for `totals-invariant.test.ts` and moved here when the cross-report
 * equality test (SPEC-013 BR-013-12) needed the same portfolios. Two copies
 * would be two definitions of "an awkward portfolio", and the weaker one would
 * quietly become the one a new invariant was written against — the same
 * argument DL-011-02 makes for one reporting framework rather than four.
 *
 * Determinism (TS-23): a local PRNG seeded per case, never `Math.random`, so a
 * failure is reproducible from the seed printed in the test name.
 * ---------------------------------------------------------------------- */
/** mulberry32 — a small, fast, fully deterministic PRNG. */
export function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSET_CLASSES: readonly AssetClass[] = [
  'stock',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
];

/** BR-011-10: fixed income and Tesouro have no sector — the "Not classified" driver. */
const FIXED_INCOME: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'cdb',
  'lci',
  'lca',
  'tesouro_direto',
]);

const SECTORS = ['Bancos', 'Energia', 'Petróleo e Gás', 'Consumo'] as const;

/**
 * Unit prices chosen to force **non-terminating division** through the
 * pro-rata split. A price like 12.345678 over a prime quantity such as 997,
 * apportioned three ways, produces a repeating decimal in every share — which
 * is precisely where a naive proportional split silently loses value.
 */
const UNIT_PRICES = ['12.345678', '3.33', '107.07', '0.87', '1234.5678', '19.999999'] as const;

/** Prime-ish quantities, so nothing divides evenly by accident. */
const QUANTITIES = [997, 101, 37, 13, 7, 3, 1, 499, 251, 61] as const;

export interface GeneratedPortfolio {
  readonly positions: readonly ReportPosition[];
  readonly allocations: readonly ReportAllocation[];
  readonly assets: readonly AssetDescriptor[];
  readonly walletIds: readonly WalletId[];
}

/**
 * A portfolio built to stress every path the invariant can break on, rather
 * than an average one. Each seed varies the mix; every seed contains at least
 * one of each awkward case.
 */
export function generatePortfolio(seed: number): GeneratedPortfolio {
  const random = prng(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

  // Four wallets. The fourth is deliberately never allocated anything — an
  // empty wallet must still scope cleanly and total zero.
  const walletIds: readonly WalletId[] = [1, 2, 3, 4].map((n) => walletIdOf(String(n)));
  const institutions: readonly (InstitutionId | null)[] = [
    institutionIdOf('1'),
    institutionIdOf('2'),
    // BR-011-10: a position with no institution recorded → "Not classified".
    null,
  ];

  const assets: AssetDescriptor[] = [];
  const positions: ReportPosition[] = [];
  const allocations: ReportAllocation[] = [];

  const ASSET_COUNT = 14;
  for (let i = 0; i < ASSET_COUNT; i += 1) {
    const assetId = assetIdOf(String(i + 1));
    const assetClass =
      i < ASSET_CLASSES.length ? (ASSET_CLASSES[i] as AssetClass) : pick(ASSET_CLASSES);
    const sector = FIXED_INCOME.has(assetClass)
      ? null
      : // Some equities also lack sector data — the catalog has no sector
        // column at all today (PRD Q5), so null is the common case, not a rare one.
        random() < 0.4
        ? null
        : pick(SECTORS);

    assets.push({
      assetId,
      code: `AST${String(i + 1).padStart(2, '0')}`,
      name: `Ativo ${i + 1}`,
      assetClass,
      sector,
    });

    // Every fifth asset is CLOSED TO ZERO: no position at all, but a stale
    // allocation row left behind. It must contribute nothing to any total.
    if (i % 5 === 4) {
      allocations.push({
        walletId: pick(walletIds),
        assetId,
        quantity: Quantity.fromString('50'),
      });
      continue;
    }

    // One or two institutions for this asset.
    const institutionCount = random() < 0.5 ? 2 : 1;
    let heldTotal = 0;
    for (let j = 0; j < institutionCount; j += 1) {
      const quantity = pick(QUANTITIES);
      const unitPrice = pick(UNIT_PRICES);
      heldTotal += quantity;
      positions.push(
        aPosition({
          assetId,
          institutionId: institutions[(i + j) % institutions.length] ?? null,
          quantity: Quantity.fromString(String(quantity)),
          // value = quantity × unit price, exact decimal arithmetic throughout.
          value: Money.fromString(unitPrice).times(Quantity.fromString(String(quantity))),
          costBasis: Money.fromString(unitPrice)
            .times(Quantity.fromString(String(quantity)))
            .times('0.8'),
          // BR-011-15: fixed income is accrued, therefore estimated.
          estimated: FIXED_INCOME.has(assetClass),
        }),
      );
    }

    // Allocation shape: none, partial, full, or split across several wallets.
    // Integer quantities, as a real allocation would be, and never exceeding
    // what is held (SPEC-010 BR-010-05).
    const shape = Math.floor(random() * 4);
    if (shape === 0) {
      // Wholly unassigned — the Unassigned bucket must carry all of it.
    } else if (shape === 1) {
      allocations.push({
        walletId: walletIds[0] as WalletId,
        assetId,
        quantity: Quantity.fromString(String(heldTotal)),
      });
    } else if (shape === 2) {
      // Partial: a third, leaving a remainder for Unassigned.
      const part = Math.floor(heldTotal / 3);
      if (part > 0) {
        allocations.push({
          walletId: walletIds[1] as WalletId,
          assetId,
          quantity: Quantity.fromString(String(part)),
        });
      }
    } else {
      // Split across three wallets, leaving a remainder.
      const a = Math.floor(heldTotal / 3);
      const b = Math.floor(heldTotal / 5);
      const c = Math.floor(heldTotal / 7);
      for (const [index, part] of [a, b, c].entries()) {
        if (part > 0) {
          allocations.push({
            walletId: walletIds[index] as WalletId,
            assetId,
            quantity: Quantity.fromString(String(part)),
          });
        }
      }
    }
  }

  return { positions, allocations, assets, walletIds };
}

export function scopesFor(walletIds: readonly WalletId[]): readonly Scope[] {
  return [
    { kind: 'portfolio' },
    ...walletIds.map((walletId): Scope => ({ kind: 'wallet', walletId })),
  ];
}

export const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 20260814, 987654321];
