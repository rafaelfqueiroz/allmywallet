import { describe, expect, it } from 'vitest';
import { tenantIsolationPolicySql } from './rls';

describe('tenantIsolationPolicySql (AR-14)', () => {
  it('emits ENABLE, FORCE, and a policy with both USING and WITH CHECK', () => {
    const sql = tenantIsolationPolicySql('wallets');
    expect(sql).toContain('ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE wallets FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY tenant_isolation ON wallets');
    expect(sql).toMatch(/USING\s+\(user_id = current_setting\('app\.user_id'\)::uuid\)/);
    expect(sql).toMatch(/WITH CHECK \(user_id = current_setting\('app\.user_id'\)::uuid\)/);
  });

  it('produces byte-identical policy shape for every table (no drift between tables)', () => {
    const a = tenantIsolationPolicySql('wallets').replace(/wallets/g, '<t>');
    const b = tenantIsolationPolicySql('transactions').replace(/transactions/g, '<t>');
    expect(a).toBe(b);
  });

  it.each(['DROP TABLE users; --', 'Wallets', 'wallets;DROP', '', '123wallets', 'wallets table'])(
    'refuses a non-snake_case identifier: %s',
    (name) => {
      expect(() => tenantIsolationPolicySql(name)).toThrow(TypeError);
    },
  );

  it('accepts a plain snake_case identifier', () => {
    expect(() => tenantIsolationPolicySql('import_rows')).not.toThrow();
  });
});
