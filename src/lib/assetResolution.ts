// src/lib/assetResolution.ts
//
// Pure ticker -> asset resolution for CSV import (importer stabilisation,
// item 2 — canonical asset alias resolution). Resolution order:
//
//   1. Exact match against assets.ticker or assets.resolved_ticker,
//      including the pre-existing .L-suffix-toggle tolerance. UNCHANGED
//      from the importer's prior behaviour — this is the same logic that
//      used to live inline in src/app/api/import-transactions/route.ts's
//      findAssetByTicker, extracted here verbatim so it's directly
//      testable, and so alias resolution can slot in as an explicit next
//      step without disturbing it.
//   2. An explicit `asset_aliases` row (e.g. "CAKE.US" -> the existing
//      "CAKE" asset). Exact match only.
//   3. Otherwise: no match — the caller treats the ticker as potentially
//      new and enters the existing new-ticker/metadata-confirmation flow
//      (see src/lib/manualAssetMetadata.ts).
//
// This deliberately never strips, guesses, or heuristically maps a suffix
// (no generic ".US" stripping, no inventing an alias). Only a real,
// explicitly-created alias resolves — see the CAKE.US investigation for why
// suffix-stripping is unsafe (".L" and ".DE" are meaningful, canonical
// HoldingsHub suffixes, not broker noise).
//
// resolved_ticker is NOT the alias layer (see the migration
// 20260914160000_create_asset_aliases.sql header for why) — its existing,
// narrower role (a price-provider symbol override) is preserved exactly as
// step 1 above, unchanged.

export type ImportAsset = {
  id: string;
  ticker: string | null;
  resolved_ticker?: string | null;
  currency?: string | null;
};

export type ImportAssetAlias = {
  alias: string;
  asset_id: string;
};

function upper(v: string | null | undefined): string {
  return (v ?? '').toString().toUpperCase();
}

export function resolveImportTicker<T extends ImportAsset>(
  rawTicker: string | null | undefined,
  assets: readonly T[],
  aliases: readonly ImportAssetAlias[] = []
): T | null {
  if (!rawTicker) return null;
  const t = rawTicker.toString().toUpperCase();

  const byExact = (a: T, key: 'ticker' | 'resolved_ticker') => upper(a[key]) === t;

  // Step 1: exact ticker/resolved_ticker match, unchanged.
  let match = assets.find((a) => byExact(a, 'ticker') || byExact(a, 'resolved_ticker'));

  // Step 1b: the pre-existing .L-suffix-toggle tolerance, unchanged.
  if (!match) {
    if (t.endsWith('.L')) {
      const noL = t.replace(/\.L$/, '');
      match = assets.find((a) => upper(a.ticker) === noL || upper(a.resolved_ticker) === noL);
    } else {
      const withL = `${t}.L`;
      match = assets.find((a) => upper(a.ticker) === withL || upper(a.resolved_ticker) === withL);
    }
  }
  if (match) return match;

  // Step 2: explicit alias. Exact match only — never guesses or strips a
  // suffix, and never falls back to a fuzzy/partial match.
  const aliasMatch = aliases.find((al) => upper(al.alias) === t);
  if (aliasMatch) {
    return assets.find((a) => a.id === aliasMatch.asset_id) ?? null;
  }

  return null;
}
