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
  const { data, error } = await supabase
    .from('settings')
    .select('portfolio_prefs')
    .eq('id', 'global')
    .single();

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
  const body = (await req.json()) as Partial<Prefs>;

  const { data, error: readError } = await supabase
    .from('settings')
    .select('portfolio_prefs')
    .eq('id', 'global')
    .single();

  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  const existing = ((data?.portfolio_prefs ?? {}) as Partial<Prefs>) || {};
  const next: Prefs = {
    order: Array.isArray(body.order) ? body.order : (Array.isArray(existing.order) ? existing.order : []),
    hidden: Array.isArray(body.hidden) ? body.hidden : (Array.isArray(existing.hidden) ? existing.hidden : []),
    theme: coerceTheme((body as any).theme) ?? coerceTheme((existing as any).theme) ?? 'system',
  };

  const { error } = await supabase
    .from('settings')
    .update({ portfolio_prefs: { ...(existing as any), ...next } })
    .eq('id', 'global');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}