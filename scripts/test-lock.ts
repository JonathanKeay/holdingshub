import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, serviceRole);
  try {
    const { data: locked, error } = await supabase.rpc('try_lock_price_streamer');
    if (error) {
      console.error('try_lock_price_streamer error:', error);
      process.exit(2);
    }
    console.log('try_lock_price_streamer ->', locked);
    if (locked) {
      const { error: uerr } = await supabase.rpc('unlock_price_streamer');
      if (uerr) {
        console.error('unlock_price_streamer error:', uerr);
        process.exit(3);
      }
      console.log('unlock_price_streamer -> ok');
    }
  } catch (e) {
    console.error('RPC call failed:', e);
    process.exit(4);
  }
}

main();
