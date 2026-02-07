import 'dotenv/config';
import WebSocket from 'ws';

type TradeMsg = { type: 'trade'; data: Array<{ s: string; p: number; t: number; v?: number; c?: string[] }> };

function iso(tsMs: number) { return new Date(tsMs).toISOString(); }

async function main() {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    console.error('Missing FINNHUB_API_KEY in env');
    process.exit(1);
  }
  const symbols = process.argv.slice(2);
  const subs = symbols.length ? symbols : ['AMD'];
  console.log(`Connecting to Finnhub WS. Subscribing: ${subs.join(', ')}`);
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${token}`);

  ws.on('open', () => {
    let i = 0;
    for (const s of subs) {
      setTimeout(() => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })), i * 10);
      i++;
    }
  });

  ws.on('message', (buf) => {
    try {
      const base = JSON.parse(String(buf)) as TradeMsg | { type: string };
      if (base && base.type === 'trade') {
        const m = base as TradeMsg;
        for (const d of m.data) {
          const now = Date.now();
          const ageMs = now - Number(d.t || 0);
          const flag = ageMs > 60_000 ? 'STALE' : 'LIVE';
          console.log(JSON.stringify({
            at: iso(now), symbol: d.s, price: d.p, trade_ts: iso(d.t), age_ms: ageMs, flag, volume: d.v ?? null, conditions: d.c ?? null,
          }));
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('error', (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('WS error:', msg);
  });

  ws.on('close', () => {
    console.error('WS closed');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
