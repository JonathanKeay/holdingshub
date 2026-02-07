import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function fetchYahooPrice(ticker: string): Promise<{ price: number; previous_close: number } | null> {
  try {
    const urlIntra = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=1d`;
    const r1 = await fetch(urlIntra);
    let lastIntra: number | null = null;
    if (r1.ok && (r1.headers.get('content-type') || '').includes('application/json')) {
      const j1 = await r1.json();
      const rr = j1?.chart?.result?.[0];
      const close = rr?.indicators?.quote?.[0]?.close as (number | null)[] | undefined;
      if (Array.isArray(close)) for (let i = close.length - 1; i >= 0; i--) { const v = close[i]; if (typeof v === 'number' && v > 0) { lastIntra = v; break; } }
    }
    const urlDaily = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
    const r2 = await fetch(urlDaily);
    if (!r2.ok) return null;
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) {
    console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const tickers = process.argv.slice(2);
  if (tickers.length === 0) {
    console.log('Usage: tsx scripts/upsert-price-from-yahoo.ts <SYMBOL...>');
    process.exit(0);
  }
  const client = createClient(url, svc);
  const nowIso = new Date().toISOString();
  for (const t of tickers) {
    const y = await fetchYahooPrice(t);
    if (!y || !(y.price > 0 || y.previous_close > 0)) {
      console.error(`Yahoo returned no price for ${t}`);
      continue;
    }
    // multiplier from assets
    const { data: asset } = await client.from('assets').select('price_multiplier').eq('ticker', t).maybeSingle();
    const price_multiplier = Number(asset?.price_multiplier || 1) || 1;
    const price = Number(y.price.toFixed(6));
    const previous_close = Number((y.previous_close || 0).toFixed(6));
    await client.from('prices').upsert({ ticker: t, price, previous_close, price_multiplier, updated_at: nowIso, source: 'yahoo:manual' }, { onConflict: 'ticker' });
    await client.from('price_history').upsert({ ticker: t, date: nowIso.slice(0,10), price, price_multiplier, source: 'yahoo:manual' }, { onConflict: 'ticker,date' });
    console.log(`Upserted ${t} => ${price}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
