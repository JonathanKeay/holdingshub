import { NextResponse } from 'next/server';
import { fetchAndCacheLogosFromDomain, fetchAndCacheLogos, updateLogoUrlForTickersUsingFinnhub } from '@/lib/logo';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !svc) {
      return NextResponse.json({ success: false, error: 'Missing service role env' }, { status: 500 });
    }
    const client = createClient(url, svc);

    const u = new URL(req.url);
    const source = (u.searchParams.get('source') || 'domain').toLowerCase();
    const limit = Number(u.searchParams.get('limit') || 100);

    if (source === 'domain') {
      await fetchAndCacheLogosFromDomain(client);
      return NextResponse.json({ success: true, message: 'Domain marker update complete' });
    }

    if (source === 'finnhub') {
      const { data } = await client.from('assets').select('ticker').limit(limit);
      const tickers = (data || []).map((r: { ticker: string }) => r.ticker);
      await fetchAndCacheLogos(tickers, client);
      return NextResponse.json({ success: true, message: `Finnhub update started for ${tickers.length} tickers` });
    }

    if (source === 'logo-dev') {
      const { data } = await client.from('assets').select('ticker').limit(limit);
      const tickers = (data || []).map((r: { ticker: string }) => r.ticker);
      await updateLogoUrlForTickersUsingFinnhub(tickers, client);
      return NextResponse.json({ success: true, message: `Domains resolved for ${tickers.length} tickers` });
    }

    // Normalize existing Clearbit or Logo.dev URLs in assets.logo_url -> domain markers
    if (source === 'normalize') {
      let updated = 0;
      // 1) Clearbit -> domain:
      {
        const { data, error } = await client
          .from('assets')
          .select('id, logo_url')
          .ilike('logo_url', '%logo.clearbit.com/%')
          .limit(limit);
        if (error) return NextResponse.json({ success: false, error: String(error?.message || error) }, { status: 500 });
        for (const row of data || []) {
          const url: string = row.logo_url as unknown as string;
          const m = /^https?:\/\/logo\.clearbit\.com\/(.+)$/i.exec(url || '');
          if (!m || !m[1]) continue;
          const domain = m[1];
          const { error: upErr } = await client
            .from('assets')
            .update({ logo_url: `domain:${domain}` })
            .eq('id', row.id);
          if (!upErr) updated++; else console.error('Normalize failed (clearbit) for asset', row.id, upErr);
        }
      }

      // 2) img.logo.dev -> domain:
      {
        const { data, error } = await client
          .from('assets')
          .select('id, logo_url')
          .ilike('logo_url', '%img.logo.dev/%')
          .limit(limit);
        if (error) return NextResponse.json({ success: false, error: String(error?.message || error) }, { status: 500 });
        for (const row of data || []) {
          const url: string = row.logo_url as unknown as string;
          const m = /^https?:\/\/img\.logo\.dev\/(.+)$/i.exec(url || '');
          if (!m || !m[1]) continue;
          // Strip any query string that might have been in prior data
          const domainWithMaybeQuery = m[1];
          const domain = domainWithMaybeQuery.split('?')[0];
          const { error: upErr } = await client
            .from('assets')
            .update({ logo_url: `domain:${domain}` })
            .eq('id', row.id);
          if (!upErr) updated++; else console.error('Normalize failed (logo.dev) for asset', row.id, upErr);
        }
      }

      return NextResponse.json({ success: true, message: `Normalized ${updated} URLs to domain markers` });
    }

    return NextResponse.json({ success: false, error: 'Unknown source' }, { status: 400 });
  } catch (error) {
    console.error('Error updating logos:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
