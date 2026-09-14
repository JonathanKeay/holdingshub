// src/lib/newAssetDomainEnrichment.ts
//
// Best-effort corporate-domain enrichment for a newly created asset. Wired
// in from the confirm stage of /api/import-transactions immediately after a
// brand-new asset row is inserted (see that route for the call site) — this
// is what removes the previously-manual "go into Supabase and set the
// domain" step for a genuinely new ticker (see the 2026-09-14
// Logo.dev/company-domain audit; SHOP was the observed regression case: a
// newly-created asset with no domain and therefore no logo).
//
// `lookup` is injected rather than hard-coded so this can be unit-tested
// without a real network call — see tests/import/new-asset-domain-
// enrichment.spec.ts for the fetchAuto-style spy, mirroring the existing
// src/lib/confirmTickerMetaResolution.ts pattern. The real implementation
// used in production is fetchCompanyWeburlFromFinnhub (src/lib/logo.ts),
// reusing the Finnhub company-profile lookup already written (but never
// wired up) there — no new external service is introduced.
//
// Never throws, and never blocks/fails the calling import: any failure
// (missing FINNHUB_API_KEY, network error, timeout, no company profile, an
// unparseable weburl) resolves to a "skipped" result. The caller
// (import-transactions/route.ts) additionally wraps this in its own
// timeout so a slow/hanging provider can never introduce a long delay into
// Confirm & Import.
//
// Two fields end up written together, in sync, as a deliberate fix for the
// silent-disagreement problem the audit found (e.g. CAKE's domain and
// logo_url pointing at two different hostnames):
//   assets.domain    = '<host>'          (e.g. 'shopify.com')
//   assets.logo_url  = 'domain:<host>'   (what src/app/page.tsx and
//                                          /api/logo-proxy actually render)
//
// The update only ever applies while BOTH columns are still NULL (`.is`
// filters below) — this is what guarantees automatic enrichment can never
// overwrite an existing explicit/manual override (a 'manual:'-prefixed
// logo_url, or any value set through another path), including in a race
// against a concurrent Asset Edit save. A brand-new asset always has both
// columns NULL at insert time, so in normal operation this guard is always
// satisfied; it exists so the function stays safe by construction if ever
// reused against a pre-existing asset (e.g. from a future admin tool) —
// this feature does not add any such bulk/backfill caller itself.

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain, domainLogoUrl } from './domain';

export type DomainLookup = (ticker: string) => Promise<string | null>;

export type NewAssetDomainEnrichmentResult =
  | { status: 'enriched'; domain: string }
  | { status: 'skipped'; reason: 'no-domain-found' | 'already-set' | string };

/** Resolve a normalised domain for a ticker via the injected lookup, or null on any failure. Never throws. */
export async function resolveNewAssetDomain(ticker: string, lookup: DomainLookup): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await lookup(ticker);
  } catch {
    return null;
  }
  return normalizeDomain(raw);
}

/**
 * Discover and persist a corporate domain for one just-created asset.
 * Safe to call for every new asset unconditionally — resolves to a
 * "skipped" result (never throws, never rejects) when nothing usable was
 * found or the columns were no longer both NULL by the time the write ran.
 */
export async function enrichNewAssetDomain(
  client: SupabaseClient,
  assetId: string,
  ticker: string,
  lookup: DomainLookup
): Promise<NewAssetDomainEnrichmentResult> {
  const domain = await resolveNewAssetDomain(ticker, lookup);
  if (!domain) return { status: 'skipped', reason: 'no-domain-found' };

  const { data, error } = await client
    .from('assets')
    .update({ domain, logo_url: domainLogoUrl(domain) })
    .eq('id', assetId)
    .is('domain', null)
    .is('logo_url', null)
    .select('id')
    .maybeSingle();

  if (error) return { status: 'skipped', reason: `db-error: ${error.message}` };
  if (!data) return { status: 'skipped', reason: 'already-set' };
  return { status: 'enriched', domain };
}
