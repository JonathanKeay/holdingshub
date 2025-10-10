// app/tools/cash-balance/page.tsx
import { getSupabaseServerClient } from '@/lib/supabase-server';
import CashBalanceToolPageClient from './CashBalanceToolPageClient';
import { Suspense } from 'react';

export default async function CashBalanceToolPage() {
  const supabase = await getSupabaseServerClient();

  const { data: portfolios, error } = await supabase
    .from('portfolios')
    .select('id, name, base_currency')
    .order('name');

  if (error) {
    console.error('Error loading portfolios:', error.message);
    return (
      <main className="p-6 max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold mb-4">Cash Balance Adjustment</h1>
        <div className="p-3 rounded bg-red-50 border border-red-200">
          Failed to load portfolios: {error.message}
        </div>
      </main>
    );
  }

  return (
    <Suspense fallback={null}>
      <CashBalanceToolPageClient portfolios={portfolios || []} />
    </Suspense>
  );
}