// src/lib/cashLeg.ts
//
// Shared, pure decision logic for turning a BUY/SELL's native-currency
// settlement amount into a portfolio-base-currency cash leg (cash_value /
// cash_ccy / cash_fx_to_portfolio).
//
// The rule this encodes: when the asset's currency differs from the
// portfolio's base currency, NEVER silently relabel the native settlement
// amount as if it were already in base currency. Only produce a base-currency
// cash_value when one of these is genuinely available:
//   1. An explicit cash_value was supplied (by the user or the import file),
//      already understood to be in the portfolio's base currency.
//   2. An explicit FX rate was supplied (e.g. a broker-reported rate on the
//      import row), used to convert the native settlement amount.
//   3. A cached local spot rate exists for the trade date (src/lib/fx.ts's
//      fx_rates table), used the same way.
// If none of those are available, the transaction is BLOCKED rather than
// given a fabricated 1:1 "conversion". This module makes no external network
// calls and never invents a rate.
//
// Same-currency transactions (asset ccy === portfolio base ccy) are always a
// trivial no-FX case — this module deliberately does not touch that path's
// existing numeric behaviour.

export type CashLegSource =
  | 'same-currency'
  | 'explicit-cash-value'
  | 'explicit-fx-rate'
  | 'cached-fx-rate';

export type CashLegOutcome =
  | {
      status: 'ok';
      cash_value: number;
      cash_ccy: string;
      cash_fx_to_portfolio: number;
      source: CashLegSource;
    }
  | {
      status: 'blocked';
      reason: string;
    };

export type ResolveCashLegInput = {
  /** The security's own (settlement) currency, e.g. 'USD'. */
  assetCcy: string | null | undefined;
  /** The portfolio's base currency, e.g. 'GBP'. */
  baseCcy: string | null | undefined;
  /** abs(quantity * price + fee), in assetCcy. */
  settleAbs: number;
  /** An explicit cash amount already understood to be in baseCcy, if supplied. */
  explicitCashValue?: number | null;
  /** An explicit assetCcy -> baseCcy rate, if supplied (e.g. a CSV fxrate column). */
  explicitFxRate?: number | null;
  /** A rate derived from the local fx_rates cache for the trade date, if available. */
  cachedRateAssetToBase?: number | null;
};

