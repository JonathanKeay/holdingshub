import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';

export default async function DebugSession() {
  const cookieStore = cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return (
    <pre className="p-4 text-sm border rounded max-w-2xl mx-auto mt-6">
      {JSON.stringify({ loggedIn: !!session, user: session?.user?.email }, null, 2)}
    </pre>
  );
}