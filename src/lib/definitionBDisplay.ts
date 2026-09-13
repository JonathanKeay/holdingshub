// src/lib/definitionBDisplay.ts
//
// Pure, shared helpers for how PerPortfolioTable.tsx and TotalHoldingsTable.tsx
// fold a single holding's cost/realised figure into a base-currency
// aggregate. Used by both components so the rule lives in exactly one place.
//
// Rule: prefer the engine-provided base-currency field directly (never
// native × current-spot-FX) when the holding opted into Definition B
// (base_currency set) and the corresponding reliability flag is true. A
// holding that never opted in (base_currency unset — true for every live
// holding while Definition B stays dormant) falls straight through to
// whatever legacy value the caller already computed, unchanged. A holding
// that opted in but isn't reliable contributes NOTHING (not zero) and is
// reported as making the aggregate incomplete — the caller must never treat
// `incomplete` as false or silently ignore it.

import type { Holding } from './queries';

export type AggregateContribution = {
  value: number;
  incomplete: boolean; // true = this holding's base figure is unavailable; `value` is 0 and must be excluded, not summed as a real zero
};

export function baseCostContribution(h: Holding, legacyValue: number): AggregateContribution {
  if (!h.base_currency) return { value: legacyValue, incomplete: false };
  if (h.base_cost_reliable && h.base_total_cost != null) {
    return { value: h.base_total_cost, incomplete: false };
  }
  return { value: 0, incomplete: true };
}

export function baseRealisedContribution(h: Holding, legacyValue: number): AggregateContribution {
  if (!h.base_currency) return { value: legacyValue, incomplete: false };
  if (h.base_realised_reliable && h.base_realised_value != null) {
    return { value: h.base_realised_value, incomplete: false };
  }
  return { value: 0, incomplete: true };
}

// ---------------------------------------------------------------------------
// realised_value currency-domain resolution (Holding.realised_ccy)
// ---------------------------------------------------------------------------
// realised_value's true currency is the contributing transaction's own
// portfolio base currency (proved by tracing applyTransactionToHolding's
// SELL branch — the cash-leg safeguard guarantees a SELL's proceeds, and
// hence its realised contribution, are denominated in that portfolio's base
// currency), never the asset's own currency. getAllHoldingsAndCashSummary
// blends a ticker across every portfolio, which may not share one base
// currency, so this must be resolved explicitly — never guessed from
// Holding.currency.

/** Given the set of base currencies that fed a ticker's realised figures across every contributing portfolio, resolves what single currency (if any) they're safely expressed in. */
export function resolveRealisedCcy(contributingBaseCcys: Iterable<string>): string | 'MIXED' | undefined {
  const set = new Set(contributingBaseCcys);
  if (set.size === 0) return undefined;
  if (set.size === 1) return [...set][0];
  return 'MIXED';
}

/** The currency a Holding's realised_value should be treated/labelled as, for display purposes. Falls back to the asset's own currency only when realised_ccy was never determined (no realised-affecting activity, or metadata unavailable) — the same fallback as today's pre-fix behaviour, so nothing regresses when realised_ccy is absent. */
export function resolveRealisedDisplayCcy(h: Pick<Holding, 'realised_ccy' | 'currency'>): string | 'MIXED' | undefined {
  return h.realised_ccy ?? h.currency;
}
