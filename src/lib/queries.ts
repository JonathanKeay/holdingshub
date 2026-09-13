/* Clear currency handling: no legacy gbp_value in any calculations.
   - Positions are maintained in the ASSET currency.
   - Realised P/L is computed in the SELL row's cash currency (or asset ccy if no cash leg),
     converting the asset-cost into the cash currency using SELL's implied FX when present.
   - TIN books cost in asset currency via settle_value (preferred), or same-ccy cash_value, or price*qty(+fee).
*/

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Portfolio } from '@/types/supabase';

// ----------------------------- Types -----------------------------

export type Holding = {
  asset_id: string;
  ticker: string;
  company_name?: string; // Optional UI label
  total_shares: number;
  avg_price: number;
  total_cost: number;           // asset currency
  currency?: string;            // asset currency (ISO)
  logo_url?: string;
  status?: string;
  realised_value?: number;      // realised P/L in the proceeds (cash) currency domain
  realised_cost?: number;
  realised_proceeds?: number;

  // ---- Definition B: parallel portfolio-base weighted-average cost ledger ----
  // All fields below are OPTIONAL and additive: a Holding that never sets
  // base_currency is completely unaffected by applyTransactionToHolding's
  // Definition B logic — every field and code path above this point behaves
  // exactly as it did before this feature existed. A caller opts in by
  // setting base_currency to the owning portfolio's base currency.
  base_currency?: string;        // portfolio's base currency (e.g. 'GBP'), set by the caller to opt in
  base_total_cost?: number;      // weighted-average cost of currently held shares, in base_currency
  base_avg_cost?: number;        // base_total_cost / total_shares (undefined while unreliable or no shares)
  base_cost_reliable?: boolean;  // false once any contributing transaction could not be trusted as an
                                  // authoritative base-currency cost — see applyTransactionToHolding.
                                  // total_cost/base_total_cost are NEVER fabricated once this is false;
                                  // callers must not display base_total_cost/base_avg_cost as verified
                                  // figures while it is false.
  base_realised_value?: number;  // Definition B realised P/L: base-currency proceeds - base-currency
                                  // historical cost of the units sold (never derived from a single
                                  // sale-date FX rate applied to the native ledger)
  base_realised_cost?: number;
  base_realised_proceeds?: number;
};

export type Ccy = 'GBP' | 'USD' | 'EUR';

export type Txn = {
  id: string;
  portfolio_id: string | null;
  asset_id: string;
  type: string;
  date?: string | null;
  created_at?: string | null;

  // position fields
  quantity?: number | null;
  price?: number | null;
  fee?: number | null;

  // Canonical new fields
  cash_value?: number | null;     // proceeds/consideration in cash_ccy (portfolio cash)
  cash_ccy?: string | null;
  cash_fx_to_portfolio?: number | null;

  // Settlement (asset) side
  settle_value?: number | null;   // settlement value in settle_ccy (asset currency)
  settle_ccy?: string | null;

  split_factor?: number | null;
};

export type AssetMeta = {
  ticker: string;
  currency: Ccy;
  logo_url?: string | null;
  status?: string | null;
  name?: string | null;
};

// ------------------------- Configuration -------------------------

const TRANSACTION_TYPE_META = {
  BUY:  { units: 1,  cost: 1,  realised: 1 },
  SELL: { units: -1, cost: -1, realised: 1 },
  TIN:  { units: 1,  cost: 1,  realised: 0 }, // in-kind transfer (no cash realisation)
  TOT:  { units: -1, cost: -1, realised: 0 }, // in-kind transfer (no cash realisation)
  DIV:  { units: 0,  cost: 0,  realised: 1 }, // income
  INT:  { units: 0,  cost: 0,  realised: 1 }, // income
  DEP:  { units: 0,  cost: 0,  realised: 0 }, // cash-only (handled in cash logic)
  WIT:  { units: 0,  cost: 0,  realised: 0 }, // cash-only (handled in cash logic)
  FEE:  { units: 0,  cost: 0,  realised: 1 }, // expense
  OTR:  { units: 0,  cost: 0,  realised: 0 }, // generic transfer (cash-only, handled in cash logic)
  SPL:  { units: 0,  cost: 0,  realised: 0 }, // stock split
  BAL:  { units: 0,  cost: 0,  realised: 0 }, // cash balance adj (cash-only)
} as const;

const CASH_EVENTS_REQUIRE_CASH_ASSET = true;

// Always treat these as cash-only (do not touch holdings)
const ALWAYS_CASH_TYPES = new Set(['DIV', 'INT']);

// --------------------------- Utilities ---------------------------

const isCashTicker = (t?: string | null) => !!t && t.startsWith('CASH.');

function round(n: number, dp = 6) {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

/** Stable ordering by (date, created_at, id) */
function stableSortTx<T extends { date?: string | null; created_at?: string | null; id: string }>(txs: T[]) {
  return [...txs].sort((a, b) => {
    const da = a.date ?? '';
    const db = b.date ?? '';
    if (da !== db) return da < db ? -1 : 1;

    const ca = a.created_at ?? '';
    const cb = b.created_at ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;

    return a.id < b.id ? -1 : 1;
  });
}

/* Deterministic intra-day ordering so entries (TIN/BUY/SPL) precede exits (SELL/TOT) */
const TYPE_PRIORITY: Record<string, number> = {
  SPL: 10,
  TIN: 20,
  BUY: 30,
  SELL: 40,
  TOT: 50,
  DIV: 90,
  INT: 95,
  FEE: 96,
  DEP: 97,
  WIT: 98,
  OTR: 99,
  BAL: 100,
};

function compareTxForHoldings(a: Txn, b: Txn) {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;

  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;

  const pa = TYPE_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = TYPE_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;

  return a.id < b.id ? -1 : 1;
}

/** Filter transactions up to asOf date. `inclusive` (default true) controls
 * whether transactions dated exactly asOf are kept — used by BAL
 * reconciliation's post-trade (inclusive) vs pre-trade (exclusive) modes. */
function filterAsOf<T extends { date?: string | null }>(
  txs: T[],
  asOf?: string | null,
  inclusive: boolean = true
) {
  if (!asOf) return txs;
  const asOfDate = new Date(asOf);
  if (isNaN(asOfDate.getTime())) return txs;
  return txs.filter(t => {
    if (!t?.date) return true; // keep undated
    const d = new Date(t.date);
    if (isNaN(d.getTime())) return true; // keep malformed
    return inclusive ? d.getTime() <= asOfDate.getTime() : d.getTime() < asOfDate.getTime();
  });
}

// --------------------- Helpers for P&L math ----------------------

/** SELL-row implied FX to convert asset-ccy cost -> cash-ccy:
 * impliedFX = |cash_value| / |settle_value|, if both present.
 * Falls back to 1 when currencies match or missing data.
 */
export function impliedFxFromSellRow(txn: Txn): number {
  const cashAbs   = Math.abs(Number(txn.cash_value)   || 0);
  const settleAbs = Math.abs(Number(txn.settle_value) || 0);
  if (cashAbs > 0 && settleAbs > 0) return cashAbs / settleAbs;

  const cashCcy   = (txn.cash_ccy   || '').toUpperCase();
  const settleCcy = (txn.settle_ccy || '').toUpperCase();
  if (cashCcy && settleCcy && cashCcy === settleCcy) return 1;
  return 1;
}

/** Book cost for a TIN in the ASSET currency (no gbp_value). */
export function deriveAssetCostForTIN(txn: Txn, assetCcy: string, qty: number, price: number, fee: number): number {
  // a) Best: settle_value in the asset ccy
  if (txn.settle_value != null && (txn.settle_ccy || '').toUpperCase() === assetCcy) {
    return Math.abs(Number(txn.settle_value) || 0);
  }
  // b) Some brokers supply cash_value in the asset ccy for TIN (no cash moved, but used as a book figure)
  if (txn.cash_value != null && (txn.cash_ccy || '').toUpperCase() === assetCcy) {
    return Math.abs(Number(txn.cash_value) || 0);
  }
  // c) If price present, treat price as asset-ccy
  if (qty > 0 && price !== 0) {
    return Math.abs(qty * price + fee);
  }
  // d) No usable data → zero cost (surface rows to backfill with settle_value)
  return 0;
}

// --------------------- Holdings (positions) ----------------------

/** Apply one transaction to a holding. Realised P/L is in the SELL’s cash currency.
 * Uses only settle_value/cash_value; never uses gbp_value.
 */
export function applyTransactionToHolding(holding: Holding, txn: Txn) {
  const type = (txn.type ?? '').toUpperCase() as keyof typeof TRANSACTION_TYPE_META;
  const meta = TRANSACTION_TYPE_META[type];
  if (!meta) return;

  // Stock split
  if (type === 'SPL') {
    const factor = Number(txn.split_factor || 0);
    if (!factor || factor <= 0) return;
    holding.total_shares = round(holding.total_shares * factor);
    holding.avg_price = holding.total_shares > 0 ? holding.total_cost / holding.total_shares : 0;

    // Definition B (additive, opt-in): a split creates no value in any
    // currency — base_total_cost is unchanged, only the derived per-share
    // figure moves, exactly mirroring the native avg_price line above.
    if (holding.base_currency) {
      holding.base_total_cost = holding.base_total_cost ?? 0;
      holding.base_cost_reliable = holding.base_cost_reliable ?? true;
      holding.base_avg_cost = holding.total_shares > 0 && holding.base_cost_reliable
        ? holding.base_total_cost / holding.total_shares
        : undefined;
    }
    return;
  }

  const qty   = Math.abs(Number(txn.quantity) || 0);
  const price = Number(txn.price) || 0;
  const fee   = Number(txn.fee)   || 0;
  // Definition B: pre-transaction share count, captured before any native
  // mutation below. Shares are currency-agnostic, so this same value is the
  // correct proportion basis for both the native and base-currency ledgers.
  const sharesBefore = holding.total_shares;

  const assetCcy = (holding.currency || '').toUpperCase();
  const isCash   = isCashTicker(holding.ticker);

  // -------- Realised P/L (SELL, DIV/INT, FEE) --------
  if (meta.realised !== 0 && !isCash) {
    // Proceeds amount + currency
    let proceedsAmount = 0;
    let proceedsCcy: string = assetCcy; // default to asset ccy if we must compute

    if (txn.cash_value != null) {
      proceedsAmount = Math.abs(Number(txn.cash_value) || 0);
      proceedsCcy = (txn.cash_ccy || assetCcy).toUpperCase();
    } else if (txn.settle_value != null) {
      // No explicit cash leg: treat proceeds as asset-ccy settlement
      proceedsAmount = Math.abs(Number(txn.settle_value) || 0);
      proceedsCcy = (txn.settle_ccy || assetCcy).toUpperCase();
    } else {
      // Last resort from price/qty in asset ccy
      proceedsAmount = Math.max(0, qty * price - fee);
      proceedsCcy = assetCcy;
    }

    if (type === 'DIV' || type === 'INT') {
      holding.realised_value    = (holding.realised_value    ?? 0) + proceedsAmount;
      holding.realised_proceeds = (holding.realised_proceeds ?? 0) + proceedsAmount;
      // no cost for income
    } else if (type === 'FEE') {
      // Standalone fee: reduce realised directly (domain assumed cash/proceeds currency)
      holding.realised_value    = (holding.realised_value ?? 0) - Math.abs(fee || 0);
      // leave realised_proceeds/cost unchanged
    } else if (type === 'SELL') {
      // Cost basis in asset ccy using running average BEFORE reducing units
      const avgCostAsset  = holding.total_shares > 0 ? holding.total_cost / holding.total_shares : 0;
      const costBasisAsset = avgCostAsset * qty;

      // Convert cost basis into proceeds currency using SELL’s implied FX (from this row)
      let costBasisCash = costBasisAsset;
      if (proceedsCcy && assetCcy && proceedsCcy !== assetCcy) {
        const fx = impliedFxFromSellRow(txn);
        costBasisCash = costBasisAsset * fx;
      }

      holding.realised_value    = (holding.realised_value    ?? 0) + (proceedsAmount - costBasisCash);
      holding.realised_proceeds = (holding.realised_proceeds ?? 0) + proceedsAmount;
      holding.realised_cost     = (holding.realised_cost     ?? 0) + costBasisCash;
    }
  } else {
    // init realised fields so UI doesn’t see undefined
    holding.realised_value    = holding.realised_value    ?? 0;
    holding.realised_proceeds = holding.realised_proceeds ?? 0;
    holding.realised_cost     = holding.realised_cost     ?? 0;
  }

  // -------- Units & cost basis (asset currency only) --------
  // Asset-side transaction total for BUY/TIN; for SELL/TOT we remove proportional cost.
  let txnAssetTotal = 0;

  if ((type === 'BUY' || type === 'TIN') &&
      txn.settle_value != null &&
      (txn.settle_ccy || '').toUpperCase() === assetCcy) {
    txnAssetTotal = Math.abs(Number(txn.settle_value) || 0);
  } else if (type === 'BUY') {
    // BUY cost in asset ccy
    txnAssetTotal = Math.abs(qty * price + fee);
  } else if (type === 'TIN') {
    txnAssetTotal = deriveAssetCostForTIN(txn, assetCcy, qty, price, fee);
  }

  if (type === 'TIN') {
    holding.total_shares += qty;
    holding.total_cost   += txnAssetTotal;
  } else if (type === 'TOT') {
    const proportion = holding.total_shares > 0 ? qty / holding.total_shares : 0;
    const costOut    = proportion > 0 ? holding.total_cost * proportion : 0;
    holding.total_shares -= qty;
    holding.total_cost   -= costOut;
  } else if (type === 'BUY') {
    holding.total_shares += qty;
    holding.total_cost   += txnAssetTotal;
  } else if (type === 'SELL') {
    const proportion = holding.total_shares > 0 ? qty / holding.total_shares : 0;
    const costOut    = proportion > 0 ? holding.total_cost * proportion : 0;
    holding.total_shares -= qty;
    holding.total_cost   -= costOut;
  }

  // Normalise
  if (holding.total_shares <= 1e-6) holding.total_shares = 0;
  if (holding.total_shares === 0) {
    holding.total_cost = 0;
    holding.avg_price = 0;
  } else {
    holding.total_cost = round(holding.total_cost);
    holding.total_shares = round(holding.total_shares);
    holding.avg_price = holding.total_cost / holding.total_shares;
  }

  // -----------------------------------------------------------------------
  // Definition B: parallel portfolio-base weighted-average cost ledger.
  // Fully additive — nothing above this point was changed to add this.
  // Only runs when the caller has opted in via holding.base_currency; a
  // Holding that never sets it is completely unaffected.
  //
  // Cost is sourced ONLY from cash_value/cash_ccy (the portfolio-base cash
  // actually paid/received — see src/lib/cashLeg.ts), never retranslated
  // from the native ledger using a sale-date or any other FX rate. Where
  // asset currency == base currency, cash_value already equals settle_value
  // (see the DB's mirror_settle_to_cash trigger and cashLeg.ts's
  // same-currency branch), so no separate no-FX code path is needed here —
  // the same formula naturally requires zero FX.
  //
  // TIN/TOT: no linked-transfer persistence layer exists yet (see the
  // transfer pending/matching design), so a TIN/TOT's cash_value cannot yet
  // be trusted as a real carried-forward base cost. Rather than guess, the
  // holding's base ledger is marked unreliable from that point on. Once a
  // confirmed link exists, this is exactly what CostParcel.baseCost/baseCcy
  // (src/lib/transferCostBasis.ts) is for.
  // -----------------------------------------------------------------------
  if (holding.base_currency) {
    const baseCcy = holding.base_currency.toUpperCase();
    holding.base_total_cost = holding.base_total_cost ?? 0;
    holding.base_realised_value = holding.base_realised_value ?? 0;
    holding.base_realised_cost = holding.base_realised_cost ?? 0;
    holding.base_realised_proceeds = holding.base_realised_proceeds ?? 0;
    holding.base_cost_reliable = holding.base_cost_reliable ?? true;

    if (type === 'TIN' || type === 'TOT') {
      holding.base_cost_reliable = false;
    } else if (type === 'BUY' || type === 'SELL') {
      const cashCcy = (txn.cash_ccy || '').toUpperCase();
      const cashVal = txn.cash_value != null ? Math.abs(Number(txn.cash_value)) : null;
      const fx = txn.cash_fx_to_portfolio != null ? Number(txn.cash_fx_to_portfolio) : null;
      const crossCcy = assetCcy !== baseCcy;
      const reliableRow = cashVal != null && cashCcy === baseCcy && (!crossCcy || (fx != null && fx > 0));

      if (!reliableRow) {
        holding.base_cost_reliable = false;
      } else if (type === 'BUY') {
        holding.base_total_cost += cashVal!;
      } else {
        // SELL — proportional removal using the SAME pre-transaction share
        // count as the native ledger (shares are currency-agnostic).
        const proportion = sharesBefore > 0 ? qty / sharesBefore : 0;
        const costOut = proportion > 0 ? holding.base_total_cost * proportion : 0;
        if (holding.base_cost_reliable) {
          holding.base_realised_value += cashVal! - costOut;
          holding.base_realised_proceeds += cashVal!;
          holding.base_realised_cost += costOut;
        }
        holding.base_total_cost -= costOut;
      }
    }

    if (holding.total_shares === 0) {
      // Position fully closed: nothing ambiguous remains to distrust, and
      // any later re-opening (fresh BUYs) starts a clean base-cost ledger —
      // exactly mirroring the native ledger's own full-exit reset above.
      holding.base_total_cost = 0;
      holding.base_cost_reliable = true;
    } else if (holding.base_cost_reliable) {
      holding.base_total_cost = round(holding.base_total_cost);
    }

    holding.base_avg_cost = holding.total_shares > 0 && holding.base_cost_reliable
      ? holding.base_total_cost / holding.total_shares
      : undefined;
  }
}

// --------------------- Cash (multi-ccy ledgers) ---------------------

type CashMap = Record<Ccy, number>;
function newCashMap(): CashMap {
  return { GBP: 0, USD: 0, EUR: 0 };
}

/** GBP-only ISA path WITHOUT gbp_value:
 * - Prefer explicit cash_value/cash_ccy (should be GBP for ISA).
 * - For BUY/SELL with missing cash_value, fall back to price/qty±fee only when the asset currency is GBP.
 * - BAL rows: use signed cash_value (GBP).
 */
function calculateCashBalancesISA_GBP(
  txns: Txn[],
  assetMeta: Record<string, AssetMeta>,
  asOf?: string
): { currency: 'GBP'; balance: number }[] {
  const filtered = filterAsOf(txns, asOf);
  let gbp = 0;

  for (const tx of filtered) {
    const t = (tx.type ?? '').toUpperCase();
    const meta = assetMeta[tx.asset_id];
    const isCashAsset = !!(meta && isCashTicker(meta.ticker));
    const assetCcy = (meta?.currency || 'GBP').toUpperCase();

    if (t === 'BAL') {
      if (tx.cash_value != null) {
        const sign = (Number(tx.quantity) || 0) >= 0 ? +1 : -1;
        const ccy = (tx.cash_ccy || 'GBP').toUpperCase();
        const amt = Math.abs(Number(tx.cash_value) || 0);
        if (ccy === 'GBP') gbp += sign * amt;
      }
      continue;
    }

    if (t === 'DIV' || t === 'INT') {
      if (tx.cash_value != null && (tx.cash_ccy || 'GBP').toUpperCase() === 'GBP') {
        gbp += Math.abs(Number(tx.cash_value) || 0);
      }
      continue;
    }

    if (t === 'DEP' || t === 'WIT' || t === 'FEE' || t === 'OTR') {
      if (!CASH_EVENTS_REQUIRE_CASH_ASSET || isCashAsset) {
        if (tx.cash_value != null && (tx.cash_ccy || 'GBP').toUpperCase() === 'GBP') {
          const sign = t === 'DEP' || t === 'OTR' ? +1 : -1;
          gbp += sign * Number(tx.cash_value || 0); // OTR is already signed
        }
      }
      continue;
    }

    if (t === 'BUY' || t === 'SELL') {
      if (tx.cash_value != null && (tx.cash_ccy || 'GBP').toUpperCase() === 'GBP') {
        const amt = Math.abs(Number(tx.cash_value) || 0);
        gbp += (t === 'BUY' ? -1 : +1) * amt;
      } else if (assetCcy === 'GBP') {
        // compute from price/qty/fee in GBP asset
        const q = Number(tx.quantity) || 0;
        const p = Number(tx.price) || 0;
        const f = Number(tx.fee) || 0;
        const amt = t === 'BUY' ? (p * q + f) : (p * q - f);
        gbp += (t === 'BUY' ? -1 : +1) * amt;
      }
      continue;
    }

    if ((t === 'TIN' || t === 'TOT') && isCashAsset) {
      // only when using CASH.* tickers for cash transfers; use cash_value (GBP) if provided
      if (!CASH_EVENTS_REQUIRE_CASH_ASSET || isCashAsset) {
        if (tx.cash_value != null && (tx.cash_ccy || 'GBP').toUpperCase() === 'GBP') {
          const sign = t === 'TIN' ? +1 : -1;
          gbp += sign * Math.abs(Number(tx.cash_value) || 0);
        }
      }
      continue;
    }
  }

  return [{ currency: 'GBP', balance: Math.round(gbp * 100) / 100 }];
}

export function calculateCashBalancesMulti(
  txns: Txn[],
  assetMeta: Record<string, AssetMeta>,
  opts?: {
    asOf?: string;
    asOfInclusive?: boolean;
    portfolioName?: string;
    requireCashAssetForCashRows?: boolean;
  }
): { currency: Ccy; balance: number }[] {
  const asOf = opts?.asOf;
  const requireCashAsset = opts?.requireCashAssetForCashRows ?? true;

  const cash = newCashMap();
  const filtered = filterAsOf(txns, asOf, opts?.asOfInclusive ?? true);

  for (const tx of filtered) {
    const t = (tx.type ?? '').toUpperCase();
    const meta = assetMeta[tx.asset_id];
    const isCashAsset = !!(meta && isCashTicker(meta.ticker));
    const assetCcy = (meta?.currency || 'GBP').toUpperCase() as Ccy;

    // BAL: explicit signed reconciliation adjustment. cash_value alone carries
    // both sign and magnitude — quantity is not consulted (see BAL
    // reconciliation design; previously the sign came from `quantity`, which
    // could invert the intended adjustment).
    if (t === 'BAL') {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        cash[ccy] += Number(tx.cash_value) || 0;
      }
      continue;
    }

    // DIV/INT: income in cash
    if (t === 'DIV' || t === 'INT') {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        cash[ccy] += Math.abs(Number(tx.cash_value) || 0);
      }
      continue;
    }

    // Cash-only rows
    if (t === 'DEP' || t === 'WIT' || t === 'FEE') {
      if (!requireCashAsset || isCashAsset) {
        if (tx.cash_value != null) {
          const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
          const amt = Math.abs(Number(tx.cash_value) || 0);
          const sign = (t === 'DEP') ? +1 : -1;
          cash[ccy] += sign * amt;
        }
      }
      continue;
    }

    // OTR: allow signed cash_value as-is. Unlike DEP/WIT/FEE/TIN/TOT, OTR's
    // cash effect is NOT gated by isCashAsset/requireCashAsset — OTR is a
    // generic catch-all import type (dividend withholding tax, ADR fees,
    // account fees, sweep transfers, ...) and real broker cash events of
    // that kind are routinely recorded against the security that caused
    // them (e.g. the taxed dividend's ticker), not against a CASH.* row.
    // The asset is context for the event, not a determinant of whether real
    // cash moved. See tests/financial/current-behaviour.cash.spec.ts "OTR
    // SPEC" for the worked examples this fixes.
    if (t === 'OTR') {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        cash[ccy] += Number(tx.cash_value) || 0;
      }
      continue;
    }

    // BUY/SELL: prefer explicit cash_value/cash_ccy; otherwise compute from price/qty in asset ccy
    if (t === 'BUY' || t === 'SELL') {
      if (tx.cash_value != null) {
        const amt = Math.abs(Number(tx.cash_value) || 0);
        const ccy = ((tx.cash_ccy || assetCcy).toUpperCase()) as Ccy;
        cash[ccy] += (t === 'BUY' ? -1 : +1) * amt;
      } else {
        // compute in asset ccy as a fallback when no explicit cash leg recorded
        const q = Number(tx.quantity) || 0;
        const p = Number(tx.price) || 0;
        const f = Number(tx.fee) || 0;
        const amt = t === 'BUY' ? (p * q + f) : (p * q - f);
        if (amt) cash[assetCcy] += (t === 'BUY' ? -1 : +1) * amt;
      }
      continue;
    }

    // TIN/TOT for CASH.* tickers (in-kind cash moves): use cash_value where present
    if ((t === 'TIN' || t === 'TOT') && isCashAsset) {
      if (!requireCashAsset || isCashAsset) {
        const sign = t === 'TIN' ? +1 : -1;
        if (tx.cash_value != null) {
          const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
          const amt = Math.abs(Number(tx.cash_value) || 0) * sign;
          cash[ccy] += amt;
        }
      }
      continue;
    }

    // TIN/TOT/SPL for non-cash assets → no cash effect
  }

  return (Object.keys(cash) as Ccy[])
    .map(ccy => ({ currency: ccy, balance: Math.round(cash[ccy] * 100) / 100 }))
    .filter(x => Math.abs(x.balance) > 1e-9);
}

