export const dynamic = 'force-dynamic';
export const revalidate = 0;

import Link from 'next/link';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import PortfolioLayoutClient from '@/components/PortfolioLayoutClient';
import { THEME_BLUE_TEXT } from '@/lib/uiColors';

// Button class tokens (same as in the client)
const BTN_BASE =
  'inline-flex items-center rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const BTN_MD = 'text-sm px-3.5 py-2';
const BTN_PRIMARY =
  'bg-themeblue text-white border border-themeblue-hover hover:bg-themeblue-hover shadow-sm focus-visible:ring-themeblue';

export default async function PortfolioLayoutSettings() {
  const supabase = await getSupabaseServerClient();
  const { data: portfolios = [] } = await supabase
    .from('portfolios')
    .select('id, name')
    .order('name', { ascending: true });

  return (
    <main className="p-6 max-w-3xl mx-auto">
      {/* Top nav removed per request */}
      <h1 className={`${THEME_BLUE_TEXT} text-2xl font-bold mb-2`}>Portfolio layout</h1>
      <p className="text-sm text-gray-500 mb-6">
        Reorder or hide portfolios. Your preferences are stored locally and applied on the dashboard.
      </p>

      <PortfolioLayoutClient portfolios={portfolios} />

      {/* Bottom nav */}
      <div className="mt-6 flex items-center gap-2">
        <Link href="/settings" className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_MD}`} aria-label="Back to Settings (bottom)">
          ← Back to Settings
        </Link>
        <Link href="/" className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_MD}`} aria-label="Go to Dashboard (bottom)">
          Go to Dashboard →
        </Link>
      </div>
    </main>
  );
}
