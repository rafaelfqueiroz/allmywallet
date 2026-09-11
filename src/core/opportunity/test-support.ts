import { FakeClock } from '@/core/shared/clock';
import { AssetId, ConsentId, OpportunityRuleId, UserId } from '@/core/shared/ids';
import type { OpportunityNotificationId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { AssetClass, Asset } from '@/core/quotes/ports';
import { FakeAssetCatalog } from '@/core/quotes/test-support';
import { FakeConsentRepository } from '@/core/privacy/test-support/fake-repositories';
import type { ConsentRecord } from '@/core/privacy/ports';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import type {
  HeldAssetReader,
  OpportunityAlert,
  OpportunityBound,
  OpportunityNotificationLog,
  OpportunityNotifier,
  OpportunityRule,
  OpportunityRuleRepository,
  OpportunityState,
  StoredQuote,
  StoredQuoteReader,
} from '@/core/opportunity/ports';

/**
 * TS-02: hand-written fakes implementing the real port interfaces — no
 * mocking library. TS-01: every `core/opportunity` use-case test runs with no
 * database; the SQL these stand in for belongs to another agent's
 * `tests/integration/` and `tests/isolation/` suites.
 *
 * Excluded from coverage (`vitest.config.ts`) for the same reason
 * `core/reporting/test-support.ts` is: measuring a fake port's convenience
 * defaults would pull the 100%-branch gate onto test scaffolding instead of
 * onto the decisions the gate exists to protect.
 */

/** Deterministic, readable ids. `n` is up to three hex digits. */
function uuid(prefix: string, n: string): string {
  return `01920000-0000-7000-8000-00000000${prefix}${n.padStart(3, '0')}`;
}

// `prefix` must itself be a hex digit (0-9a-f) — it lands inside the UUID's
// hex groups, not beside them.
export const userIdOf = (n: string): UserId => UserId.of(uuid('d', n));
export const assetIdOf = (n: string): AssetId => AssetId.of(uuid('a', n));
export const ruleIdOf = (n: string): OpportunityRuleId => OpportunityRuleId.of(uuid('e', n));

export const money = (value: string): Money => Money.fromString(value);
export const qty = (value: string): Quantity => Quantity.fromString(value);

export function aBound(price: string, state: OpportunityState): OpportunityBound {
  return { price: money(price), state };
}

const DEFAULT_RULE: OpportunityRule = {
  id: ruleIdOf('1'),
  userId: userIdOf('1'),
  assetId: assetIdOf('1'),
  lower: aBound('30', 'buy'),
  upper: aBound('40', 'sell'),
  defaultState: 'hold',
  lastState: null,
  lastEvaluatedAt: null,
  active: true,
  muted: false,
};

/** TS-22 — a builder with sensible defaults; a test states only what it cares about. */
export function aRule(overrides: Partial<OpportunityRule>): OpportunityRule {
  return { ...DEFAULT_RULE, ...overrides };
}

export function aQuote(overrides: Partial<StoredQuote>): StoredQuote {
  return {
    price: money('35'),
    quotedAt: new Date('2026-03-16T13:00:00Z'),
    fetchedAt: new Date('2026-03-16T13:00:00Z'),
    source: 'brapi',
    // The common case; a Tesouro Direto close is `tier: 'daily'` and the
    // tests that care say so.
    tier: 'intraday',
    ...overrides,
  };
}

/** BR-018-25 — a granted `email_reminders` consent, ready to `deps.consents.upsert(...)`. */
export function aConsent(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: ConsentId.generate(),
    userId: userIdOf('1'),
    purpose: 'email_reminders',
    grantedAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null,
    policyVersion: 'v1',
    ...overrides,
  };
}

export function anAsset(overrides: Partial<Asset>): Asset {
  return {
    id: assetIdOf('1'),
    code: 'PETR4',
    name: 'Petrobras PN',
    assetClass: 'stock',
    ...overrides,
  };
}

export class FakeOpportunityRuleRepository implements OpportunityRuleRepository {
  #rows = new Map<OpportunityRuleId, OpportunityRule>();

