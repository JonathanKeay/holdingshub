import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DomainLookup } from './newAssetDomainEnrichment';

function isManualLogoUrl(value?: string | null) {
  if (!value) return false;
  return /^manual:/i.test(String(value).trim());
}

/**
 * Populate `assets.logo_url` with a domain marker when available.
 * Writes `logo_url` as `domain:<hostname>` so the frontend can proxy via Logo.dev.
 * Safe to call; skips rows without a domain.
 */
export async function fetchAndCacheLogosFromDomain(client?: SupabaseClient) {
  const db = client ?? supabase;
  const { data: assets, error } = await db
    .from('assets')
    .select('id, domain, logo_url');

  if (error) {
    console.error('Error fetching assets:', error);
    return;
  }

  for (const asset of assets || []) {
    if (!asset?.domain) continue;
    if (isManualLogoUrl((asset as { logo_url?: string | null }).logo_url)) continue;
    const logoUrl = `domain:${asset.domain}`;
    const { error: upErr } = await db
      .from('assets')
      .update({ logo_url: logoUrl })
      .eq('id', asset.id);
    if (upErr) console.error(`Failed to update logo for domain ${asset.domain}:`, upErr);
  }
}

/**
 * Populate `assets.logo_url` by looking up company profile via Finnhub.
 * Requires FINNHUB_API_KEY. Falls back silently when missing.
 */
export async function fetchAndCacheLogos(tickers: string[], client?: SupabaseClient) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    console.warn('FINNHUB_API_KEY not set; skipping Finnhub logo fetch');
    return;
  }
  const clean = tickers.filter(Boolean);
  const db = client ?? supabase;
  for (const t of clean) {
    try {
      const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(t)}&token=${token}`;
      const r = await fetch(url);
      if (!r.ok) { console.warn(`Finnhub profile HTTP ${r.status} for ${t}`); continue; }
      const j = await r.json();
      const weburl: string | undefined = (j?.weburl && typeof j.weburl === 'string') ? j.weburl : undefined;
      const domain = (() => {
        try {
          if (!weburl) return undefined;
          const u = new URL(weburl);
          const h = u.hostname.replace(/^www\./i, '');
          return h || undefined;
        } catch { return undefined; }
      })();
      // Only write domain markers; avoid Clearbit URLs or third-party direct links.
      if (!domain) continue;
      const { error } = await db
        .from('assets')
        .update({ logo_url: `domain:${domain}` })
        .eq('ticker', t)
        // Respect manual overrides
        .or('logo_url.is.null,logo_url.not.ilike.manual:%');
      if (error) console.error(`Failed to upsert logo for ${t}:`, error);
    } catch (e) {
      console.error(`Error fetching logo for ${t}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Update one asset logo_url using Finnhub domain -> domain marker (for proxy to Logo.dev). */
export async function updateLogoUrlForTickersUsingFinnhub(tickers: string[], client?: SupabaseClient) {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    console.warn('FINNHUB_API_KEY not set; skipping Finnhub domain resolution');
    return;
  }
  const db = client ?? supabase;
  for (const t of tickers) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(t)}&token=${token}`);
      if (!r.ok) { console.warn(`Finnhub HTTP ${r.status} for ${t}`); continue; }
      const j = await r.json();
      const weburl = typeof j?.weburl === 'string' ? j.weburl : undefined;
      if (!weburl) continue;
      let domain: string | undefined;
      try {
        const u = new URL(weburl);
        domain = u.hostname.replace(/^www\./i, '') || undefined;
      } catch {}
      if (!domain) continue;
      const logoUrl = `domain:${domain}`;
      const { error } = await db
        .from('assets')
        .update({ logo_url: logoUrl })
        .eq('ticker', t)
        // Respect manual overrides
        .or('logo_url.is.null,logo_url.not.ilike.manual:%');
      if (error) console.error(`Update failed for ${t}:`, error);
    } catch (e) {
      console.error(`Error resolving ${t}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Fetch a single ticker's corporate website URL from Finnhub's company-
 * profile endpoint — raw and unnormalised (callers should run the result
 * through normalizeDomain, see src/lib/domain.ts). Returns null on any
 * failure, including a missing FINNHUB_API_KEY: this is a best-effort data
 * source for new-asset domain enrichment (see
 * src/lib/newAssetDomainEnrichment.ts), never a requirement. Never throws.
 *
 * Shares the same Finnhub endpoint as fetchAndCacheLogos/
 * updateLogoUrlForTickersUsingFinnhub above, but is kept separate rather
 * than reusing those: they write directly to assets.logo_url for a batch of
 * tickers, whereas this is a single-ticker, side-effect-free lookup meant
 * to be composed with enrichNewAssetDomain's own domain+logo_url write (so
 * both columns are set together, not just logo_url).
 */
export const fetchCompanyWeburlFromFinnhub: DomainLookup = async (ticker: string) => {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${token}`);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.weburl === 'string' ? j.weburl : null;
  } catch {
    return null;
  }
};
