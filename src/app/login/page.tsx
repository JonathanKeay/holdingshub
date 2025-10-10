'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/browser';

function LoginPageInner() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const searchParams = useSearchParams();
  // Preserve intended destination if user was redirected by middleware
  const rawReturnTo = searchParams?.get('returnTo') || '/';
  const returnTo = rawReturnTo.startsWith('/') ? rawReturnTo : '/';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const emailRedirectTo = `${origin}/auth/callback?returnTo=${encodeURIComponent(returnTo)}`;
      const { error } = await supabaseBrowser.auth.signInWithOtp({
        email,
        options: { emailRedirectTo },
      });
      if (error) throw error;
      setSent(true);
    } catch (e: any) {
      setErr(e?.message ?? 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-sm p-6">
        <h1 className="text-xl font-semibold mb-3">Check your email</h1>
        <p>We’ve sent you a sign-in link. After clicking it you will be redirected to <code>{returnTo}</code>.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-bold mb-4">Sign in</h1>
      {returnTo !== '/' && (
        <p className="mb-2 text-sm text-gray-600">You will return to <code>{returnTo}</code> after signing in.</p>
      )}
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="text-sm">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            placeholder="you@example.com"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-black text-white py-2"
        >
          {loading ? 'Sending…' : 'Send magic link'}
        </button>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
