import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { isErr, isOk } from '@/core/shared/result';
import { ValuationErrorCode } from '@/core/valuation/ports';
import type { FixedIncomeContract, FixedIncomeIndexer } from '@/core/valuation/ports';
import {
  supplyContractTerms,
  type ContractTermsPort,
  type SupplyContractTermsInput,
} from '@/core/valuation/supply-contract-terms';

/**
 * SPEC-009 BR-009-13 / SPEC-020 BR-020-19. `core/valuation` carries a 100%
 * branch-coverage gate — every refusal below is a real state a form
 * submission or a retried request can be in, not a synthetic case.
 */

const CDB = AssetId.of('01920000-0000-7000-8000-0000000000a1');

const CONTRACT: FixedIncomeContract = {
  assetId: CDB,
  indexer: null,
  ratePercent: null,
  issueDate: BusinessDate.of('2026-01-10'),
  maturityDate: null,
  principal: Money.fromString('10000'),
};

class FakeContractTermsPort implements ContractTermsPort {
  updates: {
    readonly assetId: AssetId;
    readonly indexer: FixedIncomeIndexer;
    readonly ratePercent: Quantity;
  }[] = [];

  constructor(private contract: FixedIncomeContract | null) {}

  async findByAssetId(assetId: AssetId): Promise<FixedIncomeContract | null> {
    return this.contract && this.contract.assetId === assetId ? this.contract : null;
  }

  async updateTerms(input: {
    readonly assetId: AssetId;
    readonly indexer: FixedIncomeIndexer;
    readonly ratePercent: Quantity;
  }): Promise<void> {
    this.updates.push(input);
  }
}

function input(overrides: Partial<SupplyContractTermsInput> = {}): SupplyContractTermsInput {
  return { assetId: CDB, indexer: 'cdi_percent', ratePercent: '110', ...overrides };
}

describe('supplyContractTerms (BR-020-19)', () => {
  it('writes the indexer and rate for an existing contract', async () => {
    const port = new FakeContractTermsPort(CONTRACT);

    const result = await supplyContractTerms({ contracts: port }, input());

    expect(isOk(result)).toBe(true);
    expect(port.updates).toEqual([
      { assetId: CDB, indexer: 'cdi_percent', ratePercent: Quantity.fromString('110') },
    ]);
  });

  it('accepts every declared indexer', async () => {
    for (const indexer of ['cdi_percent', 'prefixado', 'ipca_spread'] as const) {
      const port = new FakeContractTermsPort(CONTRACT);
      const result = await supplyContractTerms({ contracts: port }, input({ indexer }));
      expect(isOk(result), indexer).toBe(true);
    }
  });

  it('refuses an asset with no contract row', async () => {
    const port = new FakeContractTermsPort(null);

    const result = await supplyContractTerms({ contracts: port }, input());

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(ValuationErrorCode.CONTRACT_TERMS_NOT_FOUND);
    }
    expect(port.updates).toEqual([]);
  });

  it('refuses an indexer outside FIXED_INCOME_INDEXERS', async () => {
    const port = new FakeContractTermsPort(CONTRACT);

    const result = await supplyContractTerms(
      { contracts: port },
      input({ indexer: 'selic' }),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe(ValuationErrorCode.INDEXER_INVALID);
    expect(port.updates).toEqual([]);
  });

  it('refuses a rate that does not parse as a decimal literal', async () => {
    const port = new FakeContractTermsPort(CONTRACT);

    const result = await supplyContractTerms(
      { contracts: port },
      input({ ratePercent: 'not-a-number' }),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe(ValuationErrorCode.RATE_INVALID);
    expect(port.updates).toEqual([]);
  });

  it('refuses a zero rate', async () => {
    const port = new FakeContractTermsPort(CONTRACT);

    const result = await supplyContractTerms({ contracts: port }, input({ ratePercent: '0' }));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe(ValuationErrorCode.RATE_INVALID);
  });

  it('refuses a negative rate', async () => {
    const port = new FakeContractTermsPort(CONTRACT);

    const result = await supplyContractTerms({ contracts: port }, input({ ratePercent: '-5' }));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe(ValuationErrorCode.RATE_INVALID);
  });
});
