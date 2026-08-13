import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import type { UpsertUserInput, User, UserRepository } from './ports';
import { provisionTenant } from './provision-tenant';

/**
 * TS-02: a hand-written fake implementing the real port, not a mocking
 * library — it stays honest when the interface changes, and here it also
 * doubles as a spec of what the Drizzle repository's `ON CONFLICT
 * (google_subject_id) DO UPDATE` must behave like: upsert keyed on
 * `googleSubjectId`, same id returned on every call for the same subject.
 */
class FakeUserRepository implements UserRepository {
  private readonly bySubject = new Map<string, User>();
  private readonly byId = new Map<string, User>();
  callCount = 0;

  async upsertByGoogleSubject(input: UpsertUserInput): Promise<User> {
    this.callCount += 1;
    const existing = this.bySubject.get(input.googleSubjectId);
    const now = new Date();
    const user: User = existing
      ? {
          ...existing,
          email: input.email,
          name: input.name,
          imageUrl: input.imageUrl,
          updatedAt: now,
        }
      : {
          id: UserId.generate(),
          googleSubjectId: input.googleSubjectId,
          email: input.email,
          name: input.name,
          imageUrl: input.imageUrl,
          createdAt: now,
          updatedAt: now,
        };
    this.bySubject.set(input.googleSubjectId, user);
    this.byId.set(user.id, user);
    return user;
  }

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
}

describe('provisionTenant (SPEC-001 BR-001-04)', () => {
  it('creates exactly one tenant on first sign-in', async () => {
    const repository = new FakeUserRepository();
    const user = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-1',
      email: 'a@example.com',
      name: 'Ada',
      imageUrl: null,
    });
    expect(user.googleSubjectId).toBe('google-sub-1');
    expect(repository.callCount).toBe(1);
  });

  it('a retried callback for the same Google account does not create a second tenant', async () => {
    const repository = new FakeUserRepository();
    const first = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-1',
      email: 'a@example.com',
      name: 'Ada',
      imageUrl: null,
    });
    // Same subject, exactly as a replayed/retried OAuth callback would look.
    const second = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-1',
      email: 'a@example.com',
      name: 'Ada',
      imageUrl: null,
    });
    expect(second.id).toBe(first.id);
    expect(repository.callCount).toBe(2);
  });

  it('an email change at Google preserves the same tenant (DL-001-02)', async () => {
    const repository = new FakeUserRepository();
    const first = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-1',
      email: 'old@example.com',
      name: 'Ada',
      imageUrl: null,
    });

    const changed = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-1',
      email: 'new@example.com',
      name: 'Ada',
      imageUrl: null,
    });

    expect(changed.id).toBe(first.id);
    expect(changed.email).toBe('new@example.com');
  });

  it('two Google accounts never collapse into one tenant', async () => {
    const repository = new FakeUserRepository();
    const a = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-a',
      email: 'shared@example.com',
      name: 'A',
      imageUrl: null,
    });
    const b = await provisionTenant(repository, {
      googleSubjectId: 'google-sub-b',
      email: 'shared@example.com',
      name: 'B',
      imageUrl: null,
    });
    expect(a.id).not.toBe(b.id);
  });
});
