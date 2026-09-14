// Controlled server-side mutation path for asset_aliases — shared reference
// data, same model as src/app/api/assets/edit/route.ts. `asset_aliases` maps
// a broker/source symbol (e.g. "CAKE.US") onto an existing canonical asset
// (e.g. "CAKE"); see supabase/migrations/20260914160000_create_asset_aliases.sql
// and src/lib/assetResolution.ts for why this exists and how it's used.
//
// Ordinary authenticated users have no direct INSERT/UPDATE/DELETE grant on
// asset_aliases (see that migration's RLS policy) — this route is the one
// controlled, validated, authenticated path for creating or removing an
// alias, used by src/app/assets/edit/page.tsx. It requires a session and
// validates input, then uses the service-role key internally to perform the
// write — never a direct browser write.
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';

function normalizeAlias(v: string): string {
  return v.toString().trim().toUpperCase();
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) return null;
  return createClient(url, svcKey);
}

const createSchema = z.object({
  asset_id: z.string().uuid(),
  alias: z.string().trim().min(1).transform(normalizeAlias),
});

export async function POST(req: Request) {
  const sessionClient = await getSupabaseServerClient();
  const {
    data: { session },
  } = await sessionClient.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const svc = serviceClient();
  if (!svc) return NextResponse.json({ error: 'Server misconfigured: missing SUPABASE env vars' }, { status: 500 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { asset_id, alias } = parsed.data;

  // Guard against a confusing/dangerous alias: never let an alias string
  // shadow a real canonical ticker or an existing resolved_ticker override
  // (resolveImportTicker already matches those FIRST, so an alias equal to
  // one would just be silently unreachable — reject it up front instead of
  // letting the user believe it does something it can't).
  const { data: collidingAsset } = await svc
    .from('assets')
    .select('id, ticker, resolved_ticker')
    .or(`ticker.eq.${alias},resolved_ticker.eq.${alias}`)
    .maybeSingle();
  if (collidingAsset) {
    return NextResponse.json(
      { error: `'${alias}' is already a canonical ticker or resolved_ticker (on asset ${collidingAsset.ticker}) — it would never be reached as an alias.` },
      { status: 409 }
    );
  }

  const { data: asset } = await svc.from('assets').select('id, ticker').eq('id', asset_id).maybeSingle();
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const { data, error } = await svc
    .from('asset_aliases')
    .insert({ alias, asset_id })
    .select('id, alias, asset_id')
    .single();

  if (error) {
    // Postgres unique_violation on asset_aliases_alias_key
    if ((error as { code?: string }).code === '23505') {
      const { data: existing } = await svc
        .from('asset_aliases')
        .select('asset_id, assets:asset_id(ticker)')
        .eq('alias', alias)
        .maybeSingle();
      const existingTicker = (existing as any)?.assets?.ticker;
      return NextResponse.json(
        {
          error: existingTicker
            ? `'${alias}' is already mapped to asset ${existingTicker}.`
            : `'${alias}' is already mapped to another asset.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, alias: data });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function DELETE(req: Request) {
  const sessionClient = await getSupabaseServerClient();
  const {
    data: { session },
  } = await sessionClient.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const svc = serviceClient();
  if (!svc) return NextResponse.json({ error: 'Server misconfigured: missing SUPABASE env vars' }, { status: 500 });

  const body = await req.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  }

  const { error } = await svc.from('asset_aliases').delete().eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
