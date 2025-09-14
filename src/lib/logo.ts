import { supabase } from './supabase';

export async function fetchAndCacheLogosFromDomain() {
  const { data: assets, error } = await supabase
    .from('assets')
    .select('id, domain');

  if (error) {
    console.error('Error fetching assets:', error);
    return;
  }

  for (const asset of assets || []) {
    if (!asset.domain) continue;

    const logoUrl = `https://logo.clearbit.com/${asset.domain}`;
    const { error } = await supabase
      .from('assets')
      .update({ logo_url: logoUrl })
      .eq('id', asset.id);

    if (error) {
      console.error(`Failed to update logo for domain ${asset.domain}:`, error);
    }
  }
}
