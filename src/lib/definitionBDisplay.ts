// src/lib/definitionBDisplay.ts
//
// Pure, shared helpers for how PerPortfolioTable.tsx and TotalHoldingsTable.tsx
// fold a single holding's cost/realised figure into a base-currency
// aggregate. Used by both components so the rule lives in exactly one place.
//
// Rule: prefer the engine-provided base-currency field directly (never
// native × current-spot-FX) when the holding opted into Definition B
// (base_currency set) and the corresponding reliability flag is true. A
// holding that has not opted in (base_currency unset — e.g. a Global/blended
// holding whose contributing portfolios have mixed base currencies; every
// per-portfolio holding opts in) falls straight through to
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
// Generic "does this set of contributing base currencies resolve to one
// unambiguous currency" rule — a ticker blended across every portfolio (in
// getAllHoldingsAndCashSummary) may draw its realised figures AND/OR its
// open-cost (Definition B) ledger from portfolios that don't all share one
// base currency. Never guess: a single contributing currency resolves to
// that currency; none resolves to undefined (nothing to determine); more
// than one resolves to 'MIXED', explicitly, so callers can leave that
// ticker un-opted-in / unlabelled rather than picking one arbitrarily.
// ---------------------------------------------------------------------------
export function resolveUnambiguousBaseCurrency(contributingBaseCcys: Iterable<string>): string | 'MIXED' | undefined {
  const set = new Set(contributingBaseCcys);
  if (set.size === 0) return undefined;
  if (set.size === 1) return [...set][0];
  return 'MIXED';
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
  return resolveUnambiguousBaseCurrency(contributingBaseCcys);
}

// ---------------------------------------------------------------------------
// Definition B activation for a blended (cross-portfolio) ticker
// ---------------------------------------------------------------------------
// getAllHoldingsAndCashSummary blends one ticker's transactions across every
// portfolio. It may only opt a ticker into Definition B (set
// Holding.base_currency before replay) when every portfolio that ever fed
// it an open-cost-affecting transaction (BUY/SELL/TIN/TOT) shares one base
// currency. This is a pure function of the actual transaction data — never
// a hard-coded ticker list — so it is independently testable without a DB.

export type OpenCostContribution = { ticker: string; type: string; portfolioId: string };

/**
 * Resolves, per ticker, the single base currency it may safely be opted
 * into Definition B with — or undefined if no eligible activity exists, or
 * genuinely mixed (never a guess). `openCostAffectingTypes` should be the
 * exact set of transaction types that touch total_cost/base_total_cost
 * (BUY/SELL/TIN/TOT in the live engine); `portfolioBaseCcyById` maps each
 * contribution's portfolio to its base currency.
 */
export function resolveDefinitionBBaseCurrencies(
  contributions: Iterable<OpenCostContribution>,
  portfolioBaseCcyById: Record<string, string>,
  openCostAffectingTypes: ReadonlySet<string>
): Record<string, string | undefined> {
  const byTicker: Record<string, Set<string>> = {};
  for (const c of contributions) {
    if (!openCostAffectingTypes.has(c.type.toUpperCase())) continue;
    const baseCcy = portfolioBaseCcyById[c.portfolioId];
    if (!baseCcy) continue;
    if (!byTicker[c.ticker]) byTicker[c.ticker] = new Set();
    byTicker[c.ticker].add(baseCcy);
  }
  const result: Record<string, string | undefined> = {};
  for (const [ticker, ccys] of Object.entries(byTicker)) {
    const resolved = resolveUnambiguousBaseCurrency(ccys);
    result[ticker] = resolved === 'MIXED' ? undefined : resolved;
  }
  return result;
}

/** The currency a Holding's realised_value should be treated/labelled as, for display purposes. Falls back to the asset's own currency only when realised_ccy was never determined (no realised-affecting activity, or metadata unavailable) — the same fallback as today's pre-fix behaviour, so nothing regresses when realised_ccy is absent. */
export function resolveRealisedDisplayCcy(h: Pick<Holding, 'realised_ccy' | 'currency'>): string | 'MIXED' | undefined {
  return h.realised_ccy ?? h.currency;
}
