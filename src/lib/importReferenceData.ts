// src/lib/importReferenceData.ts
//
// Fail-closed gate for the three shared reference-data reads the CSV
// importer depends on before it can safely resolve any ticker or
// portfolio: `portfolios` (session-scoped), `assets`, and `asset_aliases`
// (see src/lib/assetResolution.ts). Extracted as a pure function so the
// fail-closed behaviour itself is directly unit-testable, independent of
// the real Supabase client and the rest of the import route.
//
// Why this exists: postgrest-js resolves (rather than rejects) on a
// transient/PostgREST-level query failure, returning `{ data: null, error }`.
// The importer used to destructure only `data` from each of these three
// queries and fall back to `data ?? []`, which makes a genuine query
// failure indistinguishable from a genuinely empty table — silently
// treating "we couldn't ask" as "the answer is no". That let a real,
// existing asset_aliases row (e.g. CAKE.US -> CAKE) be intermittently
// ignored on a transient fetch failure, reporting an already-known ticker
// as new, and in the worse case (an assets fetch failure) could report
// every existing ticker as new. See the CAKE.US intermittent-preview
// investigation.
//
// The rule this enforces: ANY of the three queries erroring aborts the
// whole request — never partially proceed with a default empty array for
// just the failed one(s).

export type ImportReferenceQueryResult<T> = {
  data: T[] | null;
  error: unknown;
};

export type ImportReferenceData<P, A, L> =
  | { ok: true; portfolios: P[]; assets: A[]; aliases: L[] }
  | { ok: false };

export function resolveImportReferenceData<P, A, L>(
  portfoliosResult: ImportReferenceQueryResult<P>,
  assetsResult: ImportReferenceQueryResult<A>,
  assetAliasesResult: ImportReferenceQueryResult<L>
): ImportReferenceData<P, A, L> {
  if (portfoliosResult.error || assetsResult.error || assetAliasesResult.error) {
    return { ok: false };
  }
  // A successful query with a genuinely empty table returns `data: []`
  // already (not null) — the `?? []` here only guards the type for the
  // (non-erroring) edge case postgrest-js can still return `null` data on,
  // e.g. a HEAD-style/edge case response; it is not the error-swallowing
  // fallback this module exists to remove.
  return {
    ok: true,
    portfolios: portfoliosResult.data ?? [],
    assets: assetsResult.data ?? [],
    aliases: assetAliasesResult.data ?? [],
  };
}
