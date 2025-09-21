// app/auth/callback/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const returnTo = url.searchParams.get('returnTo') ?? '/';

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', url.origin));
  }

  const supabase = await createClient(); // <-- await
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin)
    );
  }

  return NextResponse.redirect(new URL(returnTo, url.origin));
}
