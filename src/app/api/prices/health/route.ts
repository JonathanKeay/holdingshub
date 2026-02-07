import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@/lib/supabase/server';

export async function GET() {
  try {
    // Use server client with anon key; health is coarse and RLS should allow read
    const supabase = await createServiceClient();
    const since = new Date(Date.now() - 10 * 60_000).toISOString(); // last 10 minutes

    const { data: recentPrices } = await supabase
      .from('prices')
      .select('ticker, updated_at, source')
      .gte('updated_at', since)
      .limit(1000);

    type PriceRow = { ticker: string; updated_at: string; source: string | null };
    const bySource: Record<string, number> = {};
    let latestUpdate = 0;
    for (const r of (recentPrices as PriceRow[] | null) || []) {
      const s = r.source || 'unknown';
      bySource[s] = (bySource[s] || 0) + 1;
      latestUpdate = Math.max(latestUpdate, new Date(r.updated_at).getTime());
    }

    return NextResponse.json({
      ok: true,
      windowMinutes: 10,
      counts: bySource,
      latestUpdateAt: latestUpdate ? new Date(latestUpdate).toISOString() : null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
