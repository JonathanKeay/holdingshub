// src/lib/supabase-server.ts
import { cookies } from 'next/headers';
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import type { Database } from '@/types/supabase'; // optional if using Supabase typegen

export async function getSupabaseServerClient() {
  const cookieStore = await cookies(); // ✅ now async
  return createServerComponentClient<Database>({ cookies: () => cookieStore });
}
