console.log('Using prices.ts with resolved_ticker support and Yahoo fallback + multiplier + sorting');

import { supabase } from './supabase';
import { fetchAndCacheLogosFromDomain } from './logo';

const TTL_MINUTES = 5;
const BATCH_SIZE = 10;

// 🔁 Get mapping of original ticker => { resolved, multiplier }
async function resolveTickersWithMultiplier(tickers: string[]) {
  const map: Record<string, { resolved: string; multiplier: number }> = {};
  const { data, error } = await supabase
    .from('assets')
    .select('ticker, resolved_ticker, price_multiplier')
    .in('ticker', tickers);

  if (error) {
    console.error('Error fetching asset info:', error);
    for (const t of tickers) map[t] = { resolved: t, multiplier: 1 };
    return map;
  }

  for (const asset of data ?? []) {
    map[asset.ticker] = {
      resolved: asset.resolved_ticker || asset.ticker,
      multiplier: asset.price_multiplier ?? 1,
    };
  }

  for (const ticker of tickers) {
    if (!map[ticker]) map[ticker] = { resolved: ticker, multiplier: 1 };
  }

  return map;
}

async function fetchYahooPrice(ticker: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const res = await fetch(url);

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      throw new Error(`Yahoo response not OK or not JSON: ${res.status}`);
    }

    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;

    return { price: typeof price === 'number' ? price : null, source: 'yahoo' };
  } catch (err) {
    console.error(`Yahoo fetch failed for ${ticker}:`, err);
    return { price: null, source: 'yahoo' };
  }
}

async function fetchPreviousClose(ticker: string) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    const res = await fetch(url);

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      throw new Error(`Yahoo response not OK or not JSON: ${res.status}`);
    }

    const json = await res.json();
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;

    if (Array.isArray(closes) && closes.length >= 2) {
      return closes[0];
    }

    return 0;
  } catch (err) {
    console.error(`Yahoo close fetch failed for ${ticker}:`, err);
    return 0;
  }
}

// 🧠 Main Function
export async function fetchAndCachePrices(
  allTickers: string[],
  tickerQuantities?: Record<string, number>
): Promise<Record<string, { price: number; previous_close: number; updated_at: string; price_multiplier: number }>> {
  const now = new Date();
  const freshThreshold = new Date(now.getTime() - TTL_MINUTES * 60 * 1000);

  const { data: activeAssets, error: assetErr } = await supabase
    .from('assets')
    .select('ticker')
    .in('ticker', allTickers)
    .or('status.is.null,status.eq.active');

  if (assetErr) {
    console.error('Error filtering active assets:', assetErr);
  }

  const tickers = (activeAssets ?? [])
    .map((a) => a.ticker)
    .filter((t) => (tickerQuantities?.[t] ?? 1) > 0);

  const { data: cached } = await supabase
    .from('prices')
    .select('*')
    .in('ticker', tickers);

  const freshPrices: Record<string, any> = {};
  const missingTickers: string[] = [];

  for (const ticker of tickers) {
    const row = cached?.find((p) => p.ticker === ticker);
    if (row && new Date(row.updated_at) > freshThreshold) {
      freshPrices[ticker] = {
        price: parseFloat(row.price),
        previous_close: parseFloat(row.previous_close),
        updated_at: row.updated_at,
        price_multiplier: parseFloat(row.price_multiplier ?? '1'),
      };
    } else {
      missingTickers.push(ticker);
    }
  }

  console.log(`✅ ${tickers.length - missingTickers.length} fresh prices cached, 🔍 ${missingTickers.length} need fetching`);

  const newPrices: Record<string, any> = {};

  for (let i = 0; i < missingTickers.length; i += BATCH_SIZE) {
    const batch = missingTickers.slice(i, i + BATCH_SIZE);
    console.log('Processing batch:', batch);

    const resolvedMap = await resolveTickersWithMultiplier(batch);
    await fetchAndCacheLogosFromDomain();

    const priceResults = await Promise.allSettled(
      batch.map((ticker) => fetchYahooPrice(resolvedMap[ticker].resolved))
    );
    const previousResults = await Promise.allSettled(
      batch.map((ticker) => fetchPreviousClose(resolvedMap[ticker].resolved))
    );

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const resolved = resolvedMap[ticker].resolved;
      const multiplier = resolvedMap[ticker].multiplier;
      const updated_at = new Date().toISOString();

      const price = priceResults[j].status === 'fulfilled' && priceResults[j].value.price != null
        ? priceResults[j].value.price
        : 0;

      if (price === 0) {
        console.warn(`⚠️ No price for ${ticker} (resolved = ${resolved})`);

        const { data: matchCandidates, error: matchErr } = await supabase
          .from('assets')
          .select('id, ticker, resolved_ticker, status')
          .or(`ticker.eq.${ticker},resolved_ticker.eq.${resolved}`);

        console.log(`🧪 Match candidates for ${ticker} (${resolved}):`, matchCandidates, matchErr);

        if (matchCandidates?.length) {
          const idsToUpdate = matchCandidates.map((a) => a.id);

          const { data: updated, error: updateErr } = await supabase
            .from('assets')
            .update({
              status: 'unknown',
              resolution_attempted_at: new Date().toISOString(),
              last_failed_resolved_ticker: resolved,
            })
            .in('id', idsToUpdate)
            .select();

          console.log('🧪 Update result:', updated, updateErr);
        } else {
          console.warn(`🚫 Asset not found for ${ticker} or ${resolved}`);
        }
      }

      const previous_close = previousResults[j].status === 'fulfilled'
        ? previousResults[j].value
        : 0;

      newPrices[ticker] = { price, previous_close, updated_at, price_multiplier: multiplier };

      await supabase.from('prices').upsert({
        ticker,
        price,
        previous_close,
        price_multiplier: multiplier,
        source: 'yahoo',
        updated_at,
      });

      await supabase.from('price_history').upsert({
        ticker,
        price,
        previous_close,
        price_multiplier: multiplier,
        source: 'yahoo',
        date: updated_at.slice(0, 10),
      });
    }

    if (i + BATCH_SIZE < missingTickers.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { ...freshPrices, ...newPrices };
}

export { resolveTickersWithMultiplier };
