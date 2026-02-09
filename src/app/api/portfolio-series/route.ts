import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { performance } from 'node:perf_hooks';

export const dynamic = 'force-dynamic';

type SeriesPoint = { date: string; value_gbp: number };
type ChangesMap = Record<string, number>; // ticker -> change in GBP over range
type ChangesNativeMap = Record<string, number>; // ticker -> native-currency change for selected range

type Ccy = 'GBP' | 'USD' | 'EUR';

const TYPE_PRIORITY: Record<string, number> = {
  SPL: 10,
  TIN: 20,
  BUY: 30,
  SELL: 40,
  TOT: 50,
  DIV: 90,
  INT: 95,
  FEE: 96,
  DEP: 97,
  WIT: 98,
  OTR: 99,
  BAL: 100,
};

function isCashTicker(t?: string | null) {
  return !!t && t.toUpperCase().startsWith('CASH.');
}

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

type AssetRow = {
  id: string;
  ticker: string;
  currency: string | null;
  status: string | null;
  resolved_ticker?: string | null;
  price_multiplier?: number | null;
};

type AssetMeta = {
  id: string;
  ticker: string;
  currency: Ccy;
  status: string;
  resolved_ticker: string;
  price_multiplier: number;
};

function compareTxForHoldings(a: Txn, b: Txn) {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const pa = TYPE_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = TYPE_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : 1;
}

async function fetchAllTable<T = any>(
  supabase: any,
  table: string,
  opts?: { pageSize?: number; select?: string }
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const pageSize = Math.min(opts?.pageSize ?? 1000, 1000);
  const select = opts?.select ?? '*';
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllPaged<T>(opts: {
  pageSize?: number;
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>;
}): Promise<T[]> {
  // Supabase/PostgREST often enforces a max page size (commonly 1000).
  // If you request more, it may silently cap the response, which would break our
  // "short page means we're done" logic. So cap here for safety.
  const pageSize = Math.min(opts.pageSize ?? 1000, 1000);
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await opts.fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data as T[] | null) || [];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function newCashMap(): Record<Ccy, number> {
  return { GBP: 0, USD: 0, EUR: 0 };
}

function applyHoldingTxn(sharesByTicker: Record<string, number>, meta: AssetMeta, tx: Txn) {
  const t = (tx.type || '').toUpperCase();
  const ticker = meta.ticker;
  const cur = sharesByTicker[ticker] ?? 0;

  if (t === 'SPL') {
    const factor = Number(tx.split_factor || 0);
    if (!factor || factor <= 0) return;
    sharesByTicker[ticker] = cur * factor;
    return;
  }

  const qty = Math.abs(Number(tx.quantity) || 0);
  if (!qty) return;

  if (t === 'BUY' || t === 'TIN') {
    sharesByTicker[ticker] = cur + qty;
  } else if (t === 'SELL' || t === 'TOT') {
    sharesByTicker[ticker] = cur - qty;
  }
}

function applyCashTxn(cash: Record<Ccy, number>, meta: AssetMeta, tx: Txn) {
  const t = (tx.type || '').toUpperCase();
  const isCashAsset = isCashTicker(meta.ticker);
  const assetCcy = (meta.currency || 'GBP').toUpperCase() as Ccy;

  // Match calculateCashBalancesMulti() behavior in src/lib/queries.ts
  // requireCashAssetForCashRows = true

  if (t === 'BAL') {
    const sign = (Number(tx.quantity) || 0) >= 0 ? +1 : -1;
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += sign * Math.abs(Number(tx.cash_value) || 0);
    }
    return;
  }

  if (t === 'DIV' || t === 'INT') {
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Math.abs(Number(tx.cash_value) || 0);
    }
    return;
  }

  if (t === 'DEP' || t === 'WIT' || t === 'FEE') {
    if (isCashAsset) {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        const amt = Math.abs(Number(tx.cash_value) || 0);
        const sign = (t === 'DEP') ? +1 : -1;
        cash[ccy] += sign * amt;
      }
    }
    return;
  }

  if (t === 'OTR') {
    if (isCashAsset) {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        cash[ccy] += Number(tx.cash_value) || 0;
      }
    }
    return;
  }

  if (t === 'BUY' || t === 'SELL') {
    if (tx.cash_value != null) {
      const amt = Math.abs(Number(tx.cash_value) || 0);
      const ccy = ((tx.cash_ccy || assetCcy).toUpperCase()) as Ccy;
      cash[ccy] += (t === 'BUY' ? -1 : +1) * amt;
    } else {
      // fallback compute in asset ccy
      const q = Number(tx.quantity) || 0;
      const p = Number(tx.price) || 0;
      const f = Number(tx.fee) || 0;
      const amt = t === 'BUY' ? (p * q + f) : (p * q - f);
      if (amt) cash[assetCcy] += (t === 'BUY' ? -1 : +1) * amt;
    }
    return;
  }

  if ((t === 'TIN' || t === 'TOT') && isCashAsset) {
    const sign = t === 'TIN' ? +1 : -1;
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Math.abs(Number(tx.cash_value) || 0) * sign;
    }
    return;
  }
}

