import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol') || url.searchParams.get('ticker') || '';
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const token = process.env.FINNHUB_API_KEY || process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!token) return NextResponse.json({ error: 'missing finnhub api key' }, { status: 500 });

  try {
    const api = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(api, { cache: 'no-store' });
    const status = res.status;
    const ct = res.headers.get('content-type') || '';
  let bodyText = '';
  try { bodyText = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text(); } catch {}
  return NextResponse.json({ ok: res.ok, status, body: bodyText }, { status: res.ok ? 200 : 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'fetch failed';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