// -----------------------------------------------------------------------------
// BAL reconciliation preview — pure, unit-testable, built on the canonical
// cash engine (calculateCashBalancesMulti) rather than a separate gbp_value
// reducer. Used by the Cash Balance Adjustment tool (src/app/tools/cash-balance).
// -----------------------------------------------------------------------------

export type ForeignCurrencyWarning = {
  currencies: Ccy[];
  message: string;
};

export function computeBalancePreview(
  txns: Txn[],
  assetMeta: Record<string, AssetMeta>,
  opts: {
    baseCcy: Ccy;
    asOf: string;
    mode: 'pre' | 'post';
    target: number;
  }
): {
  current: number;
  target: number;
  diff: number;
  ccy: Ccy;
  foreignCurrencyWarning: ForeignCurrencyWarning | null;
} {
  // 'post' (post-trade) includes same-day transactions; 'pre' (pre-trade)
  // excludes them — see filterAsOf's `inclusive` parameter.
  const balances = calculateCashBalancesMulti(txns, assetMeta, {
    asOf: opts.asOf,
    asOfInclusive: opts.mode === 'post',
    requireCashAssetForCashRows: true,
  });
  const current = balances.find(b => b.currency === opts.baseCcy)?.balance ?? 0;
  const diff = Math.round((opts.target - current) * 100) / 100;

  // Agreed model: BAL reconciliation is against the base-currency cash
  // ledger only. We do not auto-convert other currencies' cash buckets into
  // baseCcy, and we do not build a full multi-currency FX ledger here — so
  // any non-baseCcy bucket with a real balance in this asOf/mode scope must
  // be called out explicitly rather than silently read as zero.
  const foreignCurrencies = balances
    .map(b => b.currency)
    .filter(c => c !== opts.baseCcy);
  const foreignCurrencyWarning: ForeignCurrencyWarning | null = foreignCurrencies.length
    ? {
        currencies: foreignCurrencies,
        message:
          `This portfolio also has ${foreignCurrencies.join(', ')} cash activity as of this date. ` +
          `${foreignCurrencies.join('/')} amounts are outside the ${opts.baseCcy} reconciliation ledger ` +
          `and have NOT been converted or included in the balance above.`,
      }
    : null;

  return { current, target: opts.target, diff, ccy: opts.baseCcy, foreignCurrencyWarning };
}