async function backfillPriceHistoryFromYahoo(opts: {
  tickers: string[];
  tickersToBackfill?: string[];
  assetsByTicker: Record<string, AssetMeta>;
  from: string;
  to: string;
  supabaseRead?: any;
  supabaseWrite?: any;
  maxTickers?: number;
}): Promise<{ upserts: { ticker: string; date: string; price: number; price_multiplier: number }[]; wrote: boolean }> {
  const enabled = (process.env.SERIES_BACKFILL_PRICE_HISTORY ?? '1') !== '0';
  if (!enabled) return { upserts: [], wrote: false };

  const baseTickers = (opts.tickers || []).filter(Boolean);
  const tickers = ((opts.tickersToBackfill ?? baseTickers) || []).filter(Boolean).slice(0, opts.maxTickers ?? 60);
  if (tickers.length === 0) return { upserts: [], wrote: false };

  const fromDate = new Date(opts.from + 'T00:00:00Z');
  const toDate = new Date(opts.to + 'T00:00:00Z');
  const period1 = Math.floor(fromDate.getTime() / 1000);
  // Yahoo period2 is exclusive-ish; add 2 days to be safe
  const period2 = Math.floor((toDate.getTime() + 2 * 86400_000) / 1000);

  async function fetchYahooDaily(symbol: string): Promise<{ date: string; close: number }[]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = (res?.timestamp as number[] | undefined) || [];
    const close = (res?.indicators?.quote?.[0]?.close as (number | null)[] | undefined) || [];
    if (!Array.isArray(ts) || !Array.isArray(close) || ts.length !== close.length) return [];
    const out: { date: string; close: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const v = close[i];
      if (typeof v !== 'number' || !(v > 0)) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      out.push({ date: d, close: v });
    }
    return out;
  }

  // If caller pre-selected tickersToBackfill, we skip any extra DB reads here.
  // Otherwise, we fall back to the old coverage/gap check using price_history.
  let eligibleTickers = tickers;
  if (!opts.tickersToBackfill) {
    if (!opts.supabaseRead) return { upserts: [], wrote: false };

    // price_history generally contains trading days only; use weekdays as a closer
    // approximation so we don't constantly classify healthy series as "sparse".
    const expectedDays = Math.max(1, countWeekdays(opts.from, opts.to));
    const MIN_COVERAGE = 0.85;
    const MAX_GAP_DAYS = 5;

    type DateRow = { ticker: string; date: string };
    const dateRowsAll = await fetchAllPaged<DateRow>({
      pageSize: 1000,
      fetchPage: async (fromIdx, toIdx) =>
        await opts.supabaseRead
          .from('price_history')
          .select('ticker,date')
          .in('ticker', tickers)
          .gte('date', opts.from)
          .lte('date', opts.to)
          .order('ticker', { ascending: true })
          .order('date', { ascending: true })
          .range(fromIdx, toIdx),
    });
    const daysByTicker = new Map<string, Set<string>>();
    for (const r of dateRowsAll) {
      const t = String((r as any).ticker || '').trim();
      const d = String((r as any).date || '').slice(0, 10);
      if (!t || !d) continue;
      let set = daysByTicker.get(t);
      if (!set) {
        set = new Set<string>();
        daysByTicker.set(t, set);
      }
      set.add(d);
    }

    eligibleTickers = [];
    for (const t of tickers) {
      const meta = opts.assetsByTicker[t];
      if (!meta) continue;
      if (isCashTicker(meta.ticker)) continue;

      const days = daysByTicker.get(t) || new Set<string>();
      const distinctDays = days.size;
      let maxGap = 0;
      const sorted = Array.from(days.values()).sort();
      for (let i = 1; i < sorted.length; i++) {
        const a = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
        const b = new Date(sorted[i] + 'T00:00:00Z').getTime();
        const gap = Math.round((b - a) / 86400_000);
        if (gap > maxGap) maxGap = gap;
      }
      const coverage = distinctDays / expectedDays;
      if (coverage < MIN_COVERAGE || maxGap >= MAX_GAP_DAYS) eligibleTickers.push(t);
    }
  }

  const upsertsOut: { ticker: string; date: string; price: number; price_multiplier: number }[] = [];
  let wrote = false;

  for (const t of eligibleTickers) {
    const meta = opts.assetsByTicker[t];
    if (!meta) continue;
    if (isCashTicker(meta.ticker)) continue;

    const rows = await fetchYahooDaily(meta.resolved_ticker || meta.ticker);
    if (!rows.length) continue;

    const upserts = rows
      .filter(r => r.date >= opts.from && r.date <= opts.to)
      .map(r => ({
        ticker: t,
        date: r.date,
        price: Number(r.close.toFixed(6)),
        price_multiplier: meta.price_multiplier || 1,
        source: 'yahoo:backfill',
      }));

    for (const u of upserts) {
      upsertsOut.push({
        ticker: u.ticker,
        date: u.date,
        price: u.price,
        price_multiplier: Number(u.price_multiplier || 1) || 1,
      });
    }

    if (upserts.length && opts.supabaseWrite) {
      await opts.supabaseWrite.from('price_history').upsert(upserts, { onConflict: 'ticker,date' });
      wrote = true;
    }

    await new Promise(r => setTimeout(r, 120));
  }

  return { upserts: upsertsOut, wrote };
}

