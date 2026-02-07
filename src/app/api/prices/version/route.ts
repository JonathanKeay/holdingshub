export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPricesVersion } from '@/lib/pricesVersion';
import { createClient } from '@supabase/supabase-js';

// Public, no-auth endpoint that returns the last known price version.
// The version is bumped by /api/prices/revalidate when the streamer writes.
export async function GET() {
  // Prefer the in-memory version bumped by /api/prices/revalidate
  let version = getPricesVersion();

  // Fallback: if version is null (e.g., app just booted), read latest from DB with service role
  if (!version) {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (url && key) {
        const supabase = createClient(url, key);
        const { data } = await supabase
          .from('prices')
          .select('updated_at')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        version = (data as { updated_at?: string | null } | null)?.updated_at || null;
      }
    } catch {
      // ignore; keep version as null
    }
  }

  return NextResponse.json(
    {
      version: version ?? null,
      now: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
