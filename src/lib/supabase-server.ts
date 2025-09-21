// src/lib/supabase-server.ts
import { createClient } from './supabase/server';

export async function getSupabaseServerClient() {
  return await createClient();
}
