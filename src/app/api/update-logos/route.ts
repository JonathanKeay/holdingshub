import { NextResponse } from 'next/server';
import { fetchAndCacheLogosFromDomain } from '@/lib/logo';

export async function GET() {
  try {
    await fetchAndCacheLogosFromDomain();
    return NextResponse.json({ success: true, message: 'Logos updated' });
  } catch (error) {
    console.error('Error updating logos:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
