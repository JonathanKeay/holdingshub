import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Public paths (no auth required)
const PUBLIC_PATHS = new Set([
  '/login',
  '/auth/callback',
  '/debug/session', // temporary while debugging
  '/favicon.ico',
  '/robots.txt',
]);

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // static assets
  if (pathname.startsWith('/_next') || pathname.startsWith('/assets')) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (isPublicPath(pathname)) return NextResponse.next();

  // If a magic link landed on a protected route (e.g., "/?code=..."),
  // send it to /auth/callback and preserve returnTo.
  const sp = req.nextUrl.searchParams;
  if (sp.has('code') || sp.has('token_hash')) {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/callback';

    const newSp = new URLSearchParams();
    if (sp.has('code')) newSp.set('code', sp.get('code')!);
    if (sp.has('token_hash')) newSp.set('token_hash', sp.get('token_hash')!);
    if (sp.has('type')) newSp.set('type', sp.get('type')!);

    // returnTo = original path without auth params
    const original = req.nextUrl.clone();
    original.searchParams.delete('code');
    original.searchParams.delete('token_hash');
    original.searchParams.delete('type');
    const returnTo =
      original.pathname +
      (original.searchParams.toString() ? `?${original.searchParams.toString()}` : '');
    newSp.set('returnTo', returnTo || '/');

    url.search = newSp.toString();
    return NextResponse.redirect(url);
  }

  // Simple auth gate: check for Supabase auth cookies (no network call)
  const hasAccess = Boolean(
    req.cookies.get('sb-access-token') || req.cookies.get('sb-refresh-token')
  );

  if (!hasAccess) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('returnTo', pathname + (req.nextUrl.search || ''));
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Run on everything except static files
export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
};
