import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function fetchQuote(symbol: string, token: string): Promise<{ c: number; pc?: number } | null> {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const c = Number(j?.c || 0);
    const pc = Number(j?.pc || 0) || undefined;
    if (!Number.isFinite(c) || c <= 0) return null;
    return { c, pc };
  } catch {
    return null;
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.FINNHUB_API_KEY;
  if (!url || !svc || !token) {
    console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FINNHUB_API_KEY');
    process.exit(1);
  }
  const tickers = process.argv.slice(2);
  if (tickers.length === 0) {
    console.log('Usage: tsx scripts/upsert-price-from-finnhub.ts <SYMBOL...>');
    process.exit(0);
  }
  const client = createClient(url, svc);
  const nowIso = new Date().toISOString();
  for (const t of tickers) {
    const q = await fetchQuote(t, token);
    if (!q) {
      console.error(`No quote for ${t}`);
      continue;
    }
    const price = Number(q.c.toFixed(6));
    const { data: asset } = await client.from('assets').select('price_multiplier').eq('ticker', t).maybeSingle();
    const price_multiplier = Number(asset?.price_multiplier || 1) || 1;
  const previous_close = q.pc && Number.isFinite(q.pc) && q.pc > 0 ? Number((q.pc as number).toFixed(6)) : 0;
    await client.from('prices').upsert({ ticker: t, price, previous_close, price_multiplier, updated_at: nowIso, source: 'finnhub:manual' }, { onConflict: 'ticker' });
    await client.from('price_history').upsert({ ticker: t, date: nowIso.slice(0,10), price, price_multiplier, source: 'finnhub:manual' }, { onConflict: 'ticker,date' });
    console.log(`Upserted ${t} => ${price}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
