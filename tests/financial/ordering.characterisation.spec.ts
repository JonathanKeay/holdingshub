// TRANSACTION ORDERING — the single shared replay ordering (Phase 2 Batch 1)
//
// src/lib/transactionOrdering.ts's compareTransactionsForReplay consolidates the
// three application comparator copies that this batch replaced (cleanup item B1,
// ACCOUNTING.md §15 item 23):
//   - src/lib/queries.ts                     live holdings replay (ranked FXM 99)
//   - src/lib/transferImportIntegration.ts   import-time parcel capture (FXM unlisted -> 1000)
//   - src/app/api/portfolio-series/route.ts  chart replay (FXM unlisted -> 1000)
// The shared rule is the queries.ts rule, unchanged. transferImportIntegration's
// exported name compareForReplay is kept as an alias of it. (Outside src/,
// scripts/price-streamer.ts still has its own copy; it is not covered here.)
//
// Adopting it changed the ORDER of FXM rows in the two non-queries.ts paths
// (FXM now ranks 99, alongside OTR, instead of last). The "FXM ordering change is
// output-inert" block proves that this does not change any holdings, parcel or
// chart-replay result, by replaying the same rows under the pre-unification
// ordering and the shared ordering.
//
// These tests describe CURRENT ordering.

import { describe, it, expect } from 'vitest';
import { compareTransactionsForReplay, TRANSACTION_TYPE_PRIORITY } from '../../src/lib/transactionOrdering';
import { compareForReplay, captureTransferOutsForGroup } from '../../src/lib/transferImportIntegration';
import { applyTransactionToHolding, type Txn } from '../../src/lib/queries';
import { applyCashTxn, newCashMap, isCashTicker, type AssetMeta as SeriesAssetMeta } from '../../src/lib/portfolio-series-cash';
import { makeTxn, makeHolding } from './helpers';

const SAME_DATE = '2024-05-01';
const SAME_CREATED = '2024-05-01T09:00:00.000Z';

function sameInstant(type: string, id: string, overrides: Partial<Txn> = {}): Txn {
  return makeTxn({ id, type, date: SAME_DATE, created_at: SAME_CREATED, ...overrides });
}

function order(txns: Txn[]): string[] {
  return [...txns].sort(compareTransactionsForReplay).map((t) => t.type);
}

