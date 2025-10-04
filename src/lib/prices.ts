// debug log removed (prices.ts init)

import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAndCacheLogosFromDomain } from './logo';
import { isMarketOpenForTicker } from './marketHours';

const BATCH_SIZE = 10;
const ACTIVE_TTL_MS = 5 * 60 * 1000;      // 5 min when market open
const CLOSED_TTL_MS = 60 * 60 * 1000;     // 60 min when market closed

type PriceRow = {
  price: number;
  previous_close: number;
  updated_at: string;
  price_multiplier: number;
};

// ---- Helpers ----
async function resolveTickersWithMultiplier(tickers: string[]) {
  const map: Record<string, { resolved: string; multiplier: number }> = {};
  const { data, error } = await supabase
    .from('assets')
    .select('ticker,resolved_ticker,price_multiplier')
    .in('ticker', tickers);

  if (error) {
    console.error('Asset fetch error:', error);
    for (const t of tickers) map[t] = { resolved: t, multiplier: 1 };
    return map;
  }
  for (const a of data ?? []) {
    map[a.ticker] = {
      resolved: a.resolved_ticker || a.ticker,
      multiplier: a.price_multiplier ?? 1
    };
  }
  for (const t of tickers) {
    if (!map[t]) map[t] = { resolved: t, multiplier: 1 };
  }
  return map;
}

async function fetchYahooPrice(ticker: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const res = await fetch(url);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) throw new Error(String(res.status));
    const json = await res.json();
    const p = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === 'number' ? p : null;
  } catch (e) {
    return null;
  }
}

async function fetchPreviousClose(ticker: string): Promise<number> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    const res = await fetch(url);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) throw new Error(String(res.status));
    const json = await res.json();
    const r0 = json?.chart?.result?.[0];
    const closes = r0?.indicators?.quote?.[0]?.close;

    if (Array.isArray(closes) && closes.length >= 2 && typeof closes[0] === 'number') {
      return closes[0];
    }
    const metaPrev = r0?.meta?.chartPreviousClose;
    if (typeof metaPrev === 'number' && metaPrev > 0) return metaPrev;
    return 0;
  } catch {
    return 0;
  }
}

// ---- Main ----
export async function fetchAndCachePrices(
  allTickers: string[],
  tickerQuantities?: Record<string, number>,
  clientParam?: SupabaseClient
): Promise<Record<string, PriceRow>> {
  const client = clientParam || supabase;
  const now = new Date();

  // Eligibility (include unknown after 24h cooldown)
  const { data: assets, error: assetsErr } = await client
    .from('assets')
    .select('ticker,status,resolution_attempted_at')
    .in('ticker', allTickers);

  if (assetsErr) console.error('Asset eligibility error:', assetsErr);

  type ARow = { ticker: string; status: string | null; resolution_attempted_at: string | null };
  const eligible: string[] = [];
  const assetSet = new Set((assets ?? []).map(a => a.ticker));

  for (const a of (assets as ARow[] ?? [])) {
    const s = a.status?.toLowerCase() || null;
    if (s === null || s === 'active') {
      eligible.push(a.ticker);
    } else if (s === 'unknown') {
      const last = a.resolution_attempted_at ? new Date(a.resolution_attempted_at) : null;
      const hours = last ? (now.getTime() - last.getTime()) / 36e5 : Infinity;
      if (hours > 24) eligible.push(a.ticker);
    }
    // delisted & others excluded
  }
  // Missing asset rows => assume active
  for (const t of allTickers) if (!assetSet.has(t)) eligible.push(t);

  const tickers = eligible.filter(t => (tickerQuantities?.[t] ?? 1) > 0);

  // Existing cached prices
  const { data: cached } = await client
    .from('prices')
    .select('ticker,price,previous_close,updated_at,price_multiplier')
    .in('ticker', tickers);

  const cachedMap: Record<string, any> = {};
  for (const r of cached ?? []) cachedMap[r.ticker] = r;

  const fresh: Record<string, PriceRow> = {};
  const needs: string[] = [];
  const nowMs = Date.now();

  for (const t of tickers) {
    const row = cachedMap[t];
    if (!row) {
      needs.push(t);
      continue;
    }
    const open = isMarketOpenForTicker(t);
    const ttl = open ? ACTIVE_TTL_MS : CLOSED_TTL_MS;
    const age = nowMs - new Date(row.updated_at).getTime();
    const isFresh = age < ttl;
    const prevInvalid = (row.previous_close ?? 0) <= 0;

    if (!isFresh || prevInvalid) needs.push(t);
    else {
      fresh[t] = {
        price: Number(row.price),
        previous_close: Number(row.previous_close),
        updated_at: row.updated_at,
        price_multiplier: Number(row.price_multiplier ?? 1)
      };
    }
  }

  if (needs.length === 0) return fresh;

  await fetchAndCacheLogosFromDomain();

  const newEntries: Record<string, PriceRow> = {};
  for (let i = 0; i < needs.length; i += BATCH_SIZE) {
    const batch = needs.slice(i, i + BATCH_SIZE);
    const resolvedMap = await resolveTickersWithMultiplier(batch);

    const priceResults = await Promise.allSettled(batch.map(t => fetchYahooPrice(resolvedMap[t].resolved)));
    const prevResults = await Promise.allSettled(batch.map(t => fetchPreviousClose(resolvedMap[t].resolved)));

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const { resolved, multiplier } = resolvedMap[ticker];
      const updated_at = new Date().toISOString();

      let price = 0;
      const pr = priceResults[j];
      if (pr.status === 'fulfilled' && typeof pr.value === 'number' && pr.value != null) price = pr.value;

      if (price === 0) {
        // Downgrade asset status to unknown (retry later)
        const { data: ids } = await supabase
          .from('assets')
            .select('id')
            .or(`ticker.eq.${ticker},resolved_ticker.eq.${resolved}`);
        if (ids?.length) {
          await supabase
            .from('assets')
            .update({
              status: 'unknown',
              resolution_attempted_at: updated_at,
              last_failed_resolved_ticker: resolved
            })
            .in('id', ids.map((a: any) => a.id));
        }
      }

      let previous_close = 0;
      const pv = prevResults[j];
      if (pv.status === 'fulfilled' && typeof pv.value === 'number') previous_close = pv.value;

      const entry: PriceRow = {
        price,
        previous_close,
        updated_at,
        price_multiplier: multiplier
      };
      newEntries[ticker] = entry;

      // Upserts (assumes columns exist)
      const { error: priceErr } = await client.from('prices').upsert({
        ticker,
        price,
        previous_close,
        price_multiplier: multiplier,
        source: 'yahoo',
        updated_at
      });
      if (priceErr) {
        console.error('prices upsert failed', ticker, priceErr);
      }

      const { error: histErr } = await client.from('price_history').upsert({
        ticker,
        date: updated_at.slice(0, 10),
        price,
        previous_close,
        price_multiplier: multiplier,
        source: 'yahoo'
      });
      if (histErr) {
        console.error('price_history upsert failed', ticker, histErr);
      }
    }

    // polite pause between batches
    if (i + BATCH_SIZE < needs.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { ...fresh, ...newEntries };
}

export { resolveTickersWithMultiplier };
