import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const returnTo = searchParams.get('returnTo') || '/';
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type =
    (searchParams.get('type') as 'signup' | 'magiclink' | 'recovery' | 'invite' | 'email_change' | null) ??
    'magiclink';

  const redirect = NextResponse.redirect(new URL(returnTo, origin));
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: (name, value, options) => redirect.cookies.set({ name, value, ...options }),
        remove: (name, options) => redirect.cookies.set({ name, value: '', ...options, maxAge: 0 }),
      },
    }
  );

  try {
    if (token_hash) {
      const { error } = await supabase.auth.verifyOtp({ token_hash, type });
      if (error) throw error;
      return redirect;
    }

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return redirect;

      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('code verifier') || msg.includes('code_verifier') || msg.includes('both auth code')) {
        const { error: vErr } = await supabase.auth.verifyOtp({ token_hash: code, type });
        if (!vErr) return redirect;
        throw vErr;
      }
      throw error;
    }

    return NextResponse.redirect(new URL(`/login?error=missing_code`, origin));
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(e?.message || 'callback_failed')}`, origin)
    );
  }
}