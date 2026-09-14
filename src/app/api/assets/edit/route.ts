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
import { normalizeDomain, domainLogoUrl, isManualLogoOverride } from '@/lib/domain';

const patchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).nullable(),
  resolved_ticker: z.string().trim().min(1).nullable(),
  status: z.enum(['active', 'delisted', 'acquired', 'inactive', 'unknown']),
  delisted_at: z.string().nullable(),
  price_multiplier: z.number().finite().nullable(),
  // Raw user input (a bare hostname or a full URL) — normalised server-side
  // below via normalizeDomain, the same function automatic new-asset
  // enrichment uses (src/lib/newAssetDomainEnrichment.ts), so both paths
  // always produce the same on-disk representation. logo_url itself is
  // deliberately NOT accepted here — see the handler below for why.
  domain: z.string().trim().nullable(),
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

  // Domain handling: an empty/blank field clears assets.domain only — it
  // deliberately leaves logo_url untouched, so clearing the text box can
  // never destroy a working logo (automatic or manually set). A non-empty
  // value must normalise to a real-looking hostname (see src/lib/domain.ts)
  // or the whole request is rejected before any write happens.
  //
  // A saved domain always updates assets.domain. Whether it ALSO updates
  // logo_url depends on what's there right now: a 'manual:'-prefixed
  // logo_url is the highest-priority explicit user choice (see the CAKE
  // precedent) and is preserved unchanged even though the domain field
  // itself was just edited — editing the domain is not the same action as
  // explicitly replacing the logo override, and must never silently
  // destroy it. Any other existing value (null, or an existing
  // 'domain:...' marker) is safe to overwrite with the freshly normalised
  // domain, since it was never an explicit override in the first place.
  let domainPatch: { domain: string | null; logo_url?: string };
  if (patch.domain && patch.domain.trim()) {
    const normalized = normalizeDomain(patch.domain);
    if (!normalized) {
      return NextResponse.json(
        { error: `'${patch.domain}' doesn't look like a valid domain — try something like shopify.com` },
        { status: 400 }
      );
    }
    const { data: existing, error: readError } = await svc
      .from('assets')
      .select('logo_url')
      .eq('id', id)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

    domainPatch = isManualLogoOverride(existing.logo_url)
      ? { domain: normalized } // preserve the manual override untouched
      : { domain: normalized, logo_url: domainLogoUrl(normalized) };
  } else {
    domainPatch = { domain: null };
  }

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
      ...domainPatch,
    })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  return NextResponse.json({ ok: true, asset: data });
}
