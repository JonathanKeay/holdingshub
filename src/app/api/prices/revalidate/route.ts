import { revalidateTag } from 'next/cache';
import { bumpPricesVersion } from '@/lib/pricesVersion';

export async function POST(request: Request) {
  const secret = process.env.PRICES_REVALIDATE_SECRET;
  const provided = request.headers.get('x-revalidate-secret');
  if (!secret || !provided || provided !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    revalidateTag('prices');
    const version = bumpPricesVersion();
    // lightweight log for observability (no secrets)
    console.info('[revalidate] prices tag invalidated; version=', version);
    return Response.json({ ok: true, version });
  } catch {
    return new Response('Error', { status: 500 });
  }
}
