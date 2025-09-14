import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type Prefs = { order: string[]; hidden: string[] };

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
  });
}

export async function PUT(req: Request) {
  const supabase = await getSupabaseServerClient();
  const body = (await req.json()) as Partial<Prefs>;
  const clean: Prefs = {
    order: Array.isArray(body.order) ? body.order : [],
    hidden: Array.isArray(body.hidden) ? body.hidden : [],
  };

  const { error } = await supabase
    .from('settings')
    .update({ portfolio_prefs: clean })
    .eq('id', 'global');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}