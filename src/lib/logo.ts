import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Populate `assets.logo_url` with a domain marker when available.
 * Writes `logo_url` as `domain:<hostname>` so the frontend can proxy via Logo.dev.
 * Safe to call; skips rows without a domain.
 */
export async function fetchAndCacheLogosFromDomain(client?: SupabaseClient) {
  const db = client ?? supabase;
  const { data: assets, error } = await db
    .from('assets')
    .select('id, domain');

  if (error) {
    console.error('Error fetching assets:', error);
    return;
  }

  for (const asset of assets || []) {
    if (!asset?.domain) continue;
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
        .eq('ticker', t);
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
      const { error } = await db.from('assets').update({ logo_url: logoUrl }).eq('ticker', t);
      if (error) console.error(`Update failed for ${t}:`, error);
    } catch (e) {
      console.error(`Error resolving ${t}:`, e instanceof Error ? e.message : String(e));
    }
  }
}
