// src/lib/portfolio-series-cash.ts
//
// Extracted from src/app/api/portfolio-series/route.ts so this cash-effect
// logic can be unit-tested directly (Next.js route.ts files may only export
// HTTP-method handlers and a small set of route config keys — any other
// export fails Next's route-type validation at build time). Behaviour is
// unchanged from the original in-file version; this is a pure move, plus the
// BAL sign fix (see calculateCashBalancesMulti in src/lib/queries.ts, which
// this is a deliberate duplicate of and must be kept in lockstep with).

export type Ccy = 'GBP' | 'USD' | 'EUR';

export function isCashTicker(t?: string | null) {
  return !!t && t.toUpperCase().startsWith('CASH.');
}

export type Txn = {
  id: string;
  asset_id: string;
  type: string;
  date?: string | null;
  created_at?: string | null;
  quantity?: number | null;
  price?: number | null;
  fee?: number | null;
  cash_value?: number | null;
  cash_ccy?: string | null;
  settle_value?: number | null;
  settle_ccy?: string | null;
  split_factor?: number | null;
};

export type AssetMeta = {
  id: string;
  ticker: string;
  currency: Ccy;
  status: string;
  resolved_ticker: string;
  price_multiplier: number;
};

export function newCashMap(): Record<Ccy, number> {
  return { GBP: 0, USD: 0, EUR: 0 };
}

export function applyCashTxn(cash: Record<Ccy, number>, meta: AssetMeta, tx: Txn) {
  const t = (tx.type || '').toUpperCase();
  const isCashAsset = isCashTicker(meta.ticker);
  const assetCcy = (meta.currency || 'GBP').toUpperCase() as Ccy;

  // Match calculateCashBalancesMulti() behavior in src/lib/queries.ts
  // requireCashAssetForCashRows = true

  if (t === 'BAL') {
    // Signed reconciliation adjustment: cash_value alone carries sign and
    // magnitude; quantity is not consulted. Kept in lockstep with
    // calculateCashBalancesMulti()'s BAL branch in src/lib/queries.ts.
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Number(tx.cash_value) || 0;
    }
    return;
  }

  if (t === 'DIV' || t === 'INT') {
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Math.abs(Number(tx.cash_value) || 0);
    }
    return;
  }

  if (t === 'DEP' || t === 'WIT' || t === 'FEE') {
    if (isCashAsset) {
      if (tx.cash_value != null) {
        const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
        const amt = Math.abs(Number(tx.cash_value) || 0);
        const sign = (t === 'DEP') ? +1 : -1;
        cash[ccy] += sign * amt;
      }
    }
    return;
  }

  if (t === 'OTR') {
    // Not gated by isCashAsset — kept in lockstep with calculateCashBalancesMulti's
    // OTR branch in src/lib/queries.ts. See the comment there for why.
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Number(tx.cash_value) || 0;
    }
    return;
  }

  if (t === 'FXM') {
    // Realised FX movement on base-currency cash — signed cash_value added
    // as-is, unconditionally. Kept in lockstep with calculateCashBalancesMulti's
    // FXM branch in src/lib/queries.ts. See the comment there for why.
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Number(tx.cash_value) || 0;
    }
    return;
  }

  if (t === 'BUY' || t === 'SELL') {
    if (tx.cash_value != null) {
      const amt = Math.abs(Number(tx.cash_value) || 0);
      const ccy = ((tx.cash_ccy || assetCcy).toUpperCase()) as Ccy;
      cash[ccy] += (t === 'BUY' ? -1 : +1) * amt;
    } else {
      // fallback compute in asset ccy
      const q = Number(tx.quantity) || 0;
      const p = Number(tx.price) || 0;
      const f = Number(tx.fee) || 0;
      const amt = t === 'BUY' ? (p * q + f) : (p * q - f);
      if (amt) cash[assetCcy] += (t === 'BUY' ? -1 : +1) * amt;
    }
    return;
  }

  if ((t === 'TIN' || t === 'TOT') && isCashAsset) {
    const sign = t === 'TIN' ? +1 : -1;
    if (tx.cash_value != null) {
      const ccy = ((tx.cash_ccy || 'GBP').toUpperCase()) as Ccy;
      cash[ccy] += Math.abs(Number(tx.cash_value) || 0) * sign;
    }
    return;
  }
}
