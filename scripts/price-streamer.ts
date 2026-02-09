// Near-realtime price streamer
// - US: Finnhub WebSocket (requires FINNHUB_API_KEY)
// - UK (.L): Yahoo polling (30s when open, hourly when closed)
// - Writes to prices and price_history like fetchAndCachePrices()

import 'dotenv/config';
import os from 'os';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Tuning knobs
const MIN_ABS_CHANGE = Number(process.env.PRICES_MIN_ABS_CHANGE ?? '0.01'); // $0.01
const MIN_PCT_CHANGE = Number(process.env.PRICES_MIN_PCT_CHANGE ?? '0.0005'); // 0.05%
const US_FLUSH_INTERVAL_MS = Number(process.env.US_FLUSH_INTERVAL_MS ?? '15000'); // 15s
const YAHOO_POLL_INTERVAL_MS = Number(process.env.YAHOO_POLL_INTERVAL_MS ?? '300000'); // 5m
const JITTER_FACTOR = Number(process.env.PRICES_JITTER_FACTOR ?? '0.05'); // ±5%
const TRADE_MAX_AGE_MS = Number(process.env.TRADE_MAX_AGE_MS ?? '300000'); // 5m: ignore stale WS trades older than this

// When markets are closed, US symbols may not emit WS trades.
// Seed stale prices on startup using REST quotes so the UI isn't stuck on week-old values.
const PRICES_SEED_ON_STARTUP = (process.env.PRICES_SEED_ON_STARTUP ?? '1') !== '0';
const PRICES_STARTUP_SEED_MAX_AGE_MS = Number(process.env.PRICES_STARTUP_SEED_MAX_AGE_MS ?? String(12 * 60 * 60 * 1000)); // 12h
const PRICES_SEED_ON_WATCHLIST_CHANGE = (process.env.PRICES_SEED_ON_WATCHLIST_CHANGE ?? '1') !== '0';
const PRICES_WATCHLIST_SEED_DEBOUNCE_MS = Number(process.env.PRICES_WATCHLIST_SEED_DEBOUNCE_MS ?? '5000');

function jitter(ms: number, factor = JITTER_FACTOR) {
  const d = (Math.random() * 2 - 1) * factor;
  return Math.max(0, Math.round(ms * (1 + d)));
}

function normalizeEpochMillis(u: number): number {
  // Convert various epoch formats to milliseconds
  if (!Number.isFinite(u) || u <= 0) return 0;
  // Nanoseconds
  if (u > 1e15) return Math.floor(u / 1e6);
  // Microseconds
  if (u > 1e13) return Math.floor(u / 1e3);
  // Milliseconds
  if (u > 1e11) return Math.floor(u);
  // Seconds
  return Math.floor(u * 1000);
}

type PriceRow = {
  ticker: string;
  price: number;
  previous_close: number;
  price_multiplier: number;
  updated_at: string;
};

type PricesUpsert = {
  ticker: string;
  price: number;
  previous_close: number;
  price_multiplier: number;
  source?: string;
  updated_at: string;
};

type PriceHistoryUpsert = {
  ticker: string;
  date: string;
  price: number;
  previous_close?: number;
  price_multiplier: number;
  source?: string;
};

function isCashTicker(t?: string | null) { return !!t && t.startsWith('CASH.'); }
const ALWAYS_CASH_TYPES = new Set(['DIV', 'INT']);

type Txn = {
  id: string;
  asset_id: string;
  type: string;
  date?: string | null;
  created_at?: string | null;
  quantity?: number | null;
  price?: number | null;
  fee?: number | null;
  cash_value?: number | null;
  cash_ccy?: string | null;
  settle_value?: number | null;
  settle_ccy?: string | null;
  split_factor?: number | null;
};

type AssetMeta = { id: string; ticker: string; currency?: string | null; status?: string | null; price_multiplier?: number | null };

type Holding = { ticker: string; asset_id: string; currency?: string | null; total_shares: number; total_cost: number; avg_price: number };

function round(n: number, dp = 6) { const p = Math.pow(10, dp); return Math.round(n * p) / p; }
const TYPE_PRIORITY: Record<string, number> = { SPL:10, TIN:20, BUY:30, SELL:40, TOT:50, DIV:90, INT:95, FEE:96, DEP:97, WIT:98, OTR:99, BAL:100 };
function compareTxForHoldings(a: Txn, b: Txn) {
  const da = a.date ?? ''; const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ca = a.created_at ?? ''; const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const pa = TYPE_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = TYPE_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : 1;
}

