import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type ThemePref = 'system' | 'light' | 'dark';
type Prefs = { order: string[]; hidden: string[]; theme?: ThemePref };

function coerceTheme(v: unknown): ThemePref | null {
  if (v === 'system' || v === 'light' || v === 'dark') return v;
  return null;
}

export async function GET() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // RLS already restricts this to the caller's own row; maybeSingle() (not
  // single()) because a brand-new user legitimately has no row yet.
  const { data, error } = await supabase
    .from('settings')
    .select('portfolio_prefs')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const prefs = (data?.portfolio_prefs ?? {}) as Partial<Prefs>;
  return NextResponse.json({
    order: Array.isArray(prefs.order) ? prefs.order : [],
    hidden: Array.isArray(prefs.hidden) ? prefs.hidden : [],
    theme: coerceTheme((prefs as any).theme) ?? 'system',
  });
}

export async function PUT(req: Request) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as Partial<Prefs>;

  const { data, error: readError } = await supabase
    .from('settings')
    .select('portfolio_prefs')
    .maybeSingle();

  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  const existing = ((data?.portfolio_prefs ?? {}) as Partial<Prefs>) || {};
  const next: Prefs = {
    order: Array.isArray(body.order) ? body.order : (Array.isArray(existing.order) ? existing.order : []),
    hidden: Array.isArray(body.hidden) ? body.hidden : (Array.isArray(existing.hidden) ? existing.hidden : []),
    theme: coerceTheme((body as any).theme) ?? coerceTheme((existing as any).theme) ?? 'system',
  };

  // Upsert (not update) — a brand-new user has no settings row yet, so the
  // first preference change must create one, scoped to their own user_id.
  const { error } = await supabase
    .from('settings')
    .upsert(
      { user_id: session.user.id, portfolio_prefs: { ...(existing as any), ...next } },
      { onConflict: 'user_id' }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}