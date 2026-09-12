// src/lib/newTickerLookupCap.ts
//
// Pure helper for the CSV import preview's new-ticker lookup cap. The number
// of tickers looked up against Yahoo Finance per preview is intentionally
// capped (see MAX_LOOKUPS in src/app/api/import-transactions/route.ts) — this
// function just makes explicit which candidates fall inside that cap and
// which are left over, so the leftover symbols can be surfaced to the user
// instead of silently disappearing. It does not change the cap itself and
// makes no external calls.

export function splitTickersForLookup(
  candidates: string[],
  maxLookups: number
): { toLookup: string[]; omitted: string[] } {
  const cap = Math.max(0, maxLookups);
  return {
    toLookup: candidates.slice(0, cap),
    omitted: candidates.slice(cap),
  };
}