// -----------------------------------------------------------------------------
// Per-Portfolio Holdings & Cash (with optional asOf)
// -----------------------------------------------------------------------------

export async function getPortfoliosWithHoldingsAndCash(
  supabase: SupabaseClient,
  opts?: { asOf?: string }
) {
  const { data: portfolios } = await supabase
    .from('portfolios')
    .select('id, name, base_currency');
  if (!portfolios) return [];

  const { data: assets } = await supabase
    .from('assets')
    .select('id, ticker, name, currency, logo_url, status');
  if (!assets) return [];

  // Fetch all transactions using the paging helper
  const txnsRaw = await fetchAllTable<Txn>(supabase, 'transactions');
  if (!txnsRaw) return [];

  const txns = stableSortTx<Txn>(txnsRaw as Txn[]);

  const assetMeta: Record<string, AssetMeta & { company_name?: string }> = {};
  for (const a of assets) {
    assetMeta[a.id] = {
      ticker: a.ticker,
      company_name: a.name ?? undefined,
      currency: (a.currency as Ccy) ?? 'GBP',
      logo_url: a.logo_url,
      status: a.status,
      name: a.name ?? undefined,
    };
  }

  const result: {
    portfolio: Portfolio;
    holdings: Holding[];
    cash_balances: { currency: string; balance: number }[];
  }[] = [];

  for (const portfolio of portfolios) {
    const pid = portfolio.id;
    const baseCurrency = (portfolio.base_currency ?? 'GBP') as Ccy;

    const portfolioTxnsFull = txns.filter(t => t.portfolio_id === pid);
    const portfolioTxns = filterAsOf(portfolioTxnsFull, opts?.asOf);

    // Build holdings from transactions that belong to non-CASH assets
    const holdingsMap: Record<string, Holding> = {};
    const holdingsTxns: Txn[] = [];

    for (const tx of portfolioTxns) {
      const rawType = (tx.type ?? '').toString();
      const ttype = rawType.trim().toUpperCase();
      const meta = assetMeta[tx.asset_id];
      const ticker = meta?.ticker ?? tx.asset_id;

      if (!meta) continue;
      if (ALWAYS_CASH_TYPES.has(ttype)) continue;
      if (isCashTicker(ticker)) continue;

      holdingsTxns.push(tx);
    }

    // Apply holdings transactions
    holdingsTxns.sort(compareTxForHoldings); // ensure entry before exit same day
    for (const txn of holdingsTxns) {
      const meta = assetMeta[txn.asset_id] || ({ ticker: txn.asset_id, currency: baseCurrency } as AssetMeta);
      const ticker = meta.ticker || txn.asset_id;
      const currency = meta.currency || baseCurrency;

      if (!holdingsMap[ticker]) {
        holdingsMap[ticker] = {
          asset_id: txn.asset_id,
          ticker,
          company_name: meta.name ?? undefined,
          total_shares: 0,
          total_cost: 0,
          avg_price: 0,
          currency,
          logo_url: meta.logo_url ?? undefined,
          status: meta.status ?? undefined,
          realised_value: 0,
          realised_cost: 0,
          realised_proceeds: 0,
        };
      }

      applyTransactionToHolding(holdingsMap[ticker], txn);
    }

    // Cash balances (multi-ccy)
    const cash_balances = calculateCashBalancesMulti(portfolioTxns, assetMeta, {
      asOf: opts?.asOf,
      portfolioName: portfolio.name,
      requireCashAssetForCashRows: CASH_EVENTS_REQUIRE_CASH_ASSET,
    });

    const holdings = Object.values(holdingsMap);

    result.push({
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        base_currency: baseCurrency,
      },
      holdings,
      cash_balances,
    });
  }

  return result;
}

