import type { UserId } from '@/core/shared/ids';

/**
 * The tenant root. SPEC-001 BR-001-05: this is the complete set of personal
 * data the product stores about a user — Google subject id, email, display
 * name, profile picture URL — and nothing else.
 */
export interface User {
  readonly id: UserId;
  readonly googleSubjectId: string;
  readonly email: string;
  readonly name: string | null;
  readonly imageUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertUserInput {
  readonly googleSubjectId: string;
  readonly email: string;
  readonly name: string | null;
  readonly imageUrl: string | null;
}

/**
 * AR-02/AR-03: declared in `core/` next to the use case that needs it. The
 * seam is real, not speculative — DL-001-01 explicitly leaves room for a
 * second identity provider later, and this is the boundary that would move.
 */
export interface UserRepository {
  /**
   * SPEC-001 BR-001-04: idempotent — a retried OAuth callback carrying the
   * same `googleSubjectId` must resolve to the same row, never create a
   * second tenant. SPEC-001 DL-001-02: matched on `googleSubjectId`, never on
   * email, because email is allowed to change at Google and must not fork or
   * merge an account.
   */
  upsertByGoogleSubject(input: UpsertUserInput): Promise<User>;
  findById(id: UserId): Promise<User | null>;
}
