import { describe, expect, it } from 'vitest';
import { AssetId } from '@/core/shared/ids';
import { computePollingSet, derivePollingSet, isIntradayEligible } from './polling-set';
import { FakeAssetCatalog, FakeHeldAssetsPort } from './test-support';
import type { Asset } from './ports';

function asset(overrides: Partial<Asset> & Pick<Asset, 'code' | 'assetClass'>): Asset {
  return {
    id: AssetId.generate(),
    name: overrides.code,
    ...overrides,
  };
}

describe('isIntradayEligible (BR-008-11)', () => {
  it('stock/fii/bdr/etf are intraday-eligible; fixed income and Tesouro are not', () => {
    expect(isIntradayEligible('stock')).toBe(true);
    expect(isIntradayEligible('fii')).toBe(true);
    expect(isIntradayEligible('bdr')).toBe(true);
    expect(isIntradayEligible('etf')).toBe(true);
    expect(isIntradayEligible('tesouro_direto')).toBe(false);
  });
});

describe('derivePollingSet (BR-008-08)', () => {
  it('polls only assets in a non-zero position — an unheld catalog asset is absent', () => {
    const petr4 = asset({ code: 'PETR4', assetClass: 'stock' });
    const held = derivePollingSet([petr4]);
    expect(held).toEqual([petr4.id]);
  });

  it('excludes Tesouro Direto — priced daily, not polled intraday (BR-008-11/12)', () => {
    const stock = asset({ code: 'PETR4', assetClass: 'stock' });
    const tesouro = asset({ code: 'Tesouro_Selic_2029', assetClass: 'tesouro_direto' });
    expect(derivePollingSet([stock, tesouro])).toEqual([stock.id]);
  });

  it('de-duplicates — the same asset held across multiple positions appears once', () => {
    const petr4 = asset({ code: 'PETR4', assetClass: 'stock' });
    expect(derivePollingSet([petr4, petr4])).toEqual([petr4.id]);
  });

  it('an empty holding universe yields an empty polling set', () => {
    expect(derivePollingSet([])).toEqual([]);
  });
});

describe('computePollingSet use case (BR-008-08)', () => {
  it('buying a new asset adds it to the set on the next computation — no manual step', async () => {
    const catalog = new FakeAssetCatalog();
    const held = new FakeHeldAssetsPort([]);
    const petr4 = asset({ code: 'PETR4', assetClass: 'stock' });
    catalog.add(petr4);

    expect(await computePollingSet({ heldAssets: held, catalog })).toEqual([]);

    // The user buys PETR4 — a later transaction makes it a non-zero position.
    held.set([petr4.id]);
    expect(await computePollingSet({ heldAssets: held, catalog })).toEqual([petr4.id]);
  });

  it('selling a position to zero removes the asset from the set', async () => {
    const catalog = new FakeAssetCatalog();
    const held = new FakeHeldAssetsPort();
    const petr4 = asset({ code: 'PETR4', assetClass: 'stock' });
    catalog.add(petr4);
    held.set([petr4.id]);
    expect(await computePollingSet({ heldAssets: held, catalog })).toEqual([petr4.id]);

    held.set([]); // sold to zero
    expect(await computePollingSet({ heldAssets: held, catalog })).toEqual([]);
  });

  it('an asset in the catalog but held by nobody is never polled', async () => {
    const catalog = new FakeAssetCatalog();
    const held = new FakeHeldAssetsPort([]);
    catalog.add(asset({ code: 'VALE3', assetClass: 'stock' }));
    expect(await computePollingSet({ heldAssets: held, catalog })).toEqual([]);
  });
});
