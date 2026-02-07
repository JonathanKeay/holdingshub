import { NextResponse } from 'next/server';
import { getFinnhubStats } from '@/lib/prices';

export async function GET() {
  const fh = getFinnhubStats();
  const now = Date.now();
  const lastErrMs = fh.lastErrorAt ? Date.parse(fh.lastErrorAt) : 0;
  const recentError = lastErrMs && now - lastErrMs < 15 * 60 * 1000; // last 15m
  const rateLimited = fh.lastErrorCode === 429;
  const hasApiKey = !!(process.env.FINNHUB_API_KEY || process.env.NEXT_PUBLIC_FINNHUB_API_KEY);
  const missingKey = !hasApiKey;
  const dataUnavailable = fh.lastErrorCode === 204; // custom code we set for empty response
  return NextResponse.json({
    finnhub: {
      ...fh,
      recentError,
      rateLimited,
      missingKey,
      dataUnavailable,
      note: missingKey
        ? 'Finnhub API key missing on server'
        : rateLimited
        ? 'Finnhub rate-limit (HTTP 429) recently observed'
        : dataUnavailable
        ? 'Finnhub returned no usable data recently'
        : undefined,
    },
  });
}
