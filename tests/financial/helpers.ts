// Shared test-data builders for A1 financial specification/characterisation tests.
// These build plain in-memory objects matching src/lib/queries.ts's types —
// no Supabase client, no network, so the functions under test can run as pure functions.

import type { Txn, AssetMeta, Ccy } from '../../src/lib/queries';
import type { Holding } from '../../src/lib/queries';

let txnCounter = 0;

export function makeTxn(overrides: Partial<Txn> = {}): Txn {
  txnCounter += 1;
  const defaults: Txn = {
    id: `txn-${txnCounter}`,
    portfolio_id: 'portfolio-1',
    asset_id: 'asset-1',
    type: 'BUY',
    date: '2024-01-01',
    created_at: '2024-01-01T00:00:00Z',
    quantity: null,
    price: null,
    fee: null,
    cash_value: null,
    cash_ccy: null,
    cash_fx_to_portfolio: null,
    settle_value: null,
    settle_ccy: null,
    split_factor: null,
  };
  return { ...defaults, ...overrides };
}

export function makeHolding(overrides: Partial<Holding> & { asset_id: string; ticker: string }): Holding {
  const defaults = {
    total_shares: 0,
    avg_price: 0,
    total_cost: 0,
    currency: 'GBP' as Ccy,
    realised_value: 0,
    realised_cost: 0,
    realised_proceeds: 0,
  };
  return { ...defaults, ...overrides };
}

export function assetMetaFor(
  entries: Record<string, { ticker: string; currency?: Ccy; status?: string | null }>
): Record<string, AssetMeta> {
  const out: Record<string, AssetMeta> = {};
  for (const [id, a] of Object.entries(entries)) {
    out[id] = {
      ticker: a.ticker,
      currency: a.currency ?? 'GBP',
      status: a.status ?? 'active',
      name: null,
      logo_url: null,
    };
  }
  return out;
}

export function cashFor(rows: { currency: string; balance: number }[], ccy: string): number {
  return rows.find((r) => r.currency === ccy)?.balance ?? 0;
}
