'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { THEME_BLUE_TEXT } from '@/lib/uiColors';

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Import-style buttons
const BTN_BASE =
  'inline-flex items-center rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const BTN_MD = 'text-sm px-3.5 py-2';
const BTN_PRIMARY =
  'bg-themeblue text-white border border-themeblue-hover hover:bg-themeblue-hover shadow-sm focus-visible:ring-themeblue';
const BTN_GHOST =
  `${THEME_BLUE_TEXT} border border-themeblue-hover hover:bg-Thoverlight-tint focus-visible:ring-themeblue`;

const APP_ORIGIN =
  process.env.NEXT_PUBLIC_APP_ORIGIN ||
  (typeof window !== 'undefined' ? window.location.origin : '');

const ENABLE_GOOGLE = process.env.NEXT_PUBLIC_ENABLE_GOOGLE === 'true';

export default function LoginPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp.get('returnTo') || '/';
  const returnToSafe = returnTo || '/';

  const [email, setEmail] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [otp, setOtp] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);
  const [pastedLink, setPastedLink] = React.useState('');
  const [opening, setOpening] = React.useState(false);

  async function signInWithMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${APP_ORIGIN}/auth/callback?returnTo=${encodeURIComponent(returnToSafe)}`
      }
    });
    setSending(false);
    if (error) setError(error.message);
    else setMessage('Check your email for a login link (and code).');
  }

  async function verifyEmailCode(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    setMessage(null);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: otp.trim(),
        type: 'email', // 6-digit code from the email
      });
      if (error) setError(error.message);
      else {
        // logged in in this browser; go to returnTo
        router.replace(returnToSafe);
        return;
      }
    } finally {
      setVerifying(false);
    }
  }

  async function signInWithGoogle() {
    if (!ENABLE_GOOGLE) {
      setError('Google sign-in is disabled.');
      return;
    }
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${APP_ORIGIN}/auth/callback?returnTo=${encodeURIComponent(returnToSafe)}`,
        flowType: 'pkce',
      },
    });
    if (error) setError(error.message);
  }

  // Open a pasted magic link in THIS window/profile
  function openMagicLinkHere(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const raw = pastedLink.trim();
    if (!raw) return;
    setOpening(true);
    try {
      const u = new URL(raw);
      const sp = u.searchParams;
      // If Supabase included redirect_to to our callback, go there directly
      const redirectTo = sp.get('redirect_to');
      if (redirectTo) {
        window.location.href = redirectTo;
        return;
      }
      // If the URL already has code/token_hash, send to our callback
      if (sp.get('code') || sp.get('token_hash')) {
        const dest = new URL(`${APP_ORIGIN}/auth/callback`);
        const code = sp.get('code');
        const token_hash = sp.get('token_hash');
        const type = sp.get('type');
        if (code) dest.searchParams.set('code', code);
        if (token_hash) dest.searchParams.set('token_hash', token_hash);
        if (type) dest.searchParams.set('type', type);
        dest.searchParams.set('returnTo', returnToSafe);
        window.location.href = dest.toString();
        return;
      }
      // Otherwise, just navigate to the pasted link (Supabase will verify and bounce back)
      window.location.href = raw;
    } catch {
      // If parsing failed, still try navigating
      window.location.href = raw;
    } finally {
      setOpening(false);
    }
  }

  return (
    <main className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-md border rounded-md p-6 space-y-4">
        <h1 className={`${THEME_BLUE_TEXT} text-2xl font-bold`}>Sign in</h1>
        <p className="text-sm text-gray-500">
          Use a magic link{ENABLE_GOOGLE ? ' or sign in with Google' : ''}.
        </p>

        <form onSubmit={signInWithMagicLink} className="space-y-3">
          <label className="block text-sm">
            <span className={`${THEME_BLUE_TEXT} font-medium`}>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full border rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-themeblue"
              placeholder="you@example.com"
            />
          </label>

          <button
            type="submit"
            disabled={sending || !email}
            className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_MD} w-full justify-center`}
          >
            {sending ? 'Sending…' : 'Send magic link'}
          </button>
        </form>

        {/* Fallback: paste the link from the email to open it in this window */}
        <form onSubmit={openMagicLinkHere} className="space-y-3">
          <label className="block text-sm">
            <span className={`${THEME_BLUE_TEXT} font-medium`}>Have the email link?</span>
            <input
              type="url"
              value={pastedLink}
              onChange={(e) => setPastedLink(e.target.value)}
              className="mt-1 w-full border rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-themeblue"
              placeholder="Paste the login link from the email"
            />
          </label>
          <button
            type="submit"
            disabled={opening || !pastedLink.trim()}
            className={`${BTN_BASE} ${BTN_GHOST} ${BTN_MD} w-full justify-center`}
          >
            {opening ? 'Opening…' : 'Open link here'}
          </button>
          <p className="text-xs text-gray-500">
            If Outlook opens another browser, copy the link and paste it here to finish sign-in in this window.
          </p>
        </form>

        {/* Fallback code form can remain; your emails currently don’t include a code */}
        <form onSubmit={verifyEmailCode} className="space-y-3">
          <label className="block text-sm">
            <span className={`${THEME_BLUE_TEXT} font-medium`}>Have a code?</span>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="mt-1 w-full border rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-themeblue"
              placeholder="Enter 6-digit code from the email"
            />
          </label>
          <button
            type="submit"
            disabled={verifying || !email || !otp.trim()}
            className={`${BTN_BASE} ${BTN_GHOST} ${BTN_MD} w-full justify-center`}
          >
            {verifying ? 'Verifying…' : 'Verify code'}
          </button>
          <p className="text-xs text-gray-500">
            Tip: If the link opens in another browser, paste the code here to sign in in this window.
          </p>
        </form>

        {ENABLE_GOOGLE && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or</span>
              <div className="h-px flex-1 bg-gray-200" />
            </div>
            <button
              className={`${BTN_BASE} ${BTN_GHOST} ${BTN_MD} w-full justify-center`}
              onClick={signInWithGoogle}
            >
              Continue with Google
            </button>
          </>
        )}

        {message && <div className="text-sm text-green-600">{message}</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    </main>
  );
}
