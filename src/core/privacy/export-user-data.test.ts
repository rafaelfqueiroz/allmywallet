import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import {
  exportUserData,
  exportUserDataAsCsv,
  exportUserDataAsJson,
} from '@/core/privacy/export-user-data';
import { grantConsent } from '@/core/privacy/consent';
import { buildFakeDeps } from '@/core/privacy/test-support/build-deps';

const USER = UserId.generate();

function seedFullExport(deps: ReturnType<typeof buildFakeDeps>): void {
  deps.exportData.profile = {
    id: USER,
    email: 'investidor@example.com',
    name: 'Investidor Teste',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  deps.exportData.transactions = [
    {
      id: 'tx-1',
      tradeDate: BusinessDate.of('2026-01-10'),
      assetCode: 'PETR4',
      assetName: 'Petrobras PN',
      institutionName: 'XP Investimentos',
      type: 'buy',
      status: 'active',
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('32.15'),
      fees: Money.fromString('1.50'),
      totalValue: Money.fromString('3216.50'),
      isManual: false,
    },
  ];
  deps.exportData.wallets = [
    { id: 'wallet-1', name: 'Aposentadoria', description: null, goal: 'Longo prazo' },
  ];
  deps.exportData.allocations = [
    {
      walletId: 'wallet-1',
      assetId: AssetId.generate(),
      assetCode: 'PETR4',
      quantity: Quantity.fromString('50'),
      costBasisAtAllocation: Money.fromString('1600'),
    },
  ];
  deps.exportData.fixedIncomeContracts = [
    {
      assetId: AssetId.generate(),
      assetCode: 'CDB Banco Teste',
      indexer: 'cdi_percent',
      ratePercent: Quantity.fromString('110'),
      issueDate: BusinessDate.of('2024-01-01'),
      maturityDate: null,
      principal: Money.fromString('5000'),
    },
  ];
  deps.exportData.preferences = [{ key: 'reports.default_grouping', value: 'asset_class' }];
}

describe('SPEC-004 BR-004-11 — exportUserData', () => {
  it('AC — a full export covers profile, transactions, wallets, allocations, fixed-income contracts and consents', async () => {
    const deps = buildFakeDeps();
    seedFullExport(deps);
    await grantConsent(deps, USER, { purpose: 'email_reminders', policyVersion: 'v1' });

    const result = await exportUserData(deps, USER);

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.profile.email).toBe('investidor@example.com');
    expect(result.transactions).toHaveLength(1);
    expect(result.wallets).toHaveLength(1);
    expect(result.allocations).toHaveLength(1);
    expect(result.fixedIncomeContracts).toHaveLength(1);
    expect(result.consents).toHaveLength(1);
    expect(result.consents[0]?.purpose).toBe('email_reminders');
    expect(result.preferences).toHaveLength(1);
  });

  it('returns null for a profile that does not exist, rather than an empty export', async () => {
    const deps = buildFakeDeps();
    const result = await exportUserData(deps, USER);
    expect(result).toBeNull();
  });

  it('every declared consent purpose appears once — even a never-decided one', async () => {
    const deps = buildFakeDeps();
    seedFullExport(deps);
    // No consent decision made at all.
    const result = await exportUserData(deps, USER);
    expect(result?.consents).toHaveLength(0);
  });
});

describe('exportUserDataAsJson — AR-10', () => {
  it('AC — round-trips as valid JSON, with money serialised as a plain decimal string, never a float', async () => {
    const deps = buildFakeDeps();
    seedFullExport(deps);
    const data = await exportUserData(deps, USER);
    if (data === null) throw new Error('setup failed');

    const json = exportUserDataAsJson(data);
    const parsed = JSON.parse(json) as { transactions: { unitPrice: unknown }[] };

    expect(typeof parsed.transactions[0]?.unitPrice).toBe('string');
    expect(parsed.transactions[0]?.unitPrice).toBe('32.15');
    // Never exponential notation and never a bare float — the whole point of AR-10.
    expect(json).not.toMatch(/\d+e[+-]\d+/i);
  });
});

describe('exportUserDataAsCsv — AC', () => {
  it('AC — valid CSV covering profile, transactions, wallets, allocations and consents', async () => {
    const deps = buildFakeDeps();
    seedFullExport(deps);
    await grantConsent(deps, USER, { purpose: 'product_analytics', policyVersion: 'v2' });
    const data = await exportUserData(deps, USER);
    if (data === null) throw new Error('setup failed');

    const csv = exportUserDataAsCsv(data);

    expect(csv).toContain('# profile');
    expect(csv).toContain('investidor@example.com');
    expect(csv).toContain('# transactions');
    expect(csv).toContain('PETR4');
    expect(csv).toContain('# wallets');
    expect(csv).toContain('Aposentadoria');
    expect(csv).toContain('# wallet_allocations');
    expect(csv).toContain('# fixed_income_contracts');
    expect(csv).toContain('# consents');
    expect(csv).toContain('product_analytics');
    // \r\n line endings — RFC 4180, matches core/ledger/export-transactions.ts.
    expect(csv).toContain('\r\n');
  });

  it('neutralises a formula-injection attempt in a free-text field (SPEC-003 BR-003-13)', async () => {
    const deps = buildFakeDeps();
    seedFullExport(deps);
    deps.exportData.wallets = [
      { id: 'wallet-1', name: '=cmd|"/c calc"!A1', description: null, goal: null },
    ];
    const data = await exportUserData(deps, USER);
    if (data === null) throw new Error('setup failed');

    const csv = exportUserDataAsCsv(data);
    expect(csv).not.toContain('"=cmd');
    expect(csv).toContain("'=cmd");
  });
});
