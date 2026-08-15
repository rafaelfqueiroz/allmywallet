import { FakeClock } from '@/core/shared/clock';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import {
  FakeAccountDeletionPort,
  FakeAuditLogPort,
  FakeConsentRepository,
  FakeNotificationPort,
  FakePersonalDataExportPort,
} from '@/core/privacy/test-support/fake-repositories';

export interface FakePrivacyDependencies extends PrivacyDependencies {
  readonly consents: FakeConsentRepository;
  readonly auditLog: FakeAuditLogPort;
  readonly exportData: FakePersonalDataExportPort;
  readonly accountDeletion: FakeAccountDeletionPort;
  readonly notifications: FakeNotificationPort;
  readonly clock: FakeClock;
}

export function buildFakeDeps(
  now: Date | string = '2026-03-15T12:00:00Z',
): FakePrivacyDependencies {
  return {
    consents: new FakeConsentRepository(),
    auditLog: new FakeAuditLogPort(),
    exportData: new FakePersonalDataExportPort(),
    accountDeletion: new FakeAccountDeletionPort(),
    notifications: new FakeNotificationPort(),
    clock: new FakeClock(now),
  };
}