function isPositiveFinite(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

export function resolveCashLeg(input: ResolveCashLegInput): CashLegOutcome {
  const assetCcy = (input.assetCcy || '').toUpperCase();
  const baseCcy = (input.baseCcy || '').toUpperCase();

  if (!assetCcy || !baseCcy) {
    return { status: 'blocked', reason: 'Asset or portfolio base currency is unknown.' };
  }
  if (!isPositiveFinite(input.settleAbs)) {
    return { status: 'blocked', reason: 'No settlement amount to derive a cash leg from.' };
  }

  // Same currency: no FX involved at all. Preserve current behaviour exactly.
  if (assetCcy === baseCcy) {
    return { status: 'ok', cash_value: input.settleAbs, cash_ccy: baseCcy, cash_fx_to_portfolio: 1, source: 'same-currency' };
  }

  // 1. An explicit base-currency cash amount was supplied — trust it as-is.
  if (isPositiveFinite(input.explicitCashValue)) {
    const cashValue = input.explicitCashValue;
    return {
      status: 'ok',
      cash_value: cashValue,
      cash_ccy: baseCcy,
      cash_fx_to_portfolio: cashValue / input.settleAbs,
      source: 'explicit-cash-value',
    };
  }

  // 2. An explicit FX rate was supplied — derive the base amount from it.
  if (isPositiveFinite(input.explicitFxRate)) {
    const rate = input.explicitFxRate;
    return {
      status: 'ok',
      cash_value: input.settleAbs * rate,
      cash_ccy: baseCcy,
      cash_fx_to_portfolio: rate,
      source: 'explicit-fx-rate',
    };
  }

  // 3. A cached local spot rate exists for the trade date — derive from it.
  if (isPositiveFinite(input.cachedRateAssetToBase)) {
    const rate = input.cachedRateAssetToBase;
    return {
      status: 'ok',
      cash_value: input.settleAbs * rate,
      cash_ccy: baseCcy,
      cash_fx_to_portfolio: rate,
      source: 'cached-fx-rate',
    };
  }

  // Nothing reliable is available. Refuse to fabricate a conversion.
  return {
    status: 'blocked',
    reason: `No reliable ${assetCcy}->${baseCcy} conversion is available for this transaction ` +
      `(no explicit cash value, no FX rate, and no cached rate for the trade date).`,
  };
}

/**
 * Derive an assetCcy -> baseCcy multiplier from a day's cached fx_rates quotes
 * (shape: { GBPUSD: 1.29, GBPEUR: 1.17, ... }, i.e. GBP-per-unit-foreign is
 * inverted — these keys are literally "1 GBP buys this many of X"). Pure and
 * synchronous: callers fetch the quotes row once (for one or many dates) and
 * pass it in here. Mirrors the FX-cache math that already existed, unused, in
 * the old computeCashLeg() helper in src/app/transactions/page.tsx.
 */
export function deriveAssetToBaseRate(
  quotes: Record<string, number> | null | undefined,
  assetCcy: string | null | undefined,
  baseCcy: string | null | undefined
): number | null {
  const asset = (assetCcy || '').toUpperCase();
  const base = (baseCcy || '').toUpperCase();
  if (!quotes || !asset || !base) return null;
  if (asset === base) return 1;

  const gbpToAsset = quotes['GBP' + asset];
  const gbpToBase = quotes['GBP' + base];

  let rate: number | null = null;
  if (asset === 'GBP' && typeof gbpToBase === 'number') {
    rate = gbpToBase; // GBP -> base
  } else if (base === 'GBP' && typeof gbpToAsset === 'number') {
    rate = 1 / gbpToAsset; // asset -> GBP
  } else if (typeof gbpToAsset === 'number' && typeof gbpToBase === 'number') {
    rate = (1 / gbpToAsset) * gbpToBase; // asset -> GBP -> base
  }

  if (!isPositiveFinite(rate)) return null;
  return rate;
}

// ---------------------------------------------------------------------------
// Row-level wiring shared by every importer/UI call site that needs a cash
// leg resolved from CSV-shaped inputs (an explicit cash value, an explicit
// FX rate, and a same-day fx_rates cache row). Kept here — not duplicated at
// each call site — so BUY/SELL and every other cash-moving transaction type
// go through the exact same trust order and blocking rule. See the
// SAP.DE DIV / ETRO DEP investigation for why this was extended beyond
// BUY/SELL.
// ---------------------------------------------------------------------------

/**
 * Transaction types that are ALWAYS a genuine cash movement in the resolved
 * asset's own currency (a dividend, interest payment, deposit, withdrawal,
 * fee, or generic cash event such as withholding tax) — exactly the same FX
 * risk as a BUY/SELL settlement leg. TIN/TOT are handled separately by
 * shouldApplyCashLegGate below: only a CASH.*-ticker TIN/TOT (a real
 * cross-portfolio cash transfer) gets this treatment. An ordinary security
 * TIN/TOT is an in-kind transfer whose cash_value/cash_ccy are never read by
 * any downstream calculation (cost comes from settle_value), so gating it on
 * FX availability would silently drop legitimate transfers for no benefit.
 *
 * FXM (Foreign Exchange Movement) is DELIBERATELY NOT in this set. FXM's
 * cash_value already IS the final, signed, portfolio-base-currency amount —
 * there is no native-currency settlement leg to convert. Routing it through
 * this gate would be wrong twice over: resolveCashLeg's same-currency branch
 * (asset ccy === base ccy, which is exactly FXM's CASH.* case) returns
 * Math.abs(settleAbs), discarding the sign entirely, and a realised FX LOSS
 * must stay negative. Do not add FXM here.
 */
export const CASH_LEG_TRANSACTION_TYPES: ReadonlySet<string> = new Set([
  'DIV', 'INT', 'DEP', 'WIT', 'FEE', 'OTR',
]);

/**
 * Decide whether a transaction row of this type should go through the
 * FX-safe cash-leg gate (resolveRowCashLeg) at all, given whether its own
 * asset is a CASH.* pseudo-ticker (a real cash-transfer TIN/TOT) or not.
 */
export function shouldApplyCashLegGate(type: string, isCashAssetTicker: boolean): boolean {
  return (
    type === 'BUY' ||
    type === 'SELL' ||
    CASH_LEG_TRANSACTION_TYPES.has(type) ||
    ((type === 'TIN' || type === 'TOT') && isCashAssetTicker)
  );
}

/**
 * Resolve a row's cash leg from CSV-shaped inputs: an explicit cash value
 * (already understood to be in baseCcy), an explicit FX rate, and the
 * same-day fx_rates cache quotes (if any). This is the single place that
 * derives cachedRateAssetToBase and calls resolveCashLeg — reused by every
 * cash-moving transaction type so none of them can drift into a subtly
 * different FX implementation.
 */
export function resolveRowCashLeg(
  assetCcy: string | null | undefined,
  baseCcy: string | null | undefined,
  settleAbs: number,
  explicitCashValue: number | null,
  explicitFxRate: number | null,
  quotesForDate: Record<string, number> | undefined
): CashLegOutcome {
  // Only attempt the cache when there's no USABLE explicit rate — a CSV
  // fxrate of 0 (this fix's whole trigger case: the eToro CAKE/SAP.DE rows)
  // is exactly as "missing" as a blank one for this purpose. Checking
  // `explicitFxRate == null` alone would skip the cache fallback whenever
  // the CSV wrote a literal 0, forcing an unnecessary block even when a
  // cached rate was available.
  const hasUsableExplicitFxRate = typeof explicitFxRate === 'number' && isFinite(explicitFxRate) && explicitFxRate > 0;
  const cachedRateAssetToBase =
    explicitCashValue == null && !hasUsableExplicitFxRate
      ? deriveAssetToBaseRate(quotesForDate, assetCcy, baseCcy)
      : null;

  return resolveCashLeg({
    assetCcy,
    baseCcy,
    settleAbs,
    explicitCashValue,
    explicitFxRate,
    cachedRateAssetToBase,
  });
}

/**
 * Resolve cash_value for a row whose type does NOT go through the cash-leg
 * gate above (shouldApplyCashLegGate returned false) — currently: an
 * ordinary-security TIN/TOT, and FXM. Trusts an explicit CSV cash_value
 * exactly as supplied (sign and magnitude both preserved — no Math.abs, no
 * currency conversion, no cash-leg blocking), falling back to
 * quantity*price+fee only when no explicit value was supplied at all.
 *
 * This is the ONLY correct path for FXM: FXM's cash_value already IS the
 * final, signed, portfolio-base-currency amount, so it must pass through
 * completely unchanged (see the note on CASH_LEG_TRANSACTION_TYPES above for
 * why FXM must never be routed through resolveRowCashLeg instead).
 */
export function resolveUngatedCashValue(
  explicitCashValue: number | null,
  quantity: number,
  price: number,
  fee: number
): number {
  return explicitCashValue != null ? explicitCashValue : (quantity * price + fee);
}
