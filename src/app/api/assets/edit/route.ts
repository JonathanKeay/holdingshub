// Controlled server-side mutation path for shared asset/reference-data
// metadata (ticker corrections, delisting status, price multiplier, etc.).
//
// `assets` is shared reference data (see the RLS design notes) — the same
// row is correct for every user, so ordinary authenticated users do not get
// direct INSERT/UPDATE/DELETE grants on it (see
// 20260914100300_rls_shared_reference_data.sql). This route is the one
// controlled, validated, authenticated path for the app's one genuine
// end-user editing feature (manual asset metadata correction, used by
// src/app/assets/edit/page.tsx) — it requires a session and validates
// input, then uses the service-role key internally to perform the write.
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const patchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).nullable(),
  resolved_ticker: z.string().trim().min(1).nullable(),
  status: z.enum(['active', 'delisted', 'acquired', 'inactive', 'unknown']),
  delisted_at: z.string().nullable(),
  price_multiplier: z.number().finite().nullable(),
});

export async function PATCH(req: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) {
    return NextResponse.json({ error: 'Server misconfigured: missing SUPABASE env vars' }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { id, ...patch } = parsed.data;

  const svc = createClient(url, svcKey);
  const { data, error } = await svc
    .from('assets')
    .update({
      name: patch.name,
      resolved_ticker: patch.resolved_ticker,
      status: patch.status,
      delisted_at: patch.delisted_at,
      price_multiplier: patch.price_multiplier,
      last_failed_resolved_ticker: null,
      resolution_attempted_at: null,
    })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  return NextResponse.json({ ok: true, asset: data });
}
