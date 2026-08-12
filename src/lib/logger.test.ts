import { describe, expect, it } from 'vitest';
import { hashUserId } from '@/lib/logger';

describe('hashUserId', () => {
  const userId = '0195f3a0-8b2c-7c4a-9f1e-2d3c4b5a6978';

  it('is stable, so a user’s requests can be correlated', () => {
    expect(hashUserId(userId)).toBe(hashUserId(userId));
  });

  it('is not reversible to the id it came from', () => {
    // AR-49: logs carry a *hashed* user id — never an email, a name or a CPF,
    // and never the raw id either, which is a join key into everything.
    const hashed = hashUserId(userId);
    expect(hashed).not.toContain(userId);
    expect(userId).not.toContain(hashed);
  });

  it('separates two users', () => {
    expect(hashUserId(userId)).not.toBe(hashUserId('0195f3a0-8b2c-7c4a-9f1e-2d3c4b5a6979'));
  });

  it('is short enough that nobody mistakes it for an id', () => {
    expect(hashUserId(userId)).toHaveLength(16);
    expect(hashUserId(userId)).toMatch(/^[0-9a-f]{16}$/);
  });
});
