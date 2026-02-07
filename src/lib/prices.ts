import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PriceRow = {
  price: number;
  previous_close: number;
  updated_at: string;
  price_multiplier: number;
};

// Keep provider stats shape for API consumers; values remain null in this simplified mode
export type FinnhubStats = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: number | null;
  failureCount: number;
  lastSymbol?: string | null;
  lastFetchedAt?: string | null;
  lastC?: number | null;
  lastPC?: number | null;
};

const STATS_NULL: FinnhubStats = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  failureCount: 0,
  lastSymbol: null,
  lastFetchedAt: null,
  lastC: null,
  lastPC: null,
};

export function getFinnhubStats(): FinnhubStats { return STATS_NULL; }

// Simplified: only read latest cached rows from DB; streamer is responsible for updates
export async function fetchAndCachePrices(
  allTickers: string[],
  _tickerQuantities?: Record<string, number>,
  clientParam?: SupabaseClient
): Promise<Record<string, PriceRow>> {
  const client = clientParam || supabase;
  if (!allTickers || allTickers.length === 0) return {};

  const { data, error } = await client
    .from('prices')
    .select('ticker,price,previous_close,price_multiplier,updated_at')
    .in('ticker', allTickers)
    .order('updated_at', { ascending: true });

  if (error) {
    console.error('prices read error:', error);
    return {};
  }

  type Row = { ticker: string; price: number | null; previous_close: number | null; price_multiplier: number | null; updated_at: string };
  const map: Record<string, Row> = {};
  for (const r of (data as Row[] | null) || []) {
    const prev = map[r.ticker];
    if (!prev || new Date(r.updated_at).getTime() >= new Date(prev.updated_at).getTime()) map[r.ticker] = r;
  }

  const out: Record<string, PriceRow> = {};
  for (const [t, r] of Object.entries(map)) {
    out[t] = {
      price: Number(r.price || 0),
      previous_close: Number(r.previous_close || 0),
      price_multiplier: Number(r.price_multiplier || 1) || 1,
      updated_at: r.updated_at,
    };
  }
  return out;
}