  async findByAsset(assetId: AssetId): Promise<OpportunityRule | null> {
    return [...this.#rows.values()].find((rule) => rule.assetId === assetId) ?? null;
  }

  async listAll(): Promise<readonly OpportunityRule[]> {
    return [...this.#rows.values()];
  }

  async listActiveForAssets(assetIds: readonly AssetId[]): Promise<readonly OpportunityRule[]> {
    const wanted = new Set(assetIds);
    return [...this.#rows.values()].filter((rule) => rule.active && wanted.has(rule.assetId));
  }

  async insert(rule: OpportunityRule): Promise<void> {
    this.#rows.set(rule.id, rule);
  }

  async update(rule: OpportunityRule): Promise<void> {
    this.#rows.set(rule.id, rule);
  }

  async delete(id: OpportunityRuleId): Promise<void> {
    this.#rows.delete(id);
  }

  async recordObservation(id: OpportunityRuleId, state: OpportunityState, at: Date): Promise<void> {
    const existing = this.#rows.get(id);
    if (existing === undefined) return;
    this.#rows.set(id, { ...existing, lastState: state, lastEvaluatedAt: at });
  }

  async setActive(ids: readonly OpportunityRuleId[], active: boolean): Promise<void> {
    for (const id of ids) {
      const existing = this.#rows.get(id);
      if (existing !== undefined) this.#rows.set(id, { ...existing, active });
    }
  }

  /** Test setup helper — seeds a row without going through a use case. */
  seed(rule: OpportunityRule): void {
    this.#rows.set(rule.id, rule);
  }
}

interface LogEntry {
  readonly id: OpportunityNotificationId;
  readonly userId: UserId;
  readonly ruleId: OpportunityRuleId;
  readonly state: OpportunityState;
  readonly quoteObservedAt: Date;
  readonly sentAt: Date;
}

function logKey(ruleId: OpportunityRuleId, state: OpportunityState, quoteObservedAt: Date): string {
  return `${ruleId}|${state}|${quoteObservedAt.toISOString()}`;
}

export class FakeOpportunityNotificationLog implements OpportunityNotificationLog {
  #claimed = new Map<string, LogEntry>();

  async claim(entry: LogEntry): Promise<boolean> {
    const key = logKey(entry.ruleId, entry.state, entry.quoteObservedAt);
    if (this.#claimed.has(key)) return false;
    this.#claimed.set(key, entry);
    return true;
  }

  async lastSentAt(ruleId: OpportunityRuleId): Promise<Date | null> {
    let latest: Date | null = null;
    for (const entry of this.#claimed.values()) {
      if (entry.ruleId !== ruleId) continue;
      if (latest === null || entry.sentAt > latest) latest = entry.sentAt;
    }
    return latest;
  }

  async lastSentAtByRule(
    ruleIds: readonly OpportunityRuleId[],
  ): Promise<ReadonlyMap<OpportunityRuleId, Date>> {
    const result = new Map<OpportunityRuleId, Date>();
    for (const ruleId of ruleIds) {
      const at = await this.lastSentAt(ruleId);
      if (at !== null) result.set(ruleId, at);
    }
    return result;
  }

  /** Test assertion helper — every entry this fake ever claimed. */
  get entries(): readonly LogEntry[] {
    return [...this.#claimed.values()];
  }
}

export class FakeOpportunityNotifier implements OpportunityNotifier {
  readonly sent: { userId: UserId; alert: OpportunityAlert }[] = [];

  async sendStateChange(userId: UserId, alert: OpportunityAlert): Promise<void> {
    this.sent.push({ userId, alert });
  }
}

export class FakeStoredQuoteReader implements StoredQuoteReader {
  #quotes = new Map<AssetId, StoredQuote>();

  /** How many times `latestFor` has been called — proves BR-018-11's "zero provider requests" indirectly: this is the *only* read path evaluation has. */
  calls = 0;

  set(assetId: AssetId, quote: StoredQuote): void {
    this.#quotes.set(assetId, quote);
  }

  async latestFor(assetIds: readonly AssetId[]): Promise<ReadonlyMap<AssetId, StoredQuote>> {
    this.calls += 1;
    const result = new Map<AssetId, StoredQuote>();
    for (const assetId of assetIds) {
      const quote = this.#quotes.get(assetId);
      if (quote !== undefined) result.set(assetId, quote);
    }
    return result;
  }
}

export class FakeHeldAssetReader implements HeldAssetReader {
  #rows: { assetId: AssetId; assetClass: AssetClass; quantity: Quantity }[] = [];

  set(rows: readonly { assetId: AssetId; assetClass: AssetClass; quantity: Quantity }[]): void {
    this.#rows = [...rows];
  }

  async listHeld(): Promise<
    readonly { assetId: AssetId; assetClass: AssetClass; quantity: Quantity }[]
  > {
    return this.#rows;
  }
}

/** Test-only bundle of every fake, for the common case of not caring which one a test exercises. */
export interface FakeOpportunityDependencies extends OpportunityDependencies {
  readonly rules: FakeOpportunityRuleRepository;
  readonly heldAssets: FakeHeldAssetReader;
  readonly quotes: FakeStoredQuoteReader;
  readonly catalog: FakeAssetCatalog;
  readonly notificationLog: FakeOpportunityNotificationLog;
  readonly notifier: FakeOpportunityNotifier;
  readonly consents: FakeConsentRepository;
  readonly clock: FakeClock;
}

export function buildFakeOpportunityDeps(
  now: Date | string = '2026-03-16T13:00:00Z',
): FakeOpportunityDependencies {
  return {
    rules: new FakeOpportunityRuleRepository(),
    heldAssets: new FakeHeldAssetReader(),
    quotes: new FakeStoredQuoteReader(),
    catalog: new FakeAssetCatalog(),
    notificationLog: new FakeOpportunityNotificationLog(),
    notifier: new FakeOpportunityNotifier(),
    consents: new FakeConsentRepository(),
    clock: new FakeClock(now),
  };
}
