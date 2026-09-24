// CASH PARITY — calculateCashBalancesMulti vs applyCashTxn (Phase 0 safety net)
//
// Two live implementations compute portfolio cash:
//   - calculateCashBalancesMulti (src/lib/queries.ts) — dashboard / API cash
//   - applyCashTxn (src/lib/portfolio-series-cash.ts) — historical cash series
// See docs/ACCOUNTING.md §8 and §15 item 4.
//
// These tests pin that the two agree, branch by branch, for CURRENT behaviour,
// so a later consolidation (cleanup item B4) cannot silently change either.
// They do not assert that the current behaviour is desirable — several
// branches below are known defects, pinned separately and explicitly in
// known-defects.characterisation.spec.ts (C3 negative DIV/INT/DEP sign,
// C12 unsupported cash currency).
//
// The cases are table-driven over materially distinct branches (type x
// asset kind x sign/nullness x currency source), not every combination.
//
// Known, intentional structural differences between the two are NOT hidden:
// the comparison helper normalises only the one documented difference
// (2 dp output rounding + dropping zero buckets), and every other difference
// is pinned explicitly in the "CURRENT DIFFERENCES" block at the bottom.

import { describe, it, expect } from 'vitest';
import { calculateCashBalancesMulti, type AssetMeta as QAssetMeta, type Txn as QTxn } from '../../src/lib/queries';
import {
  applyCashTxn,
  newCashMap,
  type AssetMeta as SAssetMeta,
  type Txn as STxn,
} from '../../src/lib/portfolio-series-cash';

type Ccy = 'GBP' | 'USD' | 'EUR';

const ASSETS: Record<string, { ticker: string; currency: Ccy }> = {
  'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' },
  'cash-usd': { ticker: 'CASH.USD', currency: 'USD' },
  'sec-gbp': { ticker: 'VOD.L', currency: 'GBP' },
  'sec-usd': { ticker: 'AAPL', currency: 'USD' },
};

const qMeta: Record<string, QAssetMeta> = Object.fromEntries(
  Object.entries(ASSETS).map(([id, a]) => [id, { ticker: a.ticker, currency: a.currency, status: 'active', name: null, logo_url: null }])
);

const sMeta: Record<string, SAssetMeta> = Object.fromEntries(
  Object.entries(ASSETS).map(([id, a]) => [
    id,
    { id, ticker: a.ticker, currency: a.currency, status: 'active', resolved_ticker: a.ticker, price_multiplier: 1 },
  ])
);

let seq = 0;
function tx(overrides: Partial<QTxn> & { type: string; asset_id: string }): QTxn {
  seq += 1;
  return {
    id: `t${String(seq).padStart(4, '0')}`,
    portfolio_id: 'p1',
    date: '2024-06-01',
    created_at: `2024-06-01T00:00:00.${String(seq).padStart(3, '0')}Z`,
    quantity: null,
    price: null,
    fee: null,
    cash_value: null,
    cash_ccy: null,
    cash_fx_to_portfolio: null,
    settle_value: null,
    settle_ccy: null,
    split_factor: null,
    ...overrides,
  };
}

/** Raw (unrounded) applyCashTxn result over a sequence. */
function seriesRaw(txns: QTxn[]): Record<string, number> {
  const cash: Record<string, number> = newCashMap();
  for (const t of txns) applyCashTxn(cash as any, sMeta[t.asset_id], t as STxn);
  return cash;
}

/**
 * applyCashTxn result normalised ONLY for the documented output-level
 * difference (calculateCashBalancesMulti rounds to 2 dp once and drops
 * buckets within 1e-9 of zero). Nothing else is normalised.
 */
function seriesNormalised(txns: QTxn[]): { currency: string; balance: number }[] {
  const cash = seriesRaw(txns);
  return Object.keys(cash)
    .map((ccy) => ({ currency: ccy, balance: Math.round(cash[ccy] * 100) / 100 }))
    .filter((x) => Math.abs(x.balance) > 1e-9);
}

function multi(txns: QTxn[]) {
  return calculateCashBalancesMulti(txns, qMeta);
}

type Case = {
  name: string;
  txn: Partial<QTxn> & { type: string; asset_id: string };
  /** CURRENT result of both engines, pinned so parity cannot be achieved by both drifting together. */
  expected: { currency: string; balance: number }[];
};

const CASES: Case[] = [
  // ---- BAL: signed cash_value, ungated, cash_ccy default GBP ----
  { name: 'BAL +100 GBP on CASH.GBP', txn: { type: 'BAL', asset_id: 'cash-gbp', cash_value: 100, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 100 }] },
  { name: 'BAL -100 GBP keeps its sign', txn: { type: 'BAL', asset_id: 'cash-gbp', cash_value: -100, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -100 }] },
  { name: 'BAL with null cash_ccy defaults to GBP', txn: { type: 'BAL', asset_id: 'cash-usd', cash_value: 50, cash_ccy: null }, expected: [{ currency: 'GBP', balance: 50 }] },
  { name: 'BAL with null cash_value has no effect', txn: { type: 'BAL', asset_id: 'cash-gbp', cash_value: null, cash_ccy: 'GBP' }, expected: [] },

  // ---- DIV / INT: +abs(cash_value), ungated, cash_ccy default GBP ----
  { name: 'DIV +42.50 GBP on a security (ungated)', txn: { type: 'DIV', asset_id: 'sec-gbp', cash_value: 42.5, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 42.5 }] },
  { name: 'DIV in USD lands in the USD bucket', txn: { type: 'DIV', asset_id: 'sec-usd', cash_value: 7.25, cash_ccy: 'USD' }, expected: [{ currency: 'USD', balance: 7.25 }] },
  { name: 'DIV with null cash_ccy defaults to GBP, not the asset currency', txn: { type: 'DIV', asset_id: 'sec-usd', cash_value: 7.25, cash_ccy: null }, expected: [{ currency: 'GBP', balance: 7.25 }] },
  { name: 'DIV negative is added as abs (see known defect C3)', txn: { type: 'DIV', asset_id: 'sec-gbp', cash_value: -5, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 5 }] },
  { name: 'INT +2.14 GBP on CASH.GBP', txn: { type: 'INT', asset_id: 'cash-gbp', cash_value: 2.14, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 2.14 }] },

  // ---- DEP / WIT / FEE: gated on CASH.* asset; sign from type, abs(cash_value) ----
  { name: 'DEP +200 on CASH.GBP', txn: { type: 'DEP', asset_id: 'cash-gbp', cash_value: 200, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 200 }] },
  { name: 'DEP on a security has no cash effect (gated)', txn: { type: 'DEP', asset_id: 'sec-gbp', cash_value: 200, cash_ccy: 'GBP' }, expected: [] },
  { name: 'WIT +200 on CASH.GBP subtracts', txn: { type: 'WIT', asset_id: 'cash-gbp', cash_value: 200, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -200 }] },
  { name: 'WIT -200 on CASH.GBP also subtracts (stored sign ignored)', txn: { type: 'WIT', asset_id: 'cash-gbp', cash_value: -200, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -200 }] },
  { name: 'FEE on CASH.USD in USD subtracts from USD', txn: { type: 'FEE', asset_id: 'cash-usd', cash_value: 5, cash_ccy: 'USD' }, expected: [{ currency: 'USD', balance: -5 }] },
  { name: 'FEE on a security has no cash effect (gated; see §15 item 1)', txn: { type: 'FEE', asset_id: 'sec-gbp', cash_value: 5, cash_ccy: 'GBP' }, expected: [] },

  // ---- OTR: signed, ungated ----
  { name: 'OTR -1.39 GBP on a security reduces cash (withholding-tax shape)', txn: { type: 'OTR', asset_id: 'sec-usd', cash_value: -1.39, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -1.39 }] },
  { name: 'OTR +0.02 GBP on CASH.GBP increases cash', txn: { type: 'OTR', asset_id: 'cash-gbp', cash_value: 0.02, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 0.02 }] },
  { name: 'OTR zero has no effect', txn: { type: 'OTR', asset_id: 'sec-gbp', cash_value: 0, cash_ccy: 'GBP' }, expected: [] },

  // ---- FXM: signed, ungated ----
  { name: 'FXM -12.34 GBP (realised FX loss) stays negative', txn: { type: 'FXM', asset_id: 'cash-gbp', cash_value: -12.34, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -12.34 }] },
  { name: 'FXM +8.00 GBP on a non-cash asset still applies (ungated)', txn: { type: 'FXM', asset_id: 'sec-gbp', cash_value: 8, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 8 }] },

  // ---- BUY / SELL: explicit abs(cash_value) in cash_ccy (default asset ccy); else qty*price+/-fee in asset ccy ----
  { name: 'BUY explicit cash 1005 GBP', txn: { type: 'BUY', asset_id: 'sec-gbp', quantity: 100, price: 10, fee: 5, cash_value: 1005, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -1005 }] },
  { name: 'BUY explicit negative cash is treated as a magnitude', txn: { type: 'BUY', asset_id: 'sec-gbp', quantity: 100, price: 10, fee: 5, cash_value: -1005, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: -1005 }] },
  { name: 'BUY explicit cash with null cash_ccy defaults to the ASSET currency', txn: { type: 'BUY', asset_id: 'sec-usd', quantity: 10, price: 150, fee: 2, cash_value: 1502, cash_ccy: null }, expected: [{ currency: 'USD', balance: -1502 }] },
  { name: 'BUY with null cash_value falls back to qty*price+fee in asset ccy', txn: { type: 'BUY', asset_id: 'sec-usd', quantity: 10, price: 150, fee: 2, cash_value: null }, expected: [{ currency: 'USD', balance: -1502 }] },
  { name: 'SELL explicit cash 477 GBP', txn: { type: 'SELL', asset_id: 'sec-gbp', quantity: 40, price: 12, fee: 3, cash_value: 477, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 477 }] },
  { name: 'SELL with null cash_value falls back to qty*price-fee (correct sign) in asset ccy', txn: { type: 'SELL', asset_id: 'sec-gbp', quantity: 40, price: 12, fee: 3, cash_value: null }, expected: [{ currency: 'GBP', balance: 477 }] },
  { name: 'SELL with null cash_value and zero fallback amount has no effect', txn: { type: 'SELL', asset_id: 'sec-gbp', quantity: 0, price: 12, fee: 0, cash_value: null }, expected: [] },

  // ---- TIN / TOT: CASH.* only, abs(cash_value) signed by type ----
  { name: 'TIN of CASH.GBP adds abs(cash_value)', txn: { type: 'TIN', asset_id: 'cash-gbp', cash_value: -300, cash_ccy: 'GBP' }, expected: [{ currency: 'GBP', balance: 300 }] },
  { name: 'TOT of CASH.USD subtracts abs(cash_value) in USD', txn: { type: 'TOT', asset_id: 'cash-usd', cash_value: 300, cash_ccy: 'USD' }, expected: [{ currency: 'USD', balance: -300 }] },
  { name: 'TIN of a security has no cash effect', txn: { type: 'TIN', asset_id: 'sec-gbp', quantity: 10, cash_value: 999, cash_ccy: 'GBP' }, expected: [] },

  // ---- no-cash types ----
  { name: 'SPL has no cash effect', txn: { type: 'SPL', asset_id: 'sec-gbp', split_factor: 2, cash_value: 50, cash_ccy: 'GBP' }, expected: [] },
  { name: 'an unknown type has no cash effect', txn: { type: 'XYZ', asset_id: 'cash-gbp', cash_value: 50, cash_ccy: 'GBP' }, expected: [] },
];

describe('cash parity — single transaction, every materially distinct branch (CURRENT behaviour)', () => {
  it.each(CASES)('$name', ({ txn, expected }) => {
    const t = tx(txn);
    const canonical = multi([t]);
    expect(canonical).toEqual(expected);
    expect(seriesNormalised([t])).toEqual(canonical);
  });
});

describe('cash parity — a mixed multi-currency sequence', () => {
  it('both engines produce the same final balances for a realistic mixed sequence', () => {
    const txns = [
      tx({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 10000, cash_ccy: 'GBP' }),
      tx({ type: 'BUY', asset_id: 'sec-gbp', quantity: 100, price: 10, fee: 5, cash_value: 1005, cash_ccy: 'GBP' }),
      tx({ type: 'BUY', asset_id: 'sec-usd', quantity: 10, price: 150, fee: 2, cash_value: 1185.98, cash_ccy: 'GBP' }),
      tx({ type: 'DIV', asset_id: 'sec-usd', cash_value: 3.1, cash_ccy: 'GBP' }),
      tx({ type: 'OTR', asset_id: 'sec-usd', cash_value: -0.47, cash_ccy: 'GBP' }),
      tx({ type: 'SELL', asset_id: 'sec-gbp', quantity: 40, price: 12, fee: 3, cash_value: 477, cash_ccy: 'GBP' }),
      tx({ type: 'FXM', asset_id: 'cash-gbp', cash_value: -1.23, cash_ccy: 'GBP' }),
      tx({ type: 'TOT', asset_id: 'cash-usd', cash_value: 50, cash_ccy: 'USD' }),
      tx({ type: 'FEE', asset_id: 'cash-gbp', cash_value: 2.5, cash_ccy: 'GBP' }),
      tx({ type: 'BAL', asset_id: 'cash-gbp', cash_value: 0.01, cash_ccy: 'GBP' }),
    ];
    const canonical = multi(txns);
    // 10000 - 1005 - 1185.98 + 3.10 - 0.47 + 477 - 1.23 - 2.50 + 0.01 = 8284.93
    expect(canonical).toEqual([
      { currency: 'GBP', balance: 8284.93 },
      { currency: 'USD', balance: -50 },
    ]);
    expect(seriesNormalised(txns)).toEqual(canonical);
  });
});

