import type { DomainError } from '@/core/shared/domain-error';
import { ConsentId, type UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import { PrivacyErrorCode, privacyError } from '@/core/privacy/errors';
import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type ConsentRecord,
  isConsentPurpose,
} from '@/core/privacy/ports';

/**
 * SPEC-004 BR-004-06/07: granular, opt-in, separately revocable consent, each
 * decision recorded with a purpose, a timestamp and the policy version in
 * force at that moment.
 */

export interface GrantConsentInput {
  readonly purpose: ConsentPurpose;
  readonly policyVersion: string;
}

/** SPEC-004 BR-004-06/07: recording a grant. Idempotent — granting an already-granted purpose just refreshes the timestamp/policy version. */
export async function grantConsent(
  deps: PrivacyDependencies,
  userId: UserId,
  input: GrantConsentInput,
): Promise<Result<ConsentRecord, DomainError>> {
  if (!isConsentPurpose(input.purpose)) {
    return err(privacyError(PrivacyErrorCode.INVALID_CONSENT_PURPOSE, { purpose: input.purpose }));
  }

  const existing = await deps.consents.findByPurpose(userId, input.purpose);
  const record: ConsentRecord = {
    id: existing?.id ?? ConsentId.generate(),
    userId,
    purpose: input.purpose,
    grantedAt: deps.clock.now(),
    revokedAt: null,
    policyVersion: input.policyVersion,
  };
  await deps.consents.upsert(record);

  // BR-004-07: "recorded... with purpose, timestamp and policy version" — the
  // `consents` row above is the current-state read; this is the append-only
  // decision trail (src/db/schema/privacy.ts's comment on why both exist).
  await deps.auditLog.record({
    actor: userId,
    userId,
    action: 'consent.granted',
    entityType: 'consent',
    entityKey: input.purpose,
    previousValue: existing ? serializeConsent(existing) : null,
    newValue: serializeConsent(record),
  });

  return ok(record);
}

/**
 * SPEC-004 BR-004-06/08: revocation is per-purpose and never touches any
 * other purpose or any other module. This use case's dependencies
 * (`PrivacyDependencies`) hold no ledger/wallet/report port at all — BR-004-08
 * ("revoking optional consent never degrades core functionality") is not
 * merely tested, it is structurally impossible to violate from inside this
 * function, since it has no capability to reach anything but `consents` and
 * `auditLog`.
 */
export async function revokeConsent(
  deps: PrivacyDependencies,
  userId: UserId,
  purpose: ConsentPurpose,
): Promise<Result<ConsentRecord, DomainError>> {
  if (!isConsentPurpose(purpose)) {
    return err(privacyError(PrivacyErrorCode.INVALID_CONSENT_PURPOSE, { purpose }));
  }

  const existing = await deps.consents.findByPurpose(userId, purpose);
  if (existing === null || existing.grantedAt === null || existing.revokedAt !== null) {
    return err(privacyError(PrivacyErrorCode.CONSENT_NOT_GRANTED, { purpose }));
  }

  const record: ConsentRecord = { ...existing, revokedAt: deps.clock.now() };
  await deps.consents.upsert(record);

  await deps.auditLog.record({
    actor: userId,
    userId,
    action: 'consent.revoked',
    entityType: 'consent',
    entityKey: purpose,
    previousValue: serializeConsent(existing),
    newValue: serializeConsent(record),
  });

  return ok(record);
}

export interface ConsentState {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly grantedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly policyVersion: string | null;
}

/** Every declared purpose, decided or not — a purpose with no row reads as `granted: false`. */
export async function listConsents(
  deps: PrivacyDependencies,
  userId: UserId,
): Promise<readonly ConsentState[]> {
  const records = await deps.consents.listForUser(userId);
  const byPurpose = new Map(records.map((record) => [record.purpose, record] as const));

  return CONSENT_PURPOSES.map((purpose) => {
    const record = byPurpose.get(purpose);
    return {
      purpose,
      granted: record !== undefined && record.grantedAt !== null && record.revokedAt === null,
      grantedAt: record?.grantedAt ?? null,
      revokedAt: record?.revokedAt ?? null,
      policyVersion: record?.policyVersion ?? null,
    };
  });
}

function serializeConsent(record: ConsentRecord): Record<string, unknown> {
  return {
    purpose: record.purpose,
    grantedAt: record.grantedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    policyVersion: record.policyVersion,
  };
}
