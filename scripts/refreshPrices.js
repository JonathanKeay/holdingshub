import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchAndCachePrices } from '../src/lib/prices.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function refreshAllAssetTickers() {
  const { data: assets, error } = await supabase.from('assets').select('ticker');
  if (error || !assets) {
    console.error('❌ Failed to load assets:', error);
    return;
  }

  const tickers = assets.map((a) => a.ticker).filter(Boolean);
  if (tickers.length === 0) {
    console.warn('⚠️ No tickers found.');
    return;
  }

  console.log(`🔄 Refreshing ${tickers.length} tickers...`);
  // Pass the service-role client explicitly so upserts use elevated privileges
  const prices = await fetchAndCachePrices(tickers, undefined, supabase);
  console.log('✅ Done. Prices:', prices);
}

refreshAllAssetTickers();
