'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const { error } = await supabaseBrowser.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${origin}/auth/callback` },
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
        <p>We’ve sent you a sign-in link.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-bold mb-4">Sign in</h1>
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
