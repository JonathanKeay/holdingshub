// Tests for CSV import ticker -> asset resolution (src/lib/assetResolution.ts),
// covering the CAKE.US regression (importer stabilisation, item 2).
//
// Regression example: an eToro export represents Cheesecake Factory as
// "CAKE.US", and HoldingsHub already has the canonical asset "CAKE". Before
// this fix, the importer had no way to know those are the same instrument
// and would offer/create a duplicate "CAKE.US" asset. This must resolve via
// an explicit alias — never via blind ".US" suffix-stripping, which would
// also incorrectly strip meaningful canonical suffixes like ".L" and ".DE".

import { describe, it, expect } from 'vitest';
import { resolveImportTicker, type ImportAsset, type ImportAssetAlias } from '../../src/lib/assetResolution';

const CAKE: ImportAsset = { id: 'asset-cake', ticker: 'CAKE', resolved_ticker: null, currency: 'USD' };
const MARA: ImportAsset = { id: 'asset-mara', ticker: 'MARA', resolved_ticker: null, currency: 'USD' };
const SAP_DE: ImportAsset = { id: 'asset-sap', ticker: 'SAP.DE', resolved_ticker: null, currency: 'EUR' };
const HVO: ImportAsset = { id: 'asset-hvo', ticker: 'HVO', resolved_ticker: 'HVO.L', currency: 'GBP' };

const assets: ImportAsset[] = [CAKE, MARA, SAP_DE, HVO];
const cakeUsAlias: ImportAssetAlias = { alias: 'CAKE.US', asset_id: CAKE.id };

describe('resolveImportTicker — exact canonical match', () => {
  it('CAKE resolves directly to the existing CAKE asset', () => {
    expect(resolveImportTicker('CAKE', assets, [])).toBe(CAKE);
  });

  it('MARA remains canonical MARA — no suffix logic ever touches an unsuffixed ticker', () => {
    expect(resolveImportTicker('MARA', assets, [])).toBe(MARA);
  });

  it('SAP.de case-normalises and resolves to the existing canonical SAP.DE, no duplicate', () => {
    expect(resolveImportTicker('sap.de', assets, [])).toBe(SAP_DE);
    expect(resolveImportTicker('SAP.DE', assets, [])).toBe(SAP_DE);
  });

  it('HVO.L resolves via the pre-existing resolved_ticker match, unchanged', () => {
    expect(resolveImportTicker('HVO.L', assets, [])).toBe(HVO);
  });

  it('a canonical .L symbol is never stripped to its bare form when no such asset exists', () => {
    const onlySuffixed: ImportAsset[] = [{ id: 'asset-vod', ticker: 'VOD.L', resolved_ticker: null, currency: 'GBP' }];
    expect(resolveImportTicker('VOD.L', onlySuffixed, [])?.id).toBe('asset-vod');
  });
});

describe('resolveImportTicker — explicit alias (step 2)', () => {
  it('CAKE.US resolves to the existing CAKE asset via an explicit alias', () => {
    expect(resolveImportTicker('CAKE.US', assets, [cakeUsAlias])).toBe(CAKE);
  });

  it('is case-insensitive on the incoming ticker', () => {
    expect(resolveImportTicker('cake.us', assets, [cakeUsAlias])).toBe(CAKE);
  });

  it('without the alias present, CAKE.US does NOT resolve (would be treated as new)', () => {
    expect(resolveImportTicker('CAKE.US', assets, [])).toBeNull();
  });

  it('the same alias resolution applies identically regardless of transaction type — a dividend row and a buy/sell row for CAKE.US resolve to the identical asset', () => {
    // resolveImportTicker has no notion of transaction type at all — this
    // proves the SAME call, used for every row regardless of type, gives
    // identical results, which is what actually guarantees DIV and BUY/SELL
    // rows can never diverge.
    const dividendRowResolution = resolveImportTicker('CAKE.US', assets, [cakeUsAlias]);
    const buyRowResolution = resolveImportTicker('CAKE.US', assets, [cakeUsAlias]);
    const sellRowResolution = resolveImportTicker('CAKE.US', assets, [cakeUsAlias]);
    expect(dividendRowResolution).toBe(CAKE);
    expect(buyRowResolution).toBe(CAKE);
    expect(sellRowResolution).toBe(CAKE);
  });

  it('multiple different aliases may safely map to the same asset', () => {
    const aliases: ImportAssetAlias[] = [
      { alias: 'CAKE.US', asset_id: CAKE.id },
      { alias: 'CAKE-US', asset_id: CAKE.id },
    ];
    expect(resolveImportTicker('CAKE.US', assets, aliases)).toBe(CAKE);
    expect(resolveImportTicker('CAKE-US', assets, aliases)).toBe(CAKE);
  });

  it('an alias whose target asset no longer exists resolves to null rather than throwing', () => {
    const danglingAlias: ImportAssetAlias = { alias: 'GHOST.US', asset_id: 'no-such-asset' };
    expect(resolveImportTicker('GHOST.US', assets, [danglingAlias])).toBeNull();
  });
});

describe('resolveImportTicker — no blind suffix stripping (unknown symbols stay unresolved)', () => {
  it('an unknown XYZ.US with no alias remains unresolved — it must NOT silently become XYZ, even if XYZ existed', () => {
    const withXYZ: ImportAsset[] = [...assets, { id: 'asset-xyz', ticker: 'XYZ', resolved_ticker: null, currency: 'USD' }];
    expect(resolveImportTicker('XYZ.US', withXYZ, [])).toBeNull();
  });

  it('a genuinely new ticker with no canonical match and no alias resolves to null', () => {
    expect(resolveImportTicker('SHOP', assets, [])).toBeNull();
  });

  it('.DE is never blindly stripped either', () => {
    const withoutSap: ImportAsset[] = [CAKE, MARA];
    expect(resolveImportTicker('SAP.DE', withoutSap, [])).toBeNull();
  });
});

describe('resolveImportTicker — edge cases', () => {
  it('returns null for an empty/null ticker without throwing', () => {
    expect(resolveImportTicker('', assets, [])).toBeNull();
    expect(resolveImportTicker(null, assets, [])).toBeNull();
    expect(resolveImportTicker(undefined, assets, [])).toBeNull();
  });

  it('exact ticker match takes precedence over an alias that happens to collide (defensive; app layer also rejects creating such an alias)', () => {
    const selfAlias: ImportAssetAlias = { alias: 'CAKE', asset_id: MARA.id };
    expect(resolveImportTicker('CAKE', assets, [selfAlias])).toBe(CAKE);
  });
});
