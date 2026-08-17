import type { AssetId, ConsentId, InstitutionId, UserId } from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { BusinessDate } from '@/core/shared/clock';

/**
 * AR-02: ports declared in `core/`, next to the use cases that need them.
 * `adapters/db/` implements them; hand-written fakes in `test-support/`
 * implement them for use-case tests (TS-02).
 */

// ---------------------------------------------------------------------------
// Consent (BR-004-05..08)
// ---------------------------------------------------------------------------

/**
 * BR-004-05: contract execution covers the investment data the service needs
 * to function — there is no consent purpose for that, because there is
 * nothing to opt into. Consent exists only for what is genuinely optional.
 * `product_analytics` has no consumer yet (no analytics pipeline exists) but
 * is declared now so BR-004-06's "any future analytics" has a purpose to
 * attach to rather than a schema change when it lands.
 *
 * The canonical list — `src/db/schema/privacy.ts`'s CHECK constraint imports
 * this rather than declaring its own, so the domain and the database can
 * never quietly disagree about which purposes exist (the same discipline
 * `TRANSACTION_TYPES`/`TRANSACTION_STATUSES` use for `transactions`).
 */
export const CONSENT_PURPOSES = ['email_reminders', 'product_analytics'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export function isConsentPurpose(value: string): value is ConsentPurpose {
  return (CONSENT_PURPOSES as readonly string[]).includes(value);
}

/**
 * BR-004-06/07: the *current* state of one user's decision for one purpose.
 * `grantedAt`/`revokedAt` are timestamps of the latest decision, not a full
 * history — see `src/db/schema/privacy.ts`'s comment on `consents` for why
 * the append-only history lives in `audit_log` instead.
 */
export interface ConsentRecord {
  readonly id: ConsentId;
  readonly userId: UserId;
  readonly purpose: ConsentPurpose;
  readonly grantedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly policyVersion: string;
}

export interface ConsentRepository {
  findByPurpose(userId: UserId, purpose: ConsentPurpose): Promise<ConsentRecord | null>;
  listForUser(userId: UserId): Promise<readonly ConsentRecord[]>;
  /** Insert-or-replace the one row for `(userId, purpose)` — grant and revoke both call this. */
  upsert(record: ConsentRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit trail (BR-004-07/17)
// ---------------------------------------------------------------------------

/**
 * The same shape SPEC-002's `setConfigValue` already writes to `audit_log`
 * (`src/config/resolve.ts`) — this port is the seam so `core/privacy` can
 * write the same table without importing Drizzle (AR-01). `actor` mirrors
 * that call site: `'operator'`, `'system'`, or a user id string.
 */
export interface AuditEntry {
  readonly actor: string;
  /** SPEC-004 BR-004-17 — the account the entry is *about*, when there is one. Null for a system-wide entry. */
  readonly userId: UserId | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityKey: string;
  readonly previousValue?: unknown;
  readonly newValue?: unknown;
  /** Hashed, never raw (issue #7's data model: "ip hashed, never raw"). */
  readonly ipHash?: string | null;
}

export interface AuditLogPort {
  record(entry: AuditEntry): Promise<void>;
  /** BR-004-15: rows older than the retention window are purged by a scheduled sweep. Returns the number of rows removed. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// Export (BR-004-11)
// ---------------------------------------------------------------------------

/**
 * Every field here is already JSON/CSV-safe — `Money`/`Quantity` are the
 * domain's own value objects (whose `.toJSON()` is a plain decimal string,
 * AR-10), dates are real `Date`s the use case formats at the boundary, and
 * nothing here is a JS `number` standing in for money.
 */
export interface ExportedProfile {
  readonly id: UserId;
  readonly email: string;
  readonly name: string | null;
  readonly createdAt: Date;
}

export interface ExportedTransaction {
  readonly id: string;
  readonly tradeDate: BusinessDate;
  readonly assetCode: string;
  readonly assetName: string;
  readonly institutionName: string | null;
  readonly type: string;
  readonly status: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  readonly totalValue: Money;
  readonly isManual: boolean;
}

export interface ExportedWallet {
  readonly id: WalletExportId;
  readonly name: string;
  readonly description: string | null;
  readonly goal: string | null;
}

/** Branded only within this file's export shape — the real `WalletId` is what every other module uses; this alias just documents the field's origin at the call site. */
export type WalletExportId = string;

export interface ExportedAllocation {
  readonly walletId: WalletExportId;
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly quantity: Quantity;
  readonly costBasisAtAllocation: Money | null;
}

export interface ExportedFixedIncomeContract {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly indexer: string | null;
  readonly ratePercent: Quantity | null;
  readonly issueDate: BusinessDate;
  readonly maturityDate: BusinessDate | null;
  readonly principal: Money | null;
}

export interface ExportedPreference {
  readonly key: string;
  readonly value: unknown;
}

export interface ExportedConsent {
  readonly purpose: ConsentPurpose;
  readonly grantedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly policyVersion: string;
}

/**
 * BR-004-11: "a complete export of personal and investment data" —
 * `institutionId` fields are folded into the readable `*Name` string the same
 * way `TransactionListItem` does it, since the export is meant to be read by
 * a human or a spreadsheet, not replayed back into the system.
 */
export interface PersonalDataExport {
  readonly profile: ExportedProfile;
  readonly transactions: readonly ExportedTransaction[];
  readonly wallets: readonly ExportedWallet[];
  readonly allocations: readonly ExportedAllocation[];
  readonly fixedIncomeContracts: readonly ExportedFixedIncomeContract[];
  readonly consents: readonly ExportedConsent[];
  readonly preferences: readonly ExportedPreference[];
}

export interface PersonalDataExportPort {
  loadProfile(userId: UserId): Promise<ExportedProfile | null>;
  loadTransactions(userId: UserId): Promise<readonly ExportedTransaction[]>;
  loadWallets(userId: UserId): Promise<readonly ExportedWallet[]>;
  loadAllocations(userId: UserId): Promise<readonly ExportedAllocation[]>;
  loadFixedIncomeContracts(userId: UserId): Promise<readonly ExportedFixedIncomeContract[]>;
  loadPreferences(userId: UserId): Promise<readonly ExportedPreference[]>;
}

// ---------------------------------------------------------------------------
// Account deletion (BR-004-09/10)
// ---------------------------------------------------------------------------

export interface AccountDeletionStatus {
  readonly userId: UserId;
  /** Null: no deletion requested. Set: the moment the self-service request landed. */
  readonly deletionRequestedAt: Date | null;
}

/**
 * `purgeUser` is the whole mechanism BR-004-10 relies on: AR-27 makes
 * `ON DELETE CASCADE` load-bearing precisely so that deleting the one `users`
 * row is deleting *everything* — there is no per-table cleanup list to keep
 * in sync, and `tests/isolation/deletion-cascade.test.ts` is what keeps that
 * true as new tables are added.
 */
export interface AccountDeletionPort {
  findStatus(userId: UserId): Promise<AccountDeletionStatus | null>;
  /** BR-004-09: access is revoked immediately — every session row for this user is deleted. */
  revokeSessions(userId: UserId): Promise<void>;
  markDeletionRequested(userId: UserId, requestedAt: Date): Promise<void>;
  /**
   * SPEC-004 BR-004-09's review window, taken seriously in both directions.
   * Clears `users.deletedAt`, so the account leaves `findDueForPurge`'s reach.
   */
  clearDeletionRequest(userId: UserId): Promise<void>;
  /**
   * Every account whose deletion was requested at or before `cutoff` —
   * `purgeDueAccounts` computes `cutoff = asOf - deletionWindowDays` and
   * passes it in already resolved, so the adapter is a single comparison
   * (`deletedAt <= cutoff`) against `users.deletedAt`
   * (SPEC-001's "deletion requested" marker, reused rather than duplicated —
   * see that column's own comment in `src/db/schema/users.ts`) with no
   * config or date-math knowledge of its own.
   */
  findDueForPurge(cutoff: Date): Promise<readonly UserId[]>;
  /** Irreversible. Deletes the `users` row; every tenant table cascades (AR-27). */
  purgeUser(userId: UserId): Promise<void>;
}

// ---------------------------------------------------------------------------
// Notification (BR-004-09's "confirmed by email")
// ---------------------------------------------------------------------------

/**
 * No email-sending adapter exists anywhere in the codebase yet (no
 * subprocessor has been chosen — SPEC-002's `import.reminder_enabled` is the
 * only other feature that will eventually need one, and it isn't built
 * either). This port is deliberately thin so a real provider is a one-adapter
 * change later; `src/adapters/notifications/log-notification-adapter.ts` is
 * the interim implementation, and its gap is called out in the #7 report
 * rather than papered over with a fake "sent" status.
 */
export interface NotificationPort {
  sendAccountDeletionRequested(userId: UserId, purgeAt: Date): Promise<void>;
  sendAccountDeletionCompleted(userId: UserId): Promise<void>;
}

// Re-exported so a consumer needing only the identifier types does not also
// have to import from `@/core/shared/ids` separately.
export type { InstitutionId };
