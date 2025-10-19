export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { redirect } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export default async function MobilePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect('/login');
  }

  return (
    <main className="p-4 max-w-md mx-auto">
      <h1 className="text-xl font-semibold mb-4">Mobile Dashboard</h1>
      <p className="text-sm text-gray-600">
        This is a placeholder for the phone-friendly view. Build your compact holdings summary and quick actions here.
      </p>
      {/* TODO: Implement a simplified, vertically-stacked layout optimised for small screens. */}
    </main>
  );
}
