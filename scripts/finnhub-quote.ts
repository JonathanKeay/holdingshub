import 'dotenv/config';

async function fetchQuote(symbol: string, token: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${symbol} HTTP ${r.status}`);
  const j = await r.json();
  return j;
}

async function main() {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    console.error('Missing FINNHUB_API_KEY in env');
    process.exit(1);
  }
  const symbols = process.argv.slice(2);
  if (symbols.length === 0) {
    console.log('Usage: tsx scripts/finnhub-quote.ts <SYMBOL...>');
    console.log('Example: tsx scripts/finnhub-quote.ts AMD AAPL MSFT');
    process.exit(0);
  }
  const now = new Date().toISOString();
  for (const s of symbols) {
    try {
      const q = await fetchQuote(s, token);
      const { c, pc, h, l, o, dp, d, t } = q || {};
      const obj = { now, symbol: s, c, pc, h, l, o, dp, d, quote_ts: t ? new Date(t * 1000).toISOString() : null };
      console.log(JSON.stringify(obj));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error fetching ${s}:`, msg);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