describe('compareTransactionsForReplay — the shared ordering rule', () => {
  it('is the queries.ts rule exactly: the priority table is unchanged, including FXM 99', () => {
    expect(TRANSACTION_TYPE_PRIORITY).toEqual({
      SPL: 10, TIN: 20, BUY: 30, SELL: 40, TOT: 50, DIV: 90, INT: 95, FEE: 96, DEP: 97, WIT: 98, OTR: 99, FXM: 99, BAL: 100,
    });
  });

  it('transferImportIntegration.compareForReplay is the shared comparator, not a copy', () => {
    expect(compareForReplay).toBe(compareTransactionsForReplay);
  });

  it('same date and created_at: sorts by type priority SPL < TIN < BUY < SELL < TOT < DIV < INT < FEE < DEP < WIT < OTR < BAL', () => {
    const expected = ['SPL', 'TIN', 'BUY', 'SELL', 'TOT', 'DIV', 'INT', 'FEE', 'DEP', 'WIT', 'OTR', 'BAL'];
    // Reversed input, with ids that would sort the opposite way, so only type priority can produce the expected order.
    const input = [...expected].reverse().map((type, i) => sameInstant(type, `id-${String(i).padStart(2, '0')}`));
    expect(order(input)).toEqual(expected);
  });

  it('same-day BUY/SELL/TIN/TOT with identical created_at: entries (TIN, BUY) precede exits (SELL, TOT)', () => {
    const input = [sameInstant('TOT', 'a'), sameInstant('SELL', 'b'), sameInstant('BUY', 'c'), sameInstant('TIN', 'd')];
    expect(order(input)).toEqual(['TIN', 'BUY', 'SELL', 'TOT']);
  });

  it('created_at outranks type priority: a SELL created before a same-day BUY sorts first', () => {
    const sell = makeTxn({ id: 'z', type: 'SELL', date: SAME_DATE, created_at: '2024-05-01T09:00:00.000Z' });
    const buy = makeTxn({ id: 'a', type: 'BUY', date: SAME_DATE, created_at: '2024-05-01T09:00:00.001Z' });
    expect(order([buy, sell])).toEqual(['SELL', 'BUY']);
  });

  it('date outranks created_at', () => {
    const later = makeTxn({ id: 'a', type: 'BUY', date: '2024-05-02', created_at: '2024-01-01T00:00:00.000Z' });
    const earlier = makeTxn({ id: 'b', type: 'BUY', date: '2024-05-01', created_at: '2024-12-31T00:00:00.000Z' });
    expect([later, earlier].sort(compareTransactionsForReplay).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('identical date, created_at and type: id is the final tiebreak', () => {
    const input = [sameInstant('BUY', 'c'), sameInstant('BUY', 'a'), sameInstant('BUY', 'b')];
    expect([...input].sort(compareTransactionsForReplay).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('FXM ranks 99 alongside OTR (tie broken by id), before BAL; unlisted types still rank last (1000)', () => {
    expect(order([sameInstant('BAL', 'a'), sameInstant('FXM', 'c'), sameInstant('OTR', 'b')])).toEqual(['OTR', 'FXM', 'BAL']);
    expect(order([sameInstant('BAL', 'a'), sameInstant('OTR', 'c'), sameInstant('FXM', 'b')])).toEqual(['FXM', 'OTR', 'BAL']);
    expect(order([sameInstant('XYZ', 'a'), sameInstant('BAL', 'b'), sameInstant('FXM', 'c')])).toEqual(['FXM', 'BAL', 'XYZ']);
  });
});

// ---------------------------------------------------------------------------
// Proof that unification did not change any replay OUTPUT.
// ---------------------------------------------------------------------------

/**
 * Reference copy of the ordering used by transferImportIntegration.ts and the
 * portfolio-series route BEFORE unification: identical to the shared rule except
 * that FXM was not listed, so it ranked 1000 (after BAL). Kept here only to prove
 * equivalence; it is not used by application code.
 */
const PRE_UNIFICATION_PRIORITY: Record<string, number> = {
  SPL: 10, TIN: 20, BUY: 30, SELL: 40, TOT: 50, DIV: 90, INT: 95, FEE: 96, DEP: 97, WIT: 98, OTR: 99, BAL: 100,
};
function comparePreUnification(a: Txn, b: Txn): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const pa = PRE_UNIFICATION_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = PRE_UNIFICATION_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : 1;
}

const ids = (txns: Txn[]) => txns.map((t) => t.id);

describe('FXM ordering change is output-inert (pre-unification ordering vs shared ordering)', () => {
  // One security's same-instant history deliberately containing FXM, OTR and BAL rows,
  // with ids chosen so the two orderings genuinely differ. (Worst case: in real data FXM
  // rows sit on CASH.* tickers — see ACCOUNTING.md §1 — but here one is on the security.)
  const history = (): Txn[] => [
    makeTxn({ id: 'h0', asset_id: 'sec', type: 'BUY', date: '2024-04-30', created_at: SAME_CREATED, quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    sameInstant('FXM', 'a1', { asset_id: 'sec', cash_value: -1.5, cash_ccy: 'GBP' }),
    sameInstant('BAL', 'a0', { asset_id: 'sec', cash_value: 0.25, cash_ccy: 'GBP' }),
    sameInstant('OTR', 'a2', { asset_id: 'sec', cash_value: -0.5, cash_ccy: 'GBP' }),
    sameInstant('SELL', 'a3', { asset_id: 'sec', quantity: 40, price: 12, fee: 0, settle_value: 480, settle_ccy: 'GBP', cash_value: 480, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    sameInstant('TOT', 'a4', { asset_id: 'sec', quantity: 10 }),
    sameInstant('XYZ', 'a5', { asset_id: 'sec' }),
  ];

  it('the two orderings really do differ for these rows (so the proofs below are not vacuous)', () => {
    const pre = ids([...history()].sort(comparePreUnification));
    const shared = ids([...history()].sort(compareTransactionsForReplay));
    expect(pre).not.toEqual(shared);
    expect(pre).toEqual(['h0', 'a3', 'a4', 'a2', 'a0', 'a1', 'a5']); // FXM (a1) after BAL
    expect(shared).toEqual(['h0', 'a3', 'a4', 'a1', 'a2', 'a0', 'a5']); // FXM ranks with OTR (tie by id)
  });

  it('holdings replay (native + Definition B) is identical under both orderings', () => {
    const replay = (cmp: (a: Txn, b: Txn) => number) => {
      const h = makeHolding({ asset_id: 'sec', ticker: 'VOD.L', currency: 'GBP', base_currency: 'GBP' });
      for (const t of [...history()].sort(cmp)) applyTransactionToHolding(h, t);
      return h;
    };
    const pre = replay(comparePreUnification);
    const shared = replay(compareTransactionsForReplay);
    expect(shared).toEqual(pre);
    expect(shared).toMatchObject({ total_shares: 50, total_cost: 500 }); // sanity: the replay did real work
  });

  it('import-time parcel capture (captureTransferOutsForGroup) produces the identical parcel under both orderings', () => {
    const capture = (cmp: (a: Txn, b: Txn) => number) =>
      captureTransferOutsForGroup([...history()].sort(cmp), new Set(['a4']), { assetId: 'sec', ticker: 'VOD.L', currency: 'GBP' });
    const pre = capture(comparePreUnification);
    const shared = capture(compareTransactionsForReplay);
    expect(shared).toEqual(pre);
    expect(shared.newTransferRows[0].native_cost).toBeCloseTo(100, 6); // sanity: 10 of 60 shares at avg 10.00
  });

  it('chart replay is identical: the share-changing row sequence per ticker and the applyCashTxn cash map', () => {
    const meta: Record<string, SeriesAssetMeta> = {
      sec: { id: 'sec', ticker: 'VOD.L', currency: 'GBP', status: 'active', resolved_ticker: 'VOD.L', price_multiplier: 1 },
      cash: { id: 'cash', ticker: 'CASH.GBP', currency: 'GBP', status: 'active', resolved_ticker: 'CASH.GBP', price_multiplier: 1 },
    };
    const rows = (): Txn[] => [
      ...history(),
      // The real-data shape: an FXM row on the CASH.* ticker, same instant as a BAL on it.
      sameInstant('FXM', 'c1', { asset_id: 'cash', cash_value: -2.5, cash_ccy: 'GBP' }),
      sameInstant('BAL', 'c0', { asset_id: 'cash', cash_value: 4, cash_ccy: 'GBP' }),
    ];
    // Mirrors portfolio-series/route.ts: cash for every row; shares only for non-cash tickers,
    // and only BUY/SELL/TIN/TOT/SPL change shares (applyHoldingTxn).
    const replay = (cmp: (a: Txn, b: Txn) => number) => {
      const cash = newCashMap();
      const shareRows: Record<string, string[]> = {};
      for (const t of [...rows()].sort(cmp)) {
        applyCashTxn(cash, meta[t.asset_id], t as any);
        if (isCashTicker(meta[t.asset_id].ticker)) continue;
        if (['BUY', 'SELL', 'TIN', 'TOT', 'SPL'].includes(t.type)) (shareRows[t.asset_id] ||= []).push(t.id);
      }
      return { cash, shareRows };
    };
    expect(ids([...rows()].sort(comparePreUnification))).not.toEqual(ids([...rows()].sort(compareTransactionsForReplay)));
    expect(replay(compareTransactionsForReplay)).toEqual(replay(comparePreUnification));
  });
});
