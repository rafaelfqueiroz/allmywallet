import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
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

  async findWallet(walletId: WalletId): Promise<ReportWallet | null> {
    this.calls.push(`findWallet:${walletId}`);
    return this.data.wallets.find((wallet) => wallet.walletId === walletId) ?? null;
  }
}
