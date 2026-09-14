import { describe, expect, it } from 'vitest';
import { PersonalDatabaseRefusedError, refusalFor } from '@/db/personal-guard';

describe('refusalFor (SPEC-021 BR-021-08)', () => {
  it('refuses a database carrying the personal marker, naming it', () => {
    const refusal = refusalFor({ database: 'allmywallet', role: 'personal' });

    expect(refusal).toBeInstanceOf(PersonalDatabaseRefusedError);
    expect(refusal?.database).toBe('allmywallet');
    expect(refusal?.message).toContain('"allmywallet"');
  });

  it('lets an unmarked database through', () => {
    expect(refusalFor({ database: 'allmywallet', role: null })).toBeNull();
  });

  it('reads an empty setting as absent', () => {
    // `current_setting(name, true)` returns '' rather than NULL in a session
    // where the placeholder was once set and then reset.
    expect(refusalFor({ database: 'allmywallet', role: '' })).toBeNull();
  });

  it('does not treat any other value as personal', () => {
    expect(refusalFor({ database: 'allmywallet', role: 'Personal' })).toBeNull();
  });
});
