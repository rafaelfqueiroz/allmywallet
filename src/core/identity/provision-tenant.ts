import type { UpsertUserInput, User, UserRepository } from './ports';

/**
 * SPEC-001 BR-001-04: first successful sign-in creates exactly one `User`
 * record and its tenant context; a retried OAuth callback (the same Google
 * account signing in again, including a duplicate/replayed callback request)
 * must never create a second one. SPEC-001 BR-001-03/DL-001-02: identity is
 * keyed on the Google subject id (`sub`), not email, so a user changing their
 * email at Google still resolves to the same tenant.
 *
 * A thin wrapper around `UserRepository.upsertByGoogleSubject` — the
 * idempotent-upsert semantics live in the adapter, next to the SQL that makes
 * them atomic (`INSERT ... ON CONFLICT (google_subject_id) DO UPDATE`). This
 * use case exists as its own `core/` unit anyway (AR-02) because "first
 * sign-in provisions the tenant" is the seam SPEC-005's onboarding hand-off
 * hangs off of, and because it is what stays framework-free and testable
 * against a fake repository without a database (TS-01) — the test plan's
 * "provision-tenant idempotency" and "email change preserves the same
 * tenant" cases are exercised here, not against Postgres.
 */
export async function provisionTenant(
  userRepository: UserRepository,
  input: UpsertUserInput,
): Promise<User> {
  return userRepository.upsertByGoogleSubject(input);
}
