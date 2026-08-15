import type { Clock } from '@/core/shared/clock';
import type {
  AccountDeletionPort,
  AuditLogPort,
  ConsentRepository,
  NotificationPort,
  PersonalDataExportPort,
} from '@/core/privacy/ports';

/** What every privacy use case needs, injected at the composition root (AR-02). */
export interface PrivacyDependencies {
  readonly consents: ConsentRepository;
  readonly auditLog: AuditLogPort;
  readonly exportData: PersonalDataExportPort;
  readonly accountDeletion: AccountDeletionPort;
  readonly notifications: NotificationPort;
  readonly clock: Clock;
}
