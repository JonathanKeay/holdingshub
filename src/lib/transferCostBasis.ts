// src/lib/transferCostBasis.ts
//
// Pure, arrival-order-independent transfer-cost-basis operations.
//
// Context: a real TOT/TIN pair (an in-specie transfer between two
// HoldingsHub-tracked portfolios) is imported asynchronously in real use —
// the two legs may arrive from different broker exports, in different
// import sessions, hours/days/weeks apart, and in either order. The
// accounting rule agreed for a CONFIRMED linked transfer is: the destination
// must inherit exactly the native-currency cost the source's transfer-out
// proportionally removed — never a re-derivation from transfer-date market
// value.
//
// These two functions express that arithmetic independently of *when* or
// *in what order* it happens:
//   - applyTransferOut() removes shares/cost from a source Holding exactly as
//     applyTransactionToHolding()'s existing TOT branch does (same weighted-
//     average-cost formula — see src/lib/queries.ts), and returns a
//     self-contained "cost parcel" snapshot (plain data, no live reference
//     back into the source holding).
//   - applyTransferIn() credits a destination Holding with a previously
//     captured parcel. Cost comes ONLY from the parcel — this function does
//     not take a price, a market value, or any other cost input. That is
//     what guarantees a linked transfer can never manufacture or erase
//     investment performance, regardless of how long the parcel sat
//     "pending" before the matching TIN was recorded.
//
// A CostParcel is a plain snapshot: once returned, further changes to the
// source holding (more BUYs, SELLs, etc. between the TOT being recorded and
// the TIN being matched) cannot affect it. This is what makes the two
// operations order-independent — applyTransferOut and applyTransferIn are
// only ever coupled through the parcel value, never through shared object
// state or timing.
//
// NOT YET WIRED IN. No import path, UI, or the existing
// applyTransactionToHolding()'s TIN/TOT branches call these functions today,
// and this file changes no existing behaviour. Deciding *which* real TOT/TIN
// rows are linked is a persistence/matching question (see the transfer
// pending/matching design) that is deliberately out of scope here — this
// module only answers "given a source holding and a CONFIRMED link, what is
// the correct arithmetic", never "which rows are linked" or "is this link
// safe to assume".

import type { Holding } from './queries';

export type CostParcel = {
  assetId: string;
  ticker: string;
  quantity: number;
  nativeCost: number;
  nativeCcy: string;
  // Portfolio-base (e.g. GBP) cost carry-forward depends on the Definition B
  // parallel base-currency ledger, which does not exist yet. These fields
  // are reserved so the parcel shape will not need to change again once it
  // does — today every caller leaves them undefined.
  baseCost?: number;
  baseCcy?: string;
};

function round(n: number, dp = 6) {
  const p = Math.pow(10, dp);
  return Math.round(n * p) / p;
}

function normalise(holding: Holding) {
  if (holding.total_shares <= 1e-6) holding.total_shares = 0;
  if (holding.total_shares === 0) {
    holding.total_cost = 0;
    holding.avg_price = 0;
  } else {
    holding.total_cost = round(holding.total_cost);
    holding.total_shares = round(holding.total_shares);
    holding.avg_price = holding.total_cost / holding.total_shares;
  }
}

/**
 * Remove `quantity` shares from `holding` at its current weighted-average
 * cost — identical arithmetic to applyTransactionToHolding's existing TOT
 * branch (src/lib/queries.ts) — and return the parcel of quantity + native
 * cost that left the holding. Never books realised P/L: a transfer is not a
 * disposal.
 *
 * If the holding also carries a reliable Definition B base-currency ledger
 * (holding.base_currency set, holding.base_cost_reliable true — see
 * applyTransactionToHolding), the same proportion is applied to
 * base_total_cost and returned as parcel.baseCost/baseCcy. If the source's
 * base ledger is not reliable (or not tracked at all), baseCost/baseCcy are
 * simply omitted — never fabricated — so the eventual destination correctly
 * inherits "unknown" rather than a invented figure.
 */
export function applyTransferOut(holding: Holding, quantity: number): CostParcel {
  const qty = Math.abs(Number(quantity) || 0);
  const proportion = holding.total_shares > 0 ? qty / holding.total_shares : 0;
  const nativeCost = proportion > 0 ? round(holding.total_cost * proportion) : 0;

  let baseCost: number | undefined;
  let baseCcy: string | undefined;
  if (holding.base_currency && holding.base_cost_reliable && holding.base_total_cost != null) {
    baseCost = proportion > 0 ? round(holding.base_total_cost * proportion) : 0;
    baseCcy = holding.base_currency.toUpperCase();
    holding.base_total_cost -= baseCost;
  }

  holding.total_shares -= qty;
  holding.total_cost -= nativeCost;
  normalise(holding);

  return {
    assetId: holding.asset_id,
    ticker: holding.ticker,
    quantity: round(qty),
    nativeCost,
    nativeCcy: (holding.currency || '').toUpperCase(),
    ...(baseCost != null ? { baseCost, baseCcy } : {}),
  };
}

/**
 * Credit `holding` with a previously captured transfer parcel. Cost comes
 * ONLY from the parcel: no price, market value, or other input is consulted.
 * Throws on a currency mismatch rather than silently converting or ignoring
 * it — an asset-currency mismatch between source and destination means the
 * two legs do not actually describe the same security/parcel, which is a
 * matching error, not something this function should paper over.
 *
 * If `holding` opts into Definition B (base_currency set) and the parcel
 * carries a baseCost, it is credited the same way as the native cost. If the
 * parcel has no baseCost (the source's base ledger was itself unreliable, or
 * untracked), the destination's base ledger is marked unreliable rather than
 * left silently at whatever it was — "unknown" must propagate, never be
 * dropped.
 */
export function applyTransferIn(holding: Holding, parcel: CostParcel): void {
  const destCcy = (holding.currency || '').toUpperCase();
  const parcelCcy = (parcel.nativeCcy || '').toUpperCase();
  if (destCcy && parcelCcy && destCcy !== parcelCcy) {
    throw new Error(
      `applyTransferIn: currency mismatch — destination holding is ${destCcy}, parcel is ${parcelCcy}.`
    );
  }

  holding.total_shares += parcel.quantity;
  holding.total_cost += parcel.nativeCost;
  normalise(holding);

  if (holding.base_currency) {
    const baseCcy = holding.base_currency.toUpperCase();
    holding.base_total_cost = holding.base_total_cost ?? 0;
    holding.base_cost_reliable = holding.base_cost_reliable ?? true;

    if (parcel.baseCost != null && parcel.baseCcy) {
      const parcelBaseCcy = parcel.baseCcy.toUpperCase();
      if (parcelBaseCcy !== baseCcy) {
        throw new Error(
          `applyTransferIn: base-currency mismatch — destination is ${baseCcy}, parcel is ${parcelBaseCcy}.`
        );
      }
      if (holding.base_cost_reliable) {
        holding.base_total_cost += parcel.baseCost;
      }
    } else {
      holding.base_cost_reliable = false;
    }
  }
}
