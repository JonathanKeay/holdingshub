import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchAndCachePrices } from '@/lib/prices';
import { revalidateTag } from 'next/cache';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers') || '';
  const tickers = tickersParam.split(',').map(s => s.trim()).filter(Boolean);
  if (tickers.length === 0) return NextResponse.json({ error: 'tickers required' }, { status: 400 });

  // Basic auth guard: require a user session (not exposing service role to anonymous)
  try {
    const { getSupabaseServerClient } = await import('@/lib/supabase-server');
    const supabaseUserClient = await getSupabaseServerClient();
    const { data: { session } } = await supabaseUserClient.auth.getSession();
    if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  } catch {
    return NextResponse.json({ error: 'auth check failed' }, { status: 500 });
  }

  // Use service role to read latest DB rows and revalidate caches
  const urlEnv = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!urlEnv || !svcKey) {
    return NextResponse.json({ error: 'service role not configured' }, { status: 500 });
  }
  const svc = createClient(urlEnv, svcKey);

  try {
    const result = await fetchAndCachePrices(tickers, undefined, svc);

    // Read back DB rows for confirmation
    const { data: dbRows } = await svc
      .from('prices')
      .select('ticker,price,previous_close,price_multiplier,updated_at')
      .in('ticker', tickers);

    // Invalidate prices cache tag so new values flow through immediately
    try { revalidateTag('prices'); } catch {}
    return NextResponse.json({ ok: true, tickers, result, db: dbRows || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
