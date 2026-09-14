// src/lib/confirmTickerMetaResolution.ts
//
// Pure decision logic for the confirm-stage new-asset metadata step (see
// src/app/api/import-transactions/route.ts's confirm-stage resolvedMetas
// loop). Extracted so the fix below is directly testable without a live
// Yahoo call — see tests/import/confirm-ticker-meta-resolution.spec.ts.
//
// Root cause of the 2026-09-14 confirm-stage delay investigation: the
// confirm stage unconditionally re-ran the automatic Yahoo lookup
// (fetchTickerMeta) for every confirmed ticker, even when the client had
// already supplied a valid manual currency — which only ever happens after
// preview already told the user automatic lookup found nothing for that
// exact ticker (see needsManualCurrency in the preview stage). Per
// resolveNewAssetMeta's own precedence rule (auto wins only when it
// returns a currency), a fresh automatic lookup in that situation can
// never change the outcome — it either fails again (the common case,
// costing a real Yahoo network round-trip: ~90-150ms observed once the
// per-process crumb/cookie is warm, and up to ~1-2s cold) or it succeeds
// and is discarded anyway once the ticker is already resolvable via the
// manual currency the user was asked to and did provide.
//
// Fix: skip the automatic lookup entirely when the caller already has a
// valid manual currency for this ticker. This does NOT change precedence —
// automatic lookup is still always attempted, and still always preferred,
// in every case where it's actually consulted (manual currency absent or
// invalid). It only removes a call whose result could never have been used.

import {
  resolveNewAssetMeta,
  isValidCurrencyCode,
  type AutoTickerMeta,
  type ManualTickerMetadata,
  type ResolvedNewAssetMeta,
} from './manualAssetMetadata';

export async function resolveConfirmTickerMeta(
  ticker: string,
  manual: ManualTickerMetadata | undefined,
  fetchAuto: (ticker: string) => Promise<AutoTickerMeta>
): Promise<ResolvedNewAssetMeta> {
  if (isValidCurrencyCode(manual?.currency)) {
    // Manual currency is already usable on its own — automatic lookup's
    // result could never be preferred over it (resolveNewAssetMeta only
    // falls back to manual when auto has no currency) or needed as a
    // fallback (manual is already valid), so skip the network call.
    const noAutoLookup: AutoTickerMeta = { ticker, name: null, currency: null, price_multiplier: 1 };
    return resolveNewAssetMeta(noAutoLookup, manual);
  }

  const auto = await fetchAuto(ticker);
  return resolveNewAssetMeta(auto, manual);
}