describe('cash parity — CURRENT DIFFERENCES between the two implementations (pinned, not hidden)', () => {
  it('output rounding: calculateCashBalancesMulti rounds to 2 dp once at the end; applyCashTxn accumulates unrounded', () => {
    const txns = [tx({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 10.004, cash_ccy: 'GBP' })];
    expect(multi(txns)).toEqual([{ currency: 'GBP', balance: 10 }]);
    expect(seriesRaw(txns).GBP).toBe(10.004);
  });

  it('zero buckets: calculateCashBalancesMulti drops them; applyCashTxn keeps every bucket in its map', () => {
    const txns = [tx({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 5, cash_ccy: 'GBP' })];
    expect(multi(txns).map((b) => b.currency)).toEqual(['GBP']);
    expect(Object.keys(seriesRaw(txns)).sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('requireCashAssetForCashRows:false exists only in calculateCashBalancesMulti; applyCashTxn always gates DEP/WIT/FEE on CASH.*', () => {
    const txns = [tx({ type: 'DEP', asset_id: 'sec-gbp', cash_value: 200, cash_ccy: 'GBP' })];
    expect(calculateCashBalancesMulti(txns, qMeta, { requireCashAssetForCashRows: false })).toEqual([{ currency: 'GBP', balance: 200 }]);
    expect(seriesNormalised(txns)).toEqual([]);
  });

  it('missing asset metadata: calculateCashBalancesMulti treats the row as a GBP non-cash asset; applyCashTxn requires metadata and throws', () => {
    const t = tx({ type: 'BUY', asset_id: 'no-such-asset', quantity: 1, price: 10, fee: 0, cash_value: null });
    expect(multi([t])).toEqual([{ currency: 'GBP', balance: -10 }]);
    expect(() => applyCashTxn(newCashMap() as any, undefined as any, t as STxn)).toThrow();
  });

  it('asOf filtering exists only in calculateCashBalancesMulti; applyCashTxn has no date concept (its caller filters)', () => {
    const txns = [
      tx({ type: 'DEP', asset_id: 'cash-gbp', date: '2024-06-01', cash_value: 100, cash_ccy: 'GBP' }),
      tx({ type: 'DEP', asset_id: 'cash-gbp', date: '2024-07-01', cash_value: 50, cash_ccy: 'GBP' }),
    ];
    expect(calculateCashBalancesMulti(txns, qMeta, { asOf: '2024-06-30' })).toEqual([{ currency: 'GBP', balance: 100 }]);
    expect(seriesRaw(txns).GBP).toBe(150);
  });
});
