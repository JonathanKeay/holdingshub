import { NextResponse } from 'next/server';

function coerceTheme(v: string | null): 'light' | 'dark' | null {
  if (v === 'light' || v === 'dark') return v;
  return null;
}

function coerceIntParam(v: string | null, { min, max }: { min: number; max: number }): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function coerceBoolParam(v: string | null): boolean | null {
  if (v == null) return null;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function coerceFormat(v: string | null): 'png' | 'jpg' | 'webp' | null {
  if (v === 'png' || v === 'jpg' || v === 'webp') return v;
  return null;
}

function coerceFallback(v: string | null): '404' | null {
  if (v === '404') return '404';
  return null;
}

function isAllowedHost(u: URL) {
  const host = u.hostname.toLowerCase();
  return host === 'logo.clearbit.com' || host === 'img.logo.dev';
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = searchParams.get('domain');
    const token = process.env.LOGO_DEV_TOKEN;

     // Optional Logo.dev parameters
     const theme = coerceTheme(searchParams.get('theme'));
     const format = coerceFormat(searchParams.get('format'));
     const size = coerceIntParam(searchParams.get('size'), { min: 1, max: 800 });
     const retina = coerceBoolParam(searchParams.get('retina'));
     const fallback = coerceFallback(searchParams.get('fallback'));

    // Preferred: build a Logo.dev URL server-side so the token stays private
    if (domain && token) {
      const target = new URL(`https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(token)}`);
      if (theme) target.searchParams.set('theme', theme);
      if (format) target.searchParams.set('format', format);
      if (size != null) target.searchParams.set('size', String(size));
      if (retina != null) target.searchParams.set('retina', retina ? 'true' : 'false');
      if (fallback) target.searchParams.set('fallback', fallback);

      const resp = await fetch(target.toString(), { redirect: 'follow' });
      if (!resp.ok) {
        if (resp.status === 404) return new NextResponse(null, { status: 404 });
        return NextResponse.json({ ok: false, status: resp.status }, { status: 502 });
      }
      const contentType = resp.headers.get('content-type') || 'image/png';
      const body = await resp.arrayBuffer();
      return new NextResponse(body, {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'public, max-age=86400' },
      });
    }

    // Fallback: fetch a whitelisted URL directly (no token)
    const raw = searchParams.get('url');
    if (!raw) return NextResponse.json({ ok: false, error: 'Missing url or domain' }, { status: 400 });
    let target: URL;
    try { target = new URL(raw); } catch { return NextResponse.json({ ok: false, error: 'Invalid url' }, { status: 400 }); }
    if (!isAllowedHost(target)) return NextResponse.json({ ok: false, error: 'Host not allowed' }, { status: 403 });

    const resp = await fetch(target.toString(), { redirect: 'follow' });
    if (!resp.ok) return NextResponse.json({ ok: false, status: resp.status }, { status: 502 });
    const contentType = resp.headers.get('content-type') || 'image/png';
    const body = await resp.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': 'public, max-age=86400' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
