import { NextResponse } from 'next/server';

function isAllowedHost(u: URL) {
  const host = u.hostname.toLowerCase();
  return host === 'logo.clearbit.com' || host === 'img.logo.dev';
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = searchParams.get('domain');
    const token = process.env.LOGO_DEV_TOKEN;

    // Preferred: build a Logo.dev URL server-side so the token stays private
    if (domain && token) {
      const target = new URL(`https://img.logo.dev/${encodeURIComponent(domain)}?token=${encodeURIComponent(token)}`);
      const resp = await fetch(target.toString(), { redirect: 'follow' });
      if (!resp.ok) return NextResponse.json({ ok: false, status: resp.status }, { status: 502 });
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
