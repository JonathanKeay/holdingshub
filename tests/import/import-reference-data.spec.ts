// Tests for src/lib/importReferenceData.ts — the fail-closed gate around
// the CSV importer's three reference-data reads (portfolios, assets,
// asset_aliases). See the CAKE.US intermittent-preview investigation: a
// transient/PostgREST-level failure on any of these three queries used to
// be silently downgraded to an empty array via `data ?? []`, which is
// indistinguishable from a genuinely empty table. That let a real,
// existing asset_aliases row be intermittently ignored (an already-known
// ticker reported as new), and could — for an assets fetch failure —
// report every existing ticker as new.
//
// These tests prove the fix at the pure-function level: ANY of the three
// queries erroring aborts (`ok: false`), and only a genuine all-succeeded
// result proceeds. The CAKE.US alias-resolution combination is verified
// end-to-end by feeding a successful result into resolveImportTicker
// (src/lib/assetResolution.ts), the same way the real import route does.

import { describe, it, expect } from 'vitest';
import { resolveImportReferenceData, type ImportReferenceQueryResult } from '../../src/lib/importReferenceData';
import { resolveImportTicker, type ImportAsset, type ImportAssetAlias } from '../../src/lib/assetResolution';

const CAKE: ImportAsset = { id: 'asset-cake', ticker: 'CAKE', resolved_ticker: null, currency: 'USD' };
const cakeUsAlias: ImportAssetAlias = { alias: 'CAKE.US', asset_id: CAKE.id };

const okPortfolios: ImportReferenceQueryResult<{ id: string; name: string }> = {
  data: [{ id: 'p1', name: 'ISA' }],
  error: null,
};
const okAssets: ImportReferenceQueryResult<ImportAsset> = { data: [CAKE], error: null };
const okAliases: ImportReferenceQueryResult<ImportAssetAlias> = { data: [cakeUsAlias], error: null };

const simulatedError = { message: 'simulated transient failure (e.g. connection reset)' };

describe('resolveImportReferenceData — all three queries succeed', () => {
  it('returns ok:true with the exact data from each query', () => {
    const result = resolveImportReferenceData(okPortfolios, okAssets, okAliases);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.portfolios).toEqual(okPortfolios.data);
    expect(result.assets).toEqual(okAssets.data);
    expect(result.aliases).toEqual(okAliases.data);
  });

  it('a genuinely empty table on all three still returns ok:true with empty arrays — existing intended logic is unchanged', () => {
    const result = resolveImportReferenceData(
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null }
    );
    expect(result).toEqual({ ok: true, portfolios: [], assets: [], aliases: [] });
  });

  it('CAKE.US resolves to CAKE end-to-end when reference data loads successfully — normal resolution is unchanged', () => {
    const result = resolveImportReferenceData(okPortfolios, okAssets, okAliases);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const matched = resolveImportTicker('CAKE.US', result.assets, result.aliases);
    expect(matched).toBe(CAKE);
  });
});

describe('resolveImportReferenceData — fail closed on any single query error', () => {
  it('an asset_aliases error aborts (ok:false) — an aliased ticker must never fall through and be treated as new', () => {
    const result = resolveImportReferenceData(okPortfolios, okAssets, { data: null, error: simulatedError });
    expect(result).toEqual({ ok: false });
    // Would have been the danger: if the caller pressed on with an empty
    // alias list instead of aborting, CAKE.US (a real alias) would appear
    // to be a genuinely new ticker.
    const wronglyContinued = resolveImportTicker('CAKE.US', okAssets.data!, []);
    expect(wronglyContinued).toBeNull();
  });

  it('an assets error aborts (ok:false) — an existing asset must never fall through and be treated as new', () => {
    const result = resolveImportReferenceData(okPortfolios, { data: null, error: simulatedError }, okAliases);
    expect(result).toEqual({ ok: false });
    // Would have been the danger: with an empty assets list, even CAKE's
    // own direct ticker match (no alias needed) would falsely look new.
    const wronglyContinued = resolveImportTicker('CAKE', [], okAliases.data!);
    expect(wronglyContinued).toBeNull();
  });

  it('a portfolios error aborts (ok:false) — the importer must never continue with an apparently empty portfolio set', () => {
    const result = resolveImportReferenceData({ data: null, error: simulatedError }, okAssets, okAliases);
    expect(result).toEqual({ ok: false });
  });

  it('all three erroring together still aborts exactly once (ok:false), not a partial result', () => {
    const result = resolveImportReferenceData(
      { data: null, error: simulatedError },
      { data: null, error: simulatedError },
      { data: null, error: simulatedError }
    );
    expect(result).toEqual({ ok: false });
  });

  it('a null-but-error-free data field (defensive edge case) still resolves to an empty array, not an abort', () => {
    // postgrest-js should never return {data: null, error: null}, but if it
    // ever did, that is a genuinely empty result, not a failure — this must
    // NOT be conflated with the error path.
    const result = resolveImportReferenceData(
      { data: null, error: null },
      okAssets,
      okAliases
    );
    expect(result).toEqual({ ok: true, portfolios: [], assets: okAssets.data, aliases: okAliases.data });
  });
});
