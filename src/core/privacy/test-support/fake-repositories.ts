import type { UserId } from '@/core/shared/ids';
import type {
  AccountDeletionPort,
  AccountDeletionStatus,
  AuditEntry,
  AuditLogPort,
  ConsentPurpose,
  ConsentRecord,
  ConsentRepository,
  ExportedAllocation,
  ExportedFixedIncomeContract,
  ExportedPreference,
  ExportedProfile,
  ExportedTransaction,
  ExportedWallet,
  NotificationPort,
  PersonalDataExportPort,
} from '@/core/privacy/ports';

/**
 * TS-02: hand-written fakes implementing the real port interfaces — no
 * mocking library. TS-01: every `core/privacy` use-case test runs with no
 * database; the SQL these stand in for is proven for real in
 * `tests/integration/` and `tests/isolation/`.
 */

function key(userId: UserId, purpose: ConsentPurpose): string {
  return `${userId}|${purpose}`;
}

export class FakeConsentRepository implements ConsentRepository {
  #rows = new Map<string, ConsentRecord>();

  async findByPurpose(userId: UserId, purpose: ConsentPurpose): Promise<ConsentRecord | null> {
    return this.#rows.get(key(userId, purpose)) ?? null;
  }

  async listForUser(userId: UserId): Promise<readonly ConsentRecord[]> {
    return [...this.#rows.values()].filter((row) => row.userId === userId);
  }

  async upsert(record: ConsentRecord): Promise<void> {
    this.#rows.set(key(record.userId, record.purpose), record);
  }

  /** Test setup helper — seeds a row without going through a use case. */
  seed(record: ConsentRecord): void {
    this.#rows.set(key(record.userId, record.purpose), record);
  }
}

export class FakeAuditLogPort implements AuditLogPort {
  entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async purgeOlderThan(_cutoff: Date): Promise<number> {
    return 0;
  }
}

export class FakePersonalDataExportPort implements PersonalDataExportPort {
  profile: ExportedProfile | null = null;
  transactions: ExportedTransaction[] = [];
  wallets: ExportedWallet[] = [];
  allocations: ExportedAllocation[] = [];
  fixedIncomeContracts: ExportedFixedIncomeContract[] = [];
  preferences: ExportedPreference[] = [];

  async loadProfile(_userId: UserId): Promise<ExportedProfile | null> {
    return this.profile;
  }

  async loadTransactions(_userId: UserId): Promise<readonly ExportedTransaction[]> {
    return this.transactions;
  }

  async loadWallets(_userId: UserId): Promise<readonly ExportedWallet[]> {
    return this.wallets;
  }

  async loadAllocations(_userId: UserId): Promise<readonly ExportedAllocation[]> {
    return this.allocations;
  }

  async loadFixedIncomeContracts(_userId: UserId): Promise<readonly ExportedFixedIncomeContract[]> {
    return this.fixedIncomeContracts;
  }

  async loadPreferences(_userId: UserId): Promise<readonly ExportedPreference[]> {
    return this.preferences;
  }
}

export class FakeAccountDeletionPort implements AccountDeletionPort {
  #statuses = new Map<UserId, AccountDeletionStatus>();
  #sessionsRevoked = new Set<UserId>();
  purgedUserIds: UserId[] = [];

  async findStatus(userId: UserId): Promise<AccountDeletionStatus | null> {
    return this.#statuses.get(userId) ?? null;
  }

  async revokeSessions(userId: UserId): Promise<void> {
    this.#sessionsRevoked.add(userId);
  }

  sessionsRevokedFor(userId: UserId): boolean {
    return this.#sessionsRevoked.has(userId);
  }

  async markDeletionRequested(userId: UserId, requestedAt: Date): Promise<void> {
    this.#statuses.set(userId, { userId, deletionRequestedAt: requestedAt });
  }

  async clearDeletionRequest(userId: UserId): Promise<void> {
    this.#statuses.set(userId, { userId, deletionRequestedAt: null });
  }

  async findDueForPurge(cutoff: Date): Promise<readonly UserId[]> {
    return [...this.#statuses.values()]
      .filter(
        (status) => status.deletionRequestedAt !== null && status.deletionRequestedAt <= cutoff,
      )
      .map((status) => status.userId);
  }

  async purgeUser(userId: UserId): Promise<void> {
    this.#statuses.delete(userId);
    this.purgedUserIds.push(userId);
  }

  /** Test setup helper. */
  seedStatus(status: AccountDeletionStatus): void {
    this.#statuses.set(status.userId, status);
  }
}

export class FakeNotificationPort implements NotificationPort {
  deletionRequestedSentTo: UserId[] = [];
  deletionCompletedSentTo: UserId[] = [];

  async sendAccountDeletionRequested(userId: UserId, _purgeAt: Date): Promise<void> {
    this.deletionRequestedSentTo.push(userId);
  }

  async sendAccountDeletionCompleted(userId: UserId): Promise<void> {
    this.deletionCompletedSentTo.push(userId);
  }
}