// Minimal port of applyTransactionToHolding from src/lib/queries.ts (asset-ccy only)
function applyTxn(holding: Holding, txn: Txn) {
  const type = (txn.type ?? '').toUpperCase();
  if (type === 'SPL') {
    const factor = Number(txn.split_factor || 0);
    if (!factor || factor <= 0) return;
    holding.total_shares = round(holding.total_shares * factor);
    holding.avg_price = holding.total_shares > 0 ? holding.total_cost / holding.total_shares : 0;
    return;
  }
  const qty = Math.abs(Number(txn.quantity) || 0);
  const price = Number(txn.price) || 0;
  const fee = Number(txn.fee) || 0;
  const assetCcy = (holding.currency || '').toUpperCase();
  let txnAssetTotal = 0;
  if ((type === 'BUY' || type === 'TIN') && txn.settle_value != null && (txn.settle_ccy || '').toUpperCase() === assetCcy) {
    txnAssetTotal = Math.abs(Number(txn.settle_value) || 0);
  } else if (type === 'BUY') {
    txnAssetTotal = Math.abs(qty * price + fee);
  } else if (type === 'TIN') {
    // If no settle_value, fall back to price*qty (+fee) in asset ccy
    txnAssetTotal = qty > 0 && price !== 0 ? Math.abs(qty * price + fee) : 0;
  }
  if (type === 'TIN') { holding.total_shares += qty; holding.total_cost += txnAssetTotal; }
  else if (type === 'TOT') { const prop = holding.total_shares > 0 ? qty / holding.total_shares : 0; const costOut = prop > 0 ? holding.total_cost * prop : 0; holding.total_shares -= qty; holding.total_cost -= costOut; }
  else if (type === 'BUY') { holding.total_shares += qty; holding.total_cost += txnAssetTotal; }
  else if (type === 'SELL') { const prop = holding.total_shares > 0 ? qty / holding.total_shares : 0; const costOut = prop > 0 ? holding.total_cost * prop : 0; holding.total_shares -= qty; holding.total_cost -= costOut; }
  if (holding.total_shares <= 1e-6) holding.total_shares = 0;
  if (holding.total_shares === 0) { holding.total_cost = 0; holding.avg_price = 0; }
  else { holding.total_cost = round(holding.total_cost); holding.total_shares = round(holding.total_shares); holding.avg_price = holding.total_cost / holding.total_shares; }
}

async function loadActivePositionTickers(client: SupabaseClient): Promise<{ us: string[]; nonUS: string[]; multiplier: Record<string, number> }> {
  const { data: assets } = await client.from('assets').select('id,ticker,currency,status,price_multiplier');
  const validAssets: AssetMeta[] = (assets || []).filter(a => {
      const s = String(a.status ?? 'active').toLowerCase();
      return s !== 'delisted' && s !== 'failed';
    }) as AssetMeta[];
  const assetById = new Map<string, AssetMeta>();
  for (const a of validAssets) assetById.set(a.id, a);

  // Fetch all transactions (service role bypasses RLS)
  const rows: Txn[] = [];
  let from = 0; const page = 1000;
  while (true) {
    const { data, error } = await client.from('transactions').select('*').range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Txn[]));
    if (data.length < page) break;
    from += page;
  }

  // Build holdings across all portfolios (exclude DIV/INT and CASH.*)
  const txns = rows.filter(tx => {
    const a = assetById.get(tx.asset_id); if (!a) return false;
    const ttype = (tx.type || '').toUpperCase(); if (ALWAYS_CASH_TYPES.has(ttype)) return false;
    if (isCashTicker(a.ticker)) return false;
    return true;
  }).sort(compareTxForHoldings);

  const holdings = new Map<string, Holding>();
  for (const tx of txns) {
    const a = assetById.get(tx.asset_id); if (!a) continue;
    const key = a.ticker;
    const h = holdings.get(key) || { ticker: key, asset_id: a.id, currency: a.currency || undefined, total_shares: 0, total_cost: 0, avg_price: 0 };
    applyTxn(h, tx);
    holdings.set(key, h);
  }

  const multiplier: Record<string, number> = {};
  for (const a of validAssets) multiplier[a.ticker] = Number(a.price_multiplier || 1) || 1;

  const activeTickers = Array.from(holdings.values()).filter(h => (h.total_shares || 0) > 0);
  const us: string[] = []; const nonUS: string[] = [];
  for (const h of activeTickers) {
    // Heuristic: US tickers typically have no suffix; others use .L, .DE, etc.
    if (/^[A-Z0-9]+$/.test(h.ticker)) us.push(h.ticker);
    else nonUS.push(h.ticker);
  }
  return { us, nonUS, multiplier };
}