// -----------------------------------------------------------------------------
// Global (All-Portfolio) Holdings & Cash (with optional asOf)
// -----------------------------------------------------------------------------

export async function getAllHoldingsAndCashSummary(
  supabase: SupabaseClient,
  opts?: { asOf?: string }
) {
  const { data: assets } = await supabase
    .from('assets')
    .select('id, ticker, name, currency, logo_url, status');
  if (!assets) return { holdings: [], cash_balances: [] };

  const txnsRaw = await fetchAllTable<Txn>(supabase, 'transactions');
  if (!txnsRaw) return { holdings: [], cash_balances: [] };

  const txnsAll = stableSortTx<Txn>(txnsRaw as Txn[]);
  const txns = filterAsOf(txnsAll, opts?.asOf);

  const assetMeta: Record<string, AssetMeta & { company_name?: string }> = {};
  for (const a of assets) {
    assetMeta[a.id] = {
      ticker: a.ticker,
      company_name: a.name ?? undefined,
      currency: (a.currency as Ccy) ?? 'GBP',
      logo_url: a.logo_url,
      status: a.status,
      name: a.name ?? undefined,
    };
  }

  // Build global holdings (exclude CASH.* and DIV/INT)
  const holdingsMap: Record<string, Holding> = {};
  const holdingsTxns: Txn[] = [];

  for (const tx of txns) {
    const meta = assetMeta[tx.asset_id];
    if (!meta) continue;
    const ttype = (tx.type || '').toUpperCase();
    if (ALWAYS_CASH_TYPES.has(ttype)) continue;
    if (isCashTicker(meta.ticker)) continue;
    holdingsTxns.push(tx);
  }

  holdingsTxns.sort(compareTxForHoldings);

  for (const txn of holdingsTxns) {
    const meta = assetMeta[txn.asset_id];
    if (!meta) continue;
    const ticker = meta.ticker;
    if (!holdingsMap[ticker]) {
      holdingsMap[ticker] = {
        asset_id: txn.asset_id,
        ticker,
        company_name: meta.name ?? undefined,
        total_shares: 0,
        total_cost: 0,
        avg_price: 0,
        currency: meta.currency,
        logo_url: meta.logo_url ?? undefined,
        status: meta.status ?? undefined,
        realised_value: 0,
        realised_cost: 0,
        realised_proceeds: 0,
      };
    }
    applyTransactionToHolding(holdingsMap[ticker], txn);
  }

  const holdings = Object.values(holdingsMap);

  const cash_balances = calculateCashBalancesMulti(txns, assetMeta, {
    asOf: opts?.asOf,
    requireCashAssetForCashRows: CASH_EVENTS_REQUIRE_CASH_ASSET,
  });

  return { holdings, cash_balances };
}

// Paging helper (fixed - completes previously truncated function)
async function fetchAllTable<T = any>(
  supabase: SupabaseClient,
  table: string,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}
