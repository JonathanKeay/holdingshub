#!/usr/bin/env ts-node
// Ensure environment variables are loaded BEFORE we import any module that reads them.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Resolve environment variables (support both public & fallback names)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('❌ Environment variable NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) is missing.');
  console.error('   Add it to your .env file, e.g.');
  console.error('   NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co');
  process.exit(1);
}
if (!serviceKey) {
  console.error('❌ Environment variable SUPABASE_SERVICE_ROLE_KEY is missing.');
  console.error('   This key is required for privileged price upserts (DO NOT expose it client-side).');
  process.exit(1);
}

const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// Dynamically import after env is ensured so internal supabase client sees vars.
const { fetchAndCachePrices } = await import('../src/lib/prices.js');

(async () => {
  console.log('--- Audit Prices Start ---');
  const { data: holdingsTickersData, error: holdingsErr } = await client
    .from('holdings_view')
    .select('ticker');

  let tickers: string[] = [];
  if (holdingsErr || !holdingsTickersData) {
    console.warn('Fallback: holdings_view not present, using distinct tickers from transactions. Error:', holdingsErr);
    const { data: txTickers, error: txErr } = await client
      .from('transactions')
      .select('ticker');
    if (txErr) {
      console.error('Failed to fetch any tickers:', txErr);
      process.exit(1);
    }
    tickers = Array.from(new Set((txTickers || []).map((t: any) => t.ticker).filter(Boolean)));
  } else {
    tickers = Array.from(new Set((holdingsTickersData || []).map((r: any) => r.ticker).filter(Boolean)));
  }

  console.log(`Tickers derived: ${tickers.length}`);

  // Load assets for statuses
  const { data: assets, error: assetsErr } = await client
    .from('assets')
    .select('ticker,status,resolution_attempted_at');
  if (assetsErr) console.error('Assets load error', assetsErr);
  const statusMap: Record<string, { status: string | null; resolution_attempted_at: string | null }> = {};
  for (const a of assets || []) statusMap[a.ticker] = { status: a.status, resolution_attempted_at: a.resolution_attempted_at };

  // Load existing prices
  const { data: pricesRows, error: pricesErr } = await client.from('prices').select('ticker,updated_at');
  if (pricesErr) console.error('Prices load error', pricesErr);
  const priceMap: Record<string, string> = {};
  for (const p of pricesRows || []) priceMap[p.ticker] = p.updated_at;

  const staleCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  const missing: string[] = [];
  const stale: { ticker: string; updated_at: string }[] = [];
  for (const t of tickers) {
    const ts = priceMap[t];
    if (!ts) {
      missing.push(t);
    } else if (new Date(ts).getTime() < staleCutoff) {
      stale.push({ ticker: t, updated_at: ts });
    }
  }

  console.log('Missing price rows:', missing.slice(0, 25));
  if (missing.length > 25) console.log(`(+ ${missing.length - 25} more)`);
  console.log('Stale price rows (sample):', stale.slice(0, 15));

  // Attempt a refresh (dry-run like) using service client to surface logging
  console.log('Invoking fetchAndCachePrices to trigger updates (service role)...');
  try {
    await fetchAndCachePrices(tickers, undefined, client);
  } catch (err) {
    console.error('fetchAndCachePrices threw an error:', err);
  }
  console.log('Re-querying prices for a few tickers...');
  const sample = tickers.slice(0, 10);
  const { data: postPrices } = await client.from('prices').select('ticker,updated_at,price,previous_close').in('ticker', sample);
  console.table(postPrices);

  // Summaries by status
  const summary: Record<string, number> = {};
  for (const t of tickers) {
    const s = (statusMap[t]?.status || 'null').toLowerCase();
    summary[s] = (summary[s] || 0) + 1;
  }
  console.log('Status distribution among tracked tickers:', summary);

  console.log('--- Audit Prices Complete ---');
})();