// (kept for potential future use)
// Removed market open helpers; polling/flush intervals are fixed per simplified model.

async function fetchFinnhubQuote(symbol: string, token?: string): Promise<{ c: number; pc: number } | null> {
  if (!token) return null;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const c = Number(j?.c || 0);
    const pc = Number(j?.pc || 0);
    if (!Number.isFinite(c)) return null;
    return { c, pc };
  } catch {
    return null;
  }
}

async function fetchYahooPrice(ticker: string): Promise<{ price: number; previous_close: number } | null> {
  try {
    // Prefer intraday last if available
    const urlIntra = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1d`;
    const r1 = await fetch(urlIntra);
    const ct1 = r1.headers.get('content-type') || '';
    let lastIntra: number | null = null;
    if (r1.ok && ct1.includes('application/json')) {
      const j1 = await r1.json();
      const rr = j1?.chart?.result?.[0];
      const close = rr?.indicators?.quote?.[0]?.close as (number | null)[] | undefined;
      if (Array.isArray(close)) {
        for (let i = close.length - 1; i >= 0; i--) {
          const v = close[i]; if (typeof v === 'number' && v > 0) { lastIntra = v; break; }
        }
      }
    }
    const urlDaily = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    const r2 = await fetch(urlDaily);
    const ct2 = r2.headers.get('content-type') || '';
    if (!r2.ok || !ct2.includes('application/json')) throw new Error(String(r2.status));
    const j2 = await r2.json();
    const r0 = j2?.chart?.result?.[0];
    const price = typeof r0?.meta?.regularMarketPrice === 'number' ? r0.meta.regularMarketPrice : 0;
    const closes = r0?.indicators?.quote?.[0]?.close as (number | null)[] | undefined;
    let previous_close = 0;
    if (Array.isArray(closes) && closes.length >= 2 && typeof closes[0] === 'number') previous_close = closes[0]!;
    else if (typeof r0?.meta?.chartPreviousClose === 'number') previous_close = r0.meta.chartPreviousClose;
    const finalPrice = (lastIntra && lastIntra > 0) ? lastIntra : price;
    return { price: Number(finalPrice || 0), previous_close: Number(previous_close || 0) };
  } catch {
    return null;
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !serviceRole) {
    console.error('Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, serviceRole);

  // Global singleton guard using Postgres advisory lock via RPC
  let haveLock = false;
  try {
    const { data: locked, error } = await supabase.rpc('try_lock_price_streamer');
    if (!error && locked === true) {
      haveLock = true;
    } else {
      console.error('[singleton] Another price streamer appears to be active (try_lock_price_streamer=false). Exiting.');
      process.exit(0);
    }
  } catch {
    console.warn('[singleton] try_lock_price_streamer RPC missing or failed. Proceeding without global lock.');
  }

  const hostname = os.hostname();

  // Compute initial active tickers with positions > 0
  const first = await loadActivePositionTickers(supabase);
  let tickersUS: string[] = first.us;
  let tickersNonUS: string[] = first.nonUS;
  const multiplier: Record<string, number> = first.multiplier;

  // Periodically refresh the watchlists (e.g., every 2 minutes) to follow position changes
  let watchlistSeedTimer: NodeJS.Timeout | null = null;
  const seenUSTickers = new Set<string>(tickersUS);
  setInterval(async () => {
    try {
      const next = await loadActivePositionTickers(supabase);
      const nextUS = next.us;
      // Detect newly-added US tickers
      const addedUS = nextUS.filter(t => !seenUSTickers.has(t));
      tickersUS = nextUS;
      tickersNonUS = next.nonUS;
      for (const [k,v] of Object.entries(next.multiplier)) multiplier[k] = v;

      for (const t of nextUS) seenUSTickers.add(t);

      // If new US tickers appear (e.g., after imports), seed them soon so UI isn't stale.
      if (PRICES_SEED_ON_WATCHLIST_CHANGE && addedUS.length > 0) {
        if (watchlistSeedTimer) clearTimeout(watchlistSeedTimer);
        watchlistSeedTimer = setTimeout(() => {
          seedUSPricesOnce(supabase, addedUS).catch(() => {});
        }, PRICES_WATCHLIST_SEED_DEBOUNCE_MS);
      }
      } catch { /* ignore transient errors */ }
  }, 120_000);

  // Prime existing previous_close values and last written price baselines
  const { data: cached } = await supabase
    .from('prices')
    .select('ticker,previous_close,price,updated_at');
  const prevClose: Record<string, number> = {};
  const lastWritten: Map<string, number> = new Map();
  const lastUpdatedAtMs: Record<string, number> = {};
  type CachedRow = { ticker: string; previous_close: number | null; price: number | null; updated_at?: string | null };
  for (const r of (cached as CachedRow[] | null) || []) {
    prevClose[r.ticker] = Number(r.previous_close || 0);
    if (r.price != null) lastWritten.set(r.ticker, Number(r.price));
    if (r.updated_at) {
      const ms = Date.parse(String(r.updated_at));
      if (Number.isFinite(ms) && ms > 0) lastUpdatedAtMs[r.ticker] = ms;
    }
  }

  // US: Finnhub WS streaming
  const finnhubToken = process.env.FINNHUB_API_KEY;
  const wsEnabled = !!finnhubToken && tickersUS.length > 0;
  type TickerTick = { price: number; ts: number };
  const latest: Map<string, TickerTick> = new Map();

  let ws: WebSocket | null = null;
  function connectFinnhub() {
    if (!wsEnabled) return;
    ws = new WebSocket(`wss://ws.finnhub.io?token=${finnhubToken}`);
    ws.on('open', () => {
      // Subscribe to US tickers (stagger to be polite)
      let i = 0;
      for (const t of tickersUS) {
        setTimeout(() => ws?.send(JSON.stringify({ type: 'subscribe', symbol: t })), i * 10);
        i++;
      }
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'trade' && Array.isArray(msg.data)) {
          for (const d of msg.data) {
            const s = String(d.s);
            const p = Number(d.p);
            const ts = normalizeEpochMillis(Number(d.t || 0));
            if (!Number.isFinite(p) || !Number.isFinite(ts) || ts <= 0) continue;
            const now = Date.now();
            // Ignore stale prints older than TRADE_MAX_AGE_MS
            if (now - ts > TRADE_MAX_AGE_MS) continue;
            const prev = latest.get(s);
            if (!prev || ts >= prev.ts) {
              latest.set(s, { price: p, ts });
            }
          }
        }
      } catch {}
    });
  ws.on('close', () => { setTimeout(connectFinnhub, 2000); });
    ws.on('error', () => { /* handled by close/retry */ });
  }
  connectFinnhub();

  // UK polling loop
  async function pollNonUSOnce(client: SupabaseClient) {
    const batch = tickersNonUS.slice();
    const nowIso = new Date().toISOString();
    const rows: PriceRow[] = [];
    for (const t of batch) {
      const res = await fetchYahooPrice(t);
      if (!res) continue;
      const mult = multiplier[t] ?? 1;
      // Store RAW values; multiplier provided separately
      const priceRaw = Number((res.price).toFixed(6));
      const pcRaw = res.previous_close ? Number((res.previous_close).toFixed(6)) : (prevClose[t] ?? 0);
      const price = priceRaw > 0 ? priceRaw : 0;
      const pc = pcRaw > 0 ? pcRaw : (prevClose[t] ?? 0);
      if (!(price > 0 || pc > 0)) { continue; } // never write pure zeros
      if (pc) prevClose[t] = pc;
      // Write suppression by epsilon
      const last = lastWritten.get(t);
      const pct = last ? Math.abs((price - last) / last) : 1;
      const abs = last ? Math.abs(price - last) : Infinity;
      if (last == null || abs >= MIN_ABS_CHANGE || pct >= MIN_PCT_CHANGE) {
        rows.push({ ticker: t, price, previous_close: pc || 0, price_multiplier: mult, updated_at: nowIso });
        lastWritten.set(t, price);
      }
      // polite small pause to avoid hammering
      await new Promise(r => setTimeout(r, 60));
    }
    if (rows.length) await persistRows(client, rows, 'yahoo');
    // schedule next every 5 minutes
    setTimeout(() => pollNonUSOnce(client), jitter(YAHOO_POLL_INTERVAL_MS));
  }

  // US fallback polling loop when market is closed (baseline seeding)
  // Remove US Yahoo seeding and closed polling per simplified model

  async function flushUS(client: SupabaseClient) {
    if (!wsEnabled) return setTimeout(() => flushUS(client), 2000);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows: PriceRow[] = [];
    for (const [t, rec] of latest.entries()) {
      // Skip if last trade is stale
      if (!rec || (nowMs - rec.ts > TRADE_MAX_AGE_MS)) continue;
      const mult = multiplier[t] ?? 1;
      // Store RAW value from WS
      let price = Number((rec.price).toFixed(6));
      let pc = prevClose[t] ?? 0;
      // If WS trade deviates too far from previous close, try REST quote for a sanity check
      if (pc > 0) {
        const deviation = Math.abs(price - pc) / pc;
        if (deviation >= 0.08) { // 8%+ deviation triggers verification
          const q = await fetchFinnhubQuote(t, finnhubToken);
          if (q && Number.isFinite(q.c) && q.c > 0) {
            price = Number(q.c.toFixed(6));
            if (Number.isFinite(q.pc) && q.pc > 0) pc = Number(q.pc.toFixed(6));
          } else {
            // REST unavailable/invalid: skip this outlier instead of writing a bad price
            continue;
          }
        }
      }
      // Write suppression by epsilon
      const last = lastWritten.get(t);
      const pct = last ? Math.abs((price - last) / last) : 1;
      const abs = last ? Math.abs(price - last) : Infinity;
      if (last == null || abs >= MIN_ABS_CHANGE || pct >= MIN_PCT_CHANGE) {
        rows.push({ ticker: t, price, previous_close: pc, price_multiplier: mult, updated_at: nowIso });
        lastWritten.set(t, price);
        if (pc > 0) prevClose[t] = pc;
      }
    }
    if (rows.length) await persistRows(client, rows, 'finnhub');
    setTimeout(() => flushUS(client), US_FLUSH_INTERVAL_MS);
  }

  // When US market is open but some symbols have not yet produced a WS tick,
  // fetch a baseline from Yahoo so the UI has a price immediately.
  // Remove US seeding loop

  let lastRevalidate = 0;
  async function persistRows(client: SupabaseClient, rows: PriceRow[], source: string) {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function upsertWithRetry(table: 'prices', payload: PricesUpsert[], maxRetries?: number): Promise<boolean>;
  async function upsertWithRetry(table: 'price_history', payload: PriceHistoryUpsert[], maxRetries?: number): Promise<boolean>;
  async function upsertWithRetry(table: string, payload: unknown[], maxRetries = 3): Promise<boolean> {
      let attempt = 0;
      let lastErr: unknown = null;
      while (attempt < maxRetries) {
        try {
          // Use conflict targets to prevent duplicates
          if (table === 'prices') {
            const { error } = await client.from('prices').upsert(payload as PricesUpsert[], { onConflict: 'ticker' });
            if (!error) return true;
            lastErr = error;
          } else if (table === 'price_history') {
            const { error } = await client.from('price_history').upsert(payload as PriceHistoryUpsert[], { onConflict: 'ticker,date' });
            if (!error) return true;
            lastErr = error;
          } else {
            const { error } = await client.from(table).upsert(payload as Record<string, unknown>[]);
            if (!error) return true;
            lastErr = error;
          }
        } catch (err) {
          lastErr = err;
        }
        attempt++;
        const backoff = Math.min(4000, 500 * 2 ** attempt);
        await sleep(backoff);
      }
      console.error(`${table} upsert failed after ${maxRetries} attempts`, lastErr);
      return false;
    }

    try {
      // Upsert prices
      const upserts: PricesUpsert[] = rows.map(r => ({
        ticker: r.ticker,
        price: r.price,
        previous_close: r.previous_close,
        price_multiplier: r.price_multiplier,
        source: `${source}@${hostname}`,
        updated_at: r.updated_at,
      }));
      const ok1 = await upsertWithRetry('prices', upserts);

      // Upsert price_history (daily)
      const hist: PriceHistoryUpsert[] = rows.map(r => ({
        ticker: r.ticker,
        date: r.updated_at.slice(0,10),
        price: r.price,
        previous_close: r.previous_close,
        price_multiplier: r.price_multiplier,
        source: `${source}@${hostname}`,
      }));
      const ok2 = await upsertWithRetry('price_history', hist);

      if (ok1 || ok2) {
        // compact success log; comment out if too chatty
        console.log(`[prices] wrote ${rows.length} rows (source=${source})`);

        // Optional: ping revalidate endpoint to drop Next.js cache tag 'prices'
        const revalidateUrl = process.env.REVALIDATE_URL || (
          process.env.NEXT_PUBLIC_APP_ORIGIN ? `${process.env.NEXT_PUBLIC_APP_ORIGIN}/api/prices/revalidate` : ''
        );
        const revalidateSecret = process.env.PRICES_REVALIDATE_SECRET;
        const now = Date.now();
        // Throttle calls to at most once every 5 seconds
        if (revalidateUrl && revalidateSecret && now - lastRevalidate > 5000) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2000);
            const headers: Record<string, string> = { 'x-revalidate-secret': revalidateSecret! };
            await fetch(revalidateUrl, { method: 'POST', headers, signal: ctrl.signal });
            clearTimeout(t);
            lastRevalidate = now;
          } catch {
            // non-fatal
          }
        }
      }
    } catch (e) {
      console.error('persistRows error', e);
    }
  }

  async function seedUSPricesOnce(client: SupabaseClient, tickersOverride?: string[]) {
    if (!PRICES_SEED_ON_STARTUP && !tickersOverride?.length) return;
    const batch = (tickersOverride?.length ? tickersOverride : tickersUS).slice();
    if (batch.length === 0) return;

    const nowMs = Date.now();
    const stale = (t: string) => {
      const last = lastUpdatedAtMs[t] ?? 0;
      return !last || (nowMs - last) > PRICES_STARTUP_SEED_MAX_AGE_MS;
    };

    // Prefer Finnhub REST for US tickers, but fall back to Yahoo if FINNHUB_API_KEY isn't set.
    const useFinnhub = !!finnhubToken;
    const nowIso = new Date(nowMs).toISOString();
    const rows: PriceRow[] = [];

    for (const t of batch) {
      if (!stale(t)) continue;
      const mult = multiplier[t] ?? 1;

      if (useFinnhub) {
        const q = await fetchFinnhubQuote(t, finnhubToken);
        if (q) {
          const price = Number((q.c || 0).toFixed(6));
          const pc = Number((q.pc || 0).toFixed(6)) || (prevClose[t] ?? 0);
          if (price > 0 || pc > 0) {
            rows.push({ ticker: t, price: price > 0 ? price : 0, previous_close: pc || 0, price_multiplier: mult, updated_at: nowIso });
            if (price > 0) lastWritten.set(t, price);
            if (pc > 0) prevClose[t] = pc;
            lastUpdatedAtMs[t] = nowMs;
          }
        }
      } else {
        const y = await fetchYahooPrice(t);
        if (y) {
          const price = Number((y.price || 0).toFixed(6));
          const pc = Number((y.previous_close || 0).toFixed(6)) || (prevClose[t] ?? 0);
          if (price > 0 || pc > 0) {
            rows.push({ ticker: t, price: price > 0 ? price : 0, previous_close: pc || 0, price_multiplier: mult, updated_at: nowIso });
            if (price > 0) lastWritten.set(t, price);
            if (pc > 0) prevClose[t] = pc;
            lastUpdatedAtMs[t] = nowMs;
          }
        }
      }

      // Polite pause to avoid hammering providers
      await new Promise(r => setTimeout(r, 80));
    }

    if (rows.length) await persistRows(client, rows, useFinnhub ? 'finnhub-seed' : 'yahoo-seed');
  }

  // Kick off loops
  // Seed US prices once on startup so a restart during closed markets still refreshes stale prices.
  await seedUSPricesOnce(supabase);
  // Poll all non-US markets via Yahoo every 5 minutes
  pollNonUSOnce(supabase);
  flushUS(supabase);
  const revalidateUrl = process.env.REVALIDATE_URL || (
    process.env.NEXT_PUBLIC_APP_ORIGIN ? `${process.env.NEXT_PUBLIC_APP_ORIGIN}/api/prices/revalidate` : ''
  );
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '(unset)';
  console.log(
    [
      `Price streamer running. US: ${tickersUS.length} via Finnhub ${wsEnabled ? 'WS' : '(disabled)'}; Non-US: ${tickersNonUS.length} via Yahoo (5m).`,
      `Supabase: ${supaUrl}`,
      `Revalidate: ${revalidateUrl ? revalidateUrl : '(disabled)'} (internal Docker alias; not a public URL)`,
    ].join(' | ')
  );

  // On exit, release the advisory lock if we acquired it
  async function unlock() {
    if (!haveLock) return;
    try { await supabase.rpc('unlock_price_streamer'); } catch {}
  }
  process.on('SIGINT', () => { unlock().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { unlock().finally(() => process.exit(0)); });
}

main().catch((e) => { console.error(e); process.exit(1); });