function toISODate(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

function addDays(d: Date, days: number) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function countWeekdays(from: string, to: string): number {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

function daterange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(toISODate(d));
  }
  return out;
}

function parseFxQuotesToGBP(quotes: Record<string, number> | null | undefined): Record<string, number> {
  const rates: Record<string, number> = { GBP: 1 };
  if (!quotes) return rates;
  for (const [k, v] of Object.entries(quotes)) {
    const m = k.match(/^GBP([A-Z]{3})$/);
    if (m && typeof v === 'number' && v > 0) {
      rates[m[1]] = 1 / v; // quote is GBPXXX, convert to XXX->GBP
    }
  }
  return rates;
}

function bumpToNextMondayIfWeekend(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return isoDate;
  const dow = d.getUTCDay();
  if (dow === 6) return toISODate(addDays(d, 2)); // Sat -> Mon
  if (dow === 0) return toISODate(addDays(d, 1)); // Sun -> Mon
  return isoDate;
}

export async function GET(request: Request) {
  const tStart = performance.now();
  const timings_ms: Record<string, number> = {};
  const mark = (k: string) => {
    timings_ms[k] = Math.round(performance.now() - tStart);
  };

  const { searchParams } = new URL(request.url);
  const range = (searchParams.get('range') || '1M').toUpperCase();
  // Optional timezone for defining "today" and intraday clipping
  const tz = searchParams.get('tz') || 'Europe/London';
  const debug = (searchParams.get('debug') || '') === '1';

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  mark('auth');

  const settingsRes = await supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .maybeSingle<{ show_zero_holdings: boolean | null; visible_statuses: string[] | null }>();
  const showZeroHoldings = !!settingsRes.data?.show_zero_holdings;
  const visibleStatusesSet = new Set((settingsRes.data?.visible_statuses ?? ['active']).map(s => String(s).toLowerCase().trim()));
  type HoldingRow = { status?: string | null; total_shares: number; ticker: string };
  const keepHolding = (h: HoldingRow) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visibleStatusesSet.has(status);
  };
  mark('settings');

  // 2) Determine date range
  // Compute today's date in requested timezone
  function dateInTzISO(d: Date, timeZone: string) {
    // Use locale date formatting to derive YYYY-MM-DD reliably
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d);
    // en-CA yields YYYY-MM-DD already
    return parts;
  }
  const today = dateInTzISO(new Date(), tz);
  let from = today;
  if (range === '1D') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -1));
  } else if (range === '1W') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -7));
  } else if (range === '1M') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -30));
  } else if (range === 'YTD') {
    const now = new Date(today + 'T00:00:00Z');
    from = toISODate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
  } else if (range === '1Y') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  } else if (range === 'ALL') {
    // earliest transaction date
    const { data: firstTxn } = await supabase
      .from('transactions')
      .select('date')
      .not('date', 'is', null)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle();
    from = firstTxn?.date?.slice(0, 10) || toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  }

  // If a daily range starts on a weekend, jump forward to Monday.
  // This prevents charts starting with "cash only" weekend points when the
  // first available close is Monday.
  if (range !== '1D') {
    from = bumpToNextMondayIfWeekend(from);
  }

  mark('range');

  // Preload assets + transactions once (used by both intraday and daily series)
  const [{ data: assetsRaw }, txnsRaw] = await Promise.all([
    supabase
      .from('assets')
      .select('id,ticker,currency,status,resolved_ticker,price_multiplier'),
    fetchAllTable<Txn>(supabase, 'transactions', {
      select: 'id,asset_id,type,date,created_at,quantity,price,fee,cash_value,cash_ccy,settle_value,settle_ccy,split_factor',
    }),
  ]);

  const assets = (assetsRaw as AssetRow[] | null) || [];
  const assetById: Record<string, AssetMeta> = {};
  const assetsByTicker: Record<string, AssetMeta> = {};
  for (const a of assets) {
    const t = String(a.ticker || '').trim();
    if (!t) continue;
    const currency = (String(a.currency || 'GBP').toUpperCase()) as Ccy;
    const status = String(a.status || 'active');
    const resolved = String((a as any).resolved_ticker || t);
    const mult = Number((a as any).price_multiplier || 1) || 1;
    const meta: AssetMeta = { id: a.id, ticker: t, currency, status, resolved_ticker: resolved, price_multiplier: mult };
    assetById[a.id] = meta;
    assetsByTicker[t] = meta;
  }

  const txnsAll = (txnsRaw as Txn[] | null) || [];
  const txns = txnsAll
    .filter(tx => {
      if (!tx?.asset_id) return false;
      if (!tx.date) return true;
      const d = String(tx.date).slice(0, 10);
      return d <= today;
    })
    .sort(compareTxForHoldings);

  // Compute "current" holdings tickers (and cash) without calling queries.ts,
  // to avoid a second full read of transactions.
  const sharesNow: Record<string, number> = {};
  const cashNow = newCashMap();
  const undatedNow: Txn[] = [];
  const datedNow: Txn[] = [];
  for (const tx of txns) {
    if (!tx.date) undatedNow.push(tx);
    else datedNow.push(tx);
  }
  undatedNow.sort(compareTxForHoldings);
  datedNow.sort(compareTxForHoldings);
  for (const tx of undatedNow) {
    const meta = assetById[tx.asset_id];
    if (!meta) continue;
    applyCashTxn(cashNow, meta, tx);
    if (!isCashTicker(meta.ticker)) applyHoldingTxn(sharesNow, meta, tx);
  }
  for (const tx of datedNow) {
    const meta = assetById[tx.asset_id];
    if (!meta) continue;
    applyCashTxn(cashNow, meta, tx);
    if (!isCashTicker(meta.ticker)) applyHoldingTxn(sharesNow, meta, tx);
  }

  const holdingsNow: HoldingRow[] = [];
  for (const [ticker, total_shares] of Object.entries(sharesNow)) {
    const meta = assetsByTicker[ticker];
    if (!meta) continue;
    holdingsNow.push({ ticker, total_shares, status: meta.status });
  }
  const holdings = holdingsNow.filter(keepHolding);
  const tickers = holdings.map(h => h.ticker).filter(Boolean);

  mark('assets_txns');

  // Special case: 1D intraday series using Yahoo 5m chart
  if (range === '1D') {
    type IntradayPoint = { ts: number; price: number };
    // Resolve tickers and multipliers
    const resMap: Record<string, { resolved: string; mult: number }> = {};
    for (const t of tickers) {
      const meta = assetsByTicker[t];
      resMap[t] = { resolved: meta?.resolved_ticker || t, mult: Number(meta?.price_multiplier || 1) || 1 };
    }

    async function fetchYahoo5m(symbol: string): Promise<{ ts: number[]; close: (number | null)[] } | null> {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
        const r = await fetch(url);
        if (!r.ok) return null;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        const ts = (res?.timestamp as number[] | undefined) || [];
        const close = (res?.indicators?.quote?.[0]?.close as (number | null)[] | undefined) || [];
        if (!ts.length || !close.length) return null;
        return { ts, close };
      } catch {
        return null;
      }
    }

    // Fetch FX (today)
  const { data: fxRow } = await supabase.from('fx_rates').select('date,quotes').eq('date', today).maybeSingle<{ date: string; quotes: Record<string, number> | null }>();
  const fxToday = parseFxQuotesToGBP(fxRow?.quotes ?? undefined);

    // Determine current-day holdings and cash (as-of today)
    const dayCash = (Object.keys(cashNow) as Ccy[]).map(ccy => ({ currency: ccy, balance: cashNow[ccy] || 0 }));
    const holdingsByTicker: Record<string, { shares: number; ccy: string }> = {};
    for (const t of tickers) {
      const meta = assetsByTicker[t];
      if (!meta) continue;
      holdingsByTicker[t] = { shares: Number(sharesNow[t] || 0), ccy: (meta.currency || 'GBP').toUpperCase() };
    }

  // Fetch intraday series in small batches
  const BATCH = 12; // slightly larger batch for faster load
    const seriesByTicker: Record<string, IntradayPoint[]> = {};
    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(t => fetchYahoo5m(resMap[t].resolved)));
      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        const r = results[j];
        if (!r) continue;
        const mult = resMap[t].mult || 1;
        const arr: IntradayPoint[] = [];
        for (let k = 0; k < r.ts.length; k++) {
          const v = r.close[k];
          if (v && v > 0) arr.push({ ts: r.ts[k], price: v * mult });
        }
        if (arr.length) seriesByTicker[t] = arr;
      }
  // Keep a tiny throttle to avoid hammering the provider; reduce from 500ms to 100ms
  if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 100));
    }

    // Seed from recent daily closes in price_history (prefer the most recent non-zero close within last 5 days)
    const fiveDaysAgo = toISODate(addDays(new Date(today + 'T00:00:00Z'), -5));
    const { data: recentHist } = await supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__'])
      .gte('date', fiveDaysAgo)
      .lte('date', today)
      .order('date', { ascending: true });
    const seedPrice: Record<string, number> = {};
    for (const r of (recentHist || []) as { ticker: string; date: string; price: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const close = Number(r.price || 0) * mult;
      if (close > 0) seedPrice[r.ticker] = close; // later rows overwrite earlier → most recent wins
    }

    // Fallback: seed any missing tickers using current cached prices.
    // This ensures the final point reflects total worth even if intraday Yahoo data or price_history is sparse.
    const { data: currentPriceRows } = await supabase
      .from('prices')
      .select('ticker,price,previous_close,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__']);
    for (const r of (currentPriceRows || []) as { ticker: string; price: number | null; previous_close: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const price = Number(r.price || 0) * mult;
      if (price > 0 && !seedPrice[r.ticker]) seedPrice[r.ticker] = price;
    }

    // Build union timeline of timestamps
    const tsSet = new Set<number>();
    for (const list of Object.values(seriesByTicker)) for (const p of list) tsSet.add(p.ts);
    let timeline = Array.from(tsSet).sort((a, b) => a - b);
    // Helpers for tz-aware day and minute-of-day
    const isSameDayInTz = (ts: number) => dateInTzISO(new Date(ts * 1000), tz) === today;
    function minutesSinceMidnightInTz(ts: number, tzLocal: string): number {
      const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tzLocal }).formatToParts(new Date(ts * 1000));
      let h = 0, m = 0; for (const p of parts) { if (p.type === 'hour') h = parseInt(p.value, 10); else if (p.type === 'minute') m = parseInt(p.value, 10); }
      return h * 60 + m;
    }
    const WINDOW_START_MIN = 8 * 60;  // 08:00 UK
    const WINDOW_END_MIN = 22 * 60;   // 22:00 UK
    const inWindow = (ts: number) => {
      if (!isSameDayInTz(ts)) return false;
      const mm = minutesSinceMidnightInTz(ts, tz);
      return mm >= WINDOW_START_MIN && mm <= WINDOW_END_MIN;
    };
    // Keep only points within today's 08:00–22:00 window
    timeline = timeline.filter(inWindow);

    const STEP = 300; // 5 minutes
    const nowSec = Math.floor(Date.now() / 1000);

    // If empty, seed with 'now' if within window so we can back/forward fill grid
    const nowInWindow = inWindow(nowSec);
    if (timeline.length === 0 && nowInWindow) timeline = [nowSec];

    // Extend backward to 08:00 and forward to 'now' within the same tz day
    if (timeline.length > 0) {
      // Backward to window start
      let first = timeline[0];
      while (true) {
        const prev = first - STEP;
        if (!isSameDayInTz(prev)) break;
        const mm = minutesSinceMidnightInTz(prev, tz);
        if (mm < WINDOW_START_MIN) break;
        timeline.unshift(prev);
        first = prev;
      }
      // Forward to 'now' (but don't push beyond end-of-window; leave empty space for rest)
      let last = timeline[timeline.length - 1];
      while (true) {
        const next = last + STEP;
        if (next > nowSec) break;
        if (!isSameDayInTz(next)) break;
        const mm = minutesSinceMidnightInTz(next, tz);
        if (mm > WINDOW_END_MIN) break;
        timeline.push(next);
        last = next;
      }
    }
  if (timeline.length === 0) return NextResponse.json({ range, from: today, to: today, points: [] });

  // Forward-fill prices per ticker and aggregate to GBP
    const lastPrice: Record<string, number> = { ...seedPrice };
    const points: { date: string; value_gbp: number }[] = [];
    // Precompute constant cash GBP value (today's FX)
    const cashGBP = dayCash.reduce((s, c) => s + (c.balance || 0) * (fxToday[(c.currency || 'GBP').toUpperCase()] ?? 1), 0);
    // For fast lookup, map per-ticker by timestamp
    const byTs: Record<string, Map<number, number>> = {};
    for (const [t, list] of Object.entries(seriesByTicker)) {
      const m = new Map<number, number>();
      for (const p of list) m.set(p.ts, p.price);
      byTs[t] = m;
    }

    for (const ts of timeline) {
      let totalGBP = cashGBP;
      for (const t of tickers) {
        const m = byTs[t];
        const p = m?.get(ts);
        if (p && p > 0) lastPrice[t] = p;
        const lp = lastPrice[t];
        if (!lp) continue;
        const h = holdingsByTicker[t];
        if (!h || !h.shares) continue;
        const rate = fxToday[h.ccy] ?? 1;
        totalGBP += h.shares * lp * rate;
      }
      points.push({ date: new Date(ts * 1000).toISOString(), value_gbp: Math.round(totalGBP) });
    }

    // Compute per-ticker 1D change in GBP using previous_close from prices
    // and the latest known intraday price (or seed close) for 'current'.
    const prevCloseMap: Record<string, { prev: number; mult: number }> = {};
    for (const r of (currentPriceRows || []) as { ticker: string; previous_close: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const prev = Number(r.previous_close || 0) * mult;
      if (prev > 0) prevCloseMap[r.ticker] = { prev, mult };
    }
    const changes: ChangesMap = {};
    const changes_native: ChangesNativeMap = {};
    for (const t of tickers) {
      const h = holdingsByTicker[t];
      if (!h || !h.shares) continue;
      const rate = fxToday[h.ccy] ?? 1;
      const cur = lastPrice[t] || 0;
      const prev = prevCloseMap[t]?.prev || 0;
      if (cur > 0 && prev > 0) {
        const deltaNative = (cur - prev) * h.shares;
        changes_native[t] = deltaNative;
        changes[t] = deltaNative * rate;
      } else {
        changes_native[t] = 0;
        changes[t] = 0;
      }
    }

    return NextResponse.json(
      { range, from: today, to: today, points, tz, changes, changes_native },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3) Load price history (daily) for tickers and FX rates over the range
  // Build a service-role client ONLY for optional backfill upserts.
  // Keep all reads scoped to the authenticated user client (`supabase`) to respect RLS.
  const urlEnv = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseWrite = urlEnv && svcKey ? createClient(urlEnv, svcKey) : null;

  // Fetch a buffer before `from` so weekend/holiday range starts can be seeded
  // with the last available close / FX, avoiding artificial jumps from cash-only.
  const bufferDays = range === 'ALL' ? 180 : range === '1Y' ? 45 : range === 'YTD' ? 45 : 21;
  const fromBuffer = toISODate(addDays(new Date(from + 'T00:00:00Z'), -bufferDays));

  // Backfill candidates: current holdings + tickers with trading activity in the buffered window.
  // This keeps backfill fast and focused while still fixing the “flat month” issue.
  const candidateTickersSet = new Set<string>();
  for (const h of holdings) {
    const t = String((h as any).ticker || '').trim();
    if (t && !isCashTicker(t)) candidateTickersSet.add(t);
  }
  for (const tx of txns) {
    const meta = assetById[tx.asset_id];
    if (!meta) continue;
    if (isCashTicker(meta.ticker)) continue;
    const ttype = (tx.type || '').toUpperCase();
    if (ttype === 'DIV' || ttype === 'INT' || ttype === 'DEP' || ttype === 'WIT' || ttype === 'FEE' || ttype === 'BAL' || ttype === 'OTR') continue;
    const d = tx.date ? String(tx.date).slice(0, 10) : null;
    if (!d || d >= fromBuffer) candidateTickersSet.add(meta.ticker);
  }
  const candidateTickers = Array.from(candidateTickersSet.values()).sort();

  type PriceHistRow = { ticker: string; date: string; price: number | null; price_multiplier: number | null };
  type FxRow = { date: string; quotes: Record<string, number> | null };
  type CurrentPriceRow = { ticker: string; price: number | null; price_multiplier: number | null; previous_close: number | null };

  // IMPORTANT: PostgREST enforces default row limits (often 1k). We must paginate,
  // otherwise charts can appear flat because most rows in the window are never fetched.
  const [ph, fxRows, cpRes] = await Promise.all([
    fetchAllPaged<PriceHistRow>({
      pageSize: 1000,
      fetchPage: async (fromIdx, toIdx) =>
        await supabase
          .from('price_history')
          .select('ticker,date,price,price_multiplier')
          .in('ticker', candidateTickers.length ? candidateTickers : ['__none__'])
          .gte('date', fromBuffer)
          .lte('date', today)
          .order('date', { ascending: true })
          .order('ticker', { ascending: true })
          .range(fromIdx, toIdx),
    }),
    fetchAllPaged<FxRow>({
      pageSize: 1000,
      fetchPage: async (fromIdx, toIdx) =>
        await supabase
          .from('fx_rates')
          .select('date,quotes')
          .gte('date', fromBuffer)
          .lte('date', today)
          .order('date', { ascending: true })
          .range(fromIdx, toIdx),
    }),
    supabase
      .from('prices')
      .select('ticker,price,price_multiplier,previous_close')
      .in('ticker', candidateTickers.length ? candidateTickers : ['__none__']),
  ]);

  mark('prices_fx');

  const currentPrices = (cpRes.data as CurrentPriceRow[] | null) || [];

  const historyByTicker: Record<string, { date: string; price: number; mult: number }[]> = {};
  for (const row of ph) {
    const t = row.ticker;
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    const price = Number(row.price || 0);
    const rowMult = Number(row.price_multiplier || 1) || 1;
    const assetMult = Number(assetsByTicker[t]?.price_multiplier || 1) || 1;
    // If historic rows were backfilled to multiplier=1 (migration default) but
    // the asset has a non-1 multiplier (e.g. GBp→GBP = 0.01), prefer the asset
    // multiplier to avoid 100x valuation spikes.
    const mult = assetMult !== 1 && rowMult === 1 ? assetMult : rowMult;
    (historyByTicker[t] ||= []).push({ date, price, mult });
  }

  // Optional backfill: only hit Yahoo when the already-fetched history looks sparse.
  // This avoids doing a second full read of price_history for coverage detection.
  const expectedDays = Math.max(1, countWeekdays(from, today));
  const MIN_COVERAGE = 0.85;
  const MAX_GAP_DAYS = 5;
  const tickersToBackfill: string[] = [];

  for (const t of candidateTickers) {
    const meta = assetsByTicker[t];
    if (!meta) continue;
    if (isCashTicker(meta.ticker)) continue;

    const entries = historyByTicker[t] || [];
    const days: string[] = [];
    for (const e of entries) {
      if (!e?.date) continue;
      if (e.date < from || e.date > today) continue;
      if (!(e.price > 0)) continue;
      days.push(e.date);
    }

    if (days.length === 0) {
      tickersToBackfill.push(t);
      continue;
    }

    days.sort();
    let distinctDays = 1;
    let maxGap = 0;
    for (let i = 1; i < days.length; i++) {
      if (days[i] !== days[i - 1]) distinctDays++;
      const a = new Date(days[i - 1] + 'T00:00:00Z').getTime();
      const b = new Date(days[i] + 'T00:00:00Z').getTime();
      const gap = Math.round((b - a) / 86400_000);
      if (gap > maxGap) maxGap = gap;
    }

    const coverage = distinctDays / expectedDays;
    if (coverage < MIN_COVERAGE || maxGap >= MAX_GAP_DAYS) tickersToBackfill.push(t);
  }

  let backfillWrote = false;
  let backfillUpserts: { ticker: string; date: string; price: number; price_multiplier: number }[] = [];
  if (tickersToBackfill.length > 0) {
    const res = await backfillPriceHistoryFromYahoo({
      tickers: candidateTickers,
      tickersToBackfill,
      assetsByTicker,
      from,
      to: today,
      supabaseWrite,
      maxTickers: 160,
    });
    backfillWrote = res.wrote;
    backfillUpserts = res.upserts;
    for (const u of backfillUpserts) {
      const t = String(u.ticker || '').trim();
      const d = String(u.date || '').slice(0, 10);
      if (!t || !d) continue;
      (historyByTicker[t] ||= []).push({
        date: d,
        price: Number(u.price || 0),
        mult: Number(u.price_multiplier || 1) || 1,
      });
    }
  }

  mark('backfill');

  const todayStr = today;
  const cpMap: Record<string, { price: number; mult: number; prev: number }> = {};
  for (const r of currentPrices) {
    const t = r.ticker;
    const price = Number(r.price || 0);
    const mult = Number(r.price_multiplier || 1) || 1;
    const prev = Number(r.previous_close || 0) || 0;
    cpMap[t] = { price, mult, prev };
  }
  for (const t of candidateTickers) {
    const list = (historyByTicker[t] ||= []);
    if (!list.find(e => e.date === todayStr)) {
      const cp = cpMap[t];
      if (cp && cp.price > 0) list.push({ date: todayStr, price: cp.price, mult: cp.mult });
    }
  }

  const fxByDate: Record<string, Record<string, number>> = {};
  let lastFxBeforeFrom: Record<string, number> = { GBP: 1 };
  let firstFxInWindow: Record<string, number> | null = null;
  for (const r of fxRows) {
    const d = String(r.date || '').slice(0, 10);
    if (!d) continue;
    fxByDate[d] = parseFxQuotesToGBP(r.quotes || undefined);
    if (d < from) lastFxBeforeFrom = fxByDate[d];
    if (!firstFxInWindow) firstFxInWindow = fxByDate[d];
  }
  // If we have no FX rows before `from` (common when fx_rates history is sparse),
  // back-fill using the earliest available FX in the window so USD/EUR don't
  // get treated as GBP (rate=1).
  if (lastFxBeforeFrom.USD == null && lastFxBeforeFrom.EUR == null && firstFxInWindow) {
    lastFxBeforeFrom = firstFxInWindow;
  }
  const allDates = daterange(from, today);
  let lastFx: Record<string, number> = fxByDate[from] || lastFxBeforeFrom;
  for (const d of allDates) {
    if (fxByDate[d]) lastFx = fxByDate[d];
    else fxByDate[d] = lastFx;
  }

  // Prepare per-ticker daily prices with forward-fill
  const priceAtDate: Record<string, Record<string, number>> = {};
  for (const t of candidateTickers) {
    const entries = (historyByTicker[t] || []).sort((a, b) => (a.date < b.date ? -1 : 1));
    const map: Record<string, number> = {};
    let last = 0;
    let idx = 0;

    // Seed `last` using the latest known price before the requested range.
    while (idx < entries.length && entries[idx].date < from) {
      const e = entries[idx];
      if (e && e.price > 0) last = e.price * (e.mult || 1);
      idx++;
    }

    for (const d of allDates) {
      // Consume any entries up to and including this day.
      // This makes the series robust whether `date` is stored as a DATE or TIMESTAMP.
      while (idx < entries.length && entries[idx].date <= d) {
        const e = entries[idx];
        if (e && e.price > 0) last = e.price * (e.mult || 1);
        idx++;
      }
      map[d] = last;
    }
    priceAtDate[t] = map;
  }

  // Group transactions by date for incremental simulation
  const undated: Txn[] = [];
  const beforeRange: Txn[] = [];
  const byDate: Record<string, Txn[]> = {};
  for (const tx of txns) {
    if (!tx.date) {
      undated.push(tx);
      continue;
    }
    const d = String(tx.date).slice(0, 10);
    if (d < from) {
      beforeRange.push(tx);
    } else {
      (byDate[d] ||= []).push(tx);
    }
  }
  undated.sort(compareTxForHoldings);
  beforeRange.sort(compareTxForHoldings);
  for (const list of Object.values(byDate)) list.sort(compareTxForHoldings);

  const sharesByTicker: Record<string, number> = {};
  const cash = newCashMap();

  // Apply undated transactions once (impact all dates)
  for (const tx of undated) {
    const meta = assetById[tx.asset_id];
    if (!meta) continue;
    applyCashTxn(cash, meta, tx);
    if (!isCashTicker(meta.ticker)) applyHoldingTxn(sharesByTicker, meta, tx);
  }

  // Seed starting state at `from` by applying all dated transactions strictly before the range.
  for (const tx of beforeRange) {
    const meta = assetById[tx.asset_id];
    if (!meta) continue;
    applyCashTxn(cash, meta, tx);
    if (!isCashTicker(meta.ticker)) applyHoldingTxn(sharesByTicker, meta, tx);
  }

  const series: SeriesPoint[] = [];
  const tickersEverHeld = new Set<string>();

  let debugFirst: any = null;
  let debugMax: any = null;
  let debugMaxVal = -Infinity;

  function snapshotBreakdown(day: string) {
    const fx = fxByDate[day] || { GBP: 1 };
    const cashGBP = (Object.keys(cash) as Ccy[])
      .map(ccy => ({ ccy, bal: cash[ccy] || 0, rate: fx[ccy] ?? 1 }))
      .filter(x => x.bal)
      .map(x => ({ ccy: x.ccy, balance: x.bal, fx: x.rate, value_gbp: x.bal * x.rate }));

    const contrib = Object.entries(sharesByTicker)
      .map(([t, shares]) => {
        if (!shares) return null;
        const meta = assetsByTicker[t];
        if (!meta) return null;
        const status = (meta.status ? String(meta.status) : 'unknown').toLowerCase();
        if (!visibleStatusesSet.has(status)) return null;
        if (!showZeroHoldings && shares === 0) return null;
        const p = priceAtDate[t]?.[day] || 0;
        if (!p) return null;
        const ccy = (meta.currency || 'GBP').toUpperCase();
        const rate = fx[ccy] ?? 1;
        const value = shares * p * rate;
        return { ticker: t, shares, price: p, ccy, fx: rate, value_gbp: value };
      })
      .filter(Boolean) as { ticker: string; shares: number; price: number; ccy: string; fx: number; value_gbp: number }[];

    contrib.sort((a, b) => b.value_gbp - a.value_gbp);
    return {
      date: day,
      fx: { GBP: 1, USD: fx.USD ?? null, EUR: fx.EUR ?? null },
      top: contrib.slice(0, 12),
      cash: cashGBP,
    };
  }

  // Daily simulation
  for (const d of allDates) {
    const dayTxns = byDate[d] || [];
    for (const tx of dayTxns) {
      const meta = assetById[tx.asset_id];
      if (!meta) continue;
      applyCashTxn(cash, meta, tx);
      if (!isCashTicker(meta.ticker)) applyHoldingTxn(sharesByTicker, meta, tx);
    }

    let totalGBP = 0;
    const fx = fxByDate[d] || { GBP: 1 };

    // Holdings market value
    for (const [t, shares] of Object.entries(sharesByTicker)) {
      if (!shares) continue;
      const meta = assetsByTicker[t];
      if (!meta) continue;
      const status = (meta.status ? String(meta.status) : 'unknown').toLowerCase();
      if (!visibleStatusesSet.has(status)) continue;
      const hasUnits = (shares ?? 0) !== 0;
      if (!showZeroHoldings && !hasUnits) continue;

      const p = priceAtDate[t]?.[d] || 0;
      if (!p) continue;
      const rate = fx[(meta.currency || 'GBP').toUpperCase()] ?? 1;
      totalGBP += shares * p * rate;
      tickersEverHeld.add(t);
    }

    // Cash (multi-ccy)
    for (const ccy of (Object.keys(cash) as Ccy[])) {
      const bal = cash[ccy] || 0;
      if (!bal) continue;
      totalGBP += bal * (fx[ccy] ?? 1);
    }

    series.push({ date: d, value_gbp: Math.round(totalGBP) });

    if (debug) {
      if (!debugFirst) {
        debugFirst = {
          point: { date: d, value_gbp: Math.round(totalGBP) },
          breakdown: snapshotBreakdown(d),
        };
      }
      if (totalGBP > debugMaxVal) {
        debugMaxVal = totalGBP;
        debugMax = {
          point: { date: d, value_gbp: Math.round(totalGBP) },
          breakdown: snapshotBreakdown(d),
        };
      }
    }
  }

  mark('simulate');

  // Per-ticker changes for sorting: shares as-of today
  const changes: ChangesMap = {};
  const changes_native: ChangesNativeMap = {};
  const fxToday = fxByDate[today] || { GBP: 1 };
  const fxFrom = fxByDate[from] || { GBP: 1 };
  for (const t of tickersEverHeld) {
    const shares = Number(sharesByTicker[t] || 0);
    if (!shares) continue;
    const meta = assetsByTicker[t];
    if (!meta) continue;
    const ccy = (meta.currency || 'GBP').toUpperCase();
    const pToday = priceAtDate[t]?.[today] || 0;
    const pFrom = priceAtDate[t]?.[from] || 0;
    const rateToday = fxToday[ccy] ?? 1;
    const rateFrom = fxFrom[ccy] ?? 1;
    if (pToday > 0 && pFrom > 0) {
      changes_native[t] = shares * (pToday - pFrom);
      changes[t] = shares * (pToday * rateToday - pFrom * rateFrom);
    } else {
      changes_native[t] = 0;
      changes[t] = 0;
    }
  }

  if (debug) {
    const uniqueVals = new Set(series.map(p => p.value_gbp)).size;
    return NextResponse.json({
      range,
      from,
      to: today,
      points: series,
      tz,
      changes,
      changes_native,
      debug: {
        timings_ms,
        backfill_enabled: (process.env.SERIES_BACKFILL_PRICE_HISTORY ?? '1') !== '0',
        used_service_role: !!supabaseWrite,
        backfill_wrote: backfillWrote,
        backfill_upserts: backfillUpserts.length,
        backfill_tickers: tickersToBackfill.length,
        candidate_tickers: candidateTickers.length,
        txns_rows_total: txnsAll.length,
        txns_rows_used: txns.length,
        price_history_rows: ph.length,
        fx_rows: fxRows.length,
        series_unique_values: uniqueVals,
        first: debugFirst,
        max: debugMax,
        server_time: new Date().toISOString(),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json(
    { range, from, to: today, points: series, tz, changes, changes_native },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
