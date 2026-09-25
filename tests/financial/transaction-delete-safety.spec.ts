// TRANSACTION DELETE SAFETY — src/lib/transactionDeleteSafety.ts
//
// Financial transactions are immutable after creation/import; a wrong row is
// deleted and the corrected one added/imported. These tests pin the rules that
// decide when a delete is safe, and prove the preview and the "delete then
// re-add" model agree with the live engine (getPortfoliosWithHoldingsAndCash).
// No database, no network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPortfoliosWithHoldingsAndCash, type AssetMeta, type Txn } from '../../src/lib/queries';
import {
  assessTransactionDelete,
  type DeleteAssessment,
  type TransferRecord,
} from '../../src/lib/transactionDeleteSafety';
import { createFakeSupabase, type FakeRow } from './fakeSupabase';

const ASSET_ROWS: FakeRow[] = [
  { id: 'a-vod', ticker: 'VOD.L', name: 'Vodafone', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-bp', ticker: 'BP.L', name: 'BP', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-aapl', ticker: 'AAPL', name: 'Apple', currency: 'USD', logo_url: null, status: 'active' },
  { id: 'a-cash-gbp', ticker: 'CASH.GBP', name: 'Cash GBP', currency: 'GBP', logo_url: null, status: 'active' },
];
const ASSET_META: Record<string, AssetMeta> = Object.fromEntries(
  ASSET_ROWS.map((a) => [a.id, { ticker: a.ticker, currency: a.currency }])
);
const PORTFOLIOS = [
  { id: 'p1', name: 'SRC', base_currency: 'GBP' },
  { id: 'p2', name: 'DST', base_currency: 'GBP' },
];

const IMPORT_BATCH = '2026-09-12T07:00:00+00:00';
const LATER_BATCH = '2026-09-26T09:00:00+00:00';
const day = (d: string) => `${d}T00:00:00+00:00`;

let n = 0;
function tx(o: Partial<Txn>): Txn {
  n += 1;
  return {
    id: `t${String(n).padStart(4, '0')}`,
    portfolio_id: 'p1',
    asset_id: 'a-vod',
    type: 'BUY',
    date: day('2024-01-01'),
    created_at: IMPORT_BATCH,
    quantity: null,
    price: null,
    fee: null,
    cash_value: null,
    cash_ccy: null,
    cash_fx_to_portfolio: null,
    settle_value: null,
    settle_ccy: null,
    split_factor: null,
    ...o,
  };
}
const buy = (o: Partial<Txn> = {}) =>
  tx({ type: 'BUY', quantity: 10, price: 10, fee: 5, cash_value: 105, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, settle_value: 105, settle_ccy: 'GBP', ...o });
const sell = (o: Partial<Txn> = {}) =>
  tx({ type: 'SELL', quantity: 10, price: 15, fee: 5, cash_value: 145, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, settle_value: 155, settle_ccy: 'GBP', ...o });
const cashRow = (type: string, cash_value: number, o: Partial<Txn> = {}) =>
  tx({ asset_id: 'a-cash-gbp', type, quantity: 1, price: Math.abs(cash_value), cash_value, cash_ccy: 'GBP', settle_value: Math.abs(cash_value), settle_ccy: 'GBP', ...o });
const split = (factor: number, o: Partial<Txn> = {}) =>
  tx({ type: 'SPL', split_factor: factor, quantity: 0, price: 0, fee: 0, settle_value: 0, settle_ccy: 'GBP', ...o });
const tin = (o: Partial<Txn> = {}) =>
  tx({ type: 'TIN', quantity: 10, price: 0, fee: 0, cash_value: 0, cash_ccy: 'GBP', settle_value: 0, settle_ccy: 'GBP', ...o });
const tot = (o: Partial<Txn> = {}) =>
  tx({ type: 'TOT', quantity: 10, price: 0, fee: 0, cash_value: 0, cash_ccy: 'GBP', settle_value: 0, settle_ccy: 'GBP', ...o });

function assess(target: Txn, rows: Txn[], transfers: TransferRecord[] | null = []): DeleteAssessment {
  return assessTransactionDelete({
    target,
    portfolioTxns: rows.filter((r) => r.portfolio_id === target.portfolio_id),
    assetMeta: ASSET_META,
    transfers,
    baseCurrency: 'GBP',
  });
}
const codes = (a: DeleteAssessment) => a.reasons.map((r) => r.code);

async function engine(rows: Txn[], transfers: FakeRow[] = []) {
  const fake = createFakeSupabase({ portfolios: PORTFOLIOS, assets: ASSET_ROWS, transactions: rows, transfers });
  return getPortfoliosWithHoldingsAndCash(fake.client);
}
async function cashOf(rows: Txn[], pid = 'p1') {
  const res = await engine(rows);
  const p = res.find((r) => r.portfolio.id === pid)!;
  return Object.fromEntries(p.cash_balances.map((c) => [c.currency, c.balance])) as Record<string, number>;
}
async function sharesOf(rows: Txn[], ticker: string, pid = 'p1', transfers: FakeRow[] = []) {
  const res = await engine(rows, transfers);
  return res.find((r) => r.portfolio.id === pid)!.holdings.find((h) => h.ticker === ticker)?.total_shares ?? 0;
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is not allowed in delete-safety tests');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('cash-only transactions', () => {
  it.each([
    ['DEP on CASH.GBP', () => cashRow('DEP', 1000)],
    ['WIT on CASH.GBP', () => cashRow('WIT', 200)],
    ['FEE on CASH.GBP', () => cashRow('FEE', 3)],
    ['INT on CASH.GBP', () => cashRow('INT', 1.5)],
    ['FXM on CASH.GBP', () => cashRow('FXM', -3.3)],
    ['BAL on CASH.GBP', () => cashRow('BAL', 12.34)],
    ['cash TIN on CASH.GBP', () => cashRow('TIN', 500)],
    ['cash TOT on CASH.GBP', () => cashRow('TOT', 500)],
    ['DIV on a security', () => tx({ type: 'DIV', quantity: 1, price: 7, cash_value: 7, cash_ccy: 'GBP' })],
    ['OTR on a security', () => tx({ type: 'OTR', quantity: 1, price: 1.39, cash_value: -1.39, cash_ccy: 'GBP' })],
    ['FEE on a security', () => tx({ type: 'FEE', quantity: 0, price: 0, fee: 2, cash_value: 2, cash_ccy: 'GBP' })],
  ])('%s can be deleted, with no holding projection', (_label, make) => {
    const target = make();
    const rows = [buy(), sell({ date: day('2024-03-01') }), target];
    const a = assess(target, rows);
    expect(a.allowed).toBe(true);
    expect(a.reasons).toEqual([]);
    expect(a.holding).toBeNull();
  });

  it('a cash row is still allowed on the same day as an opposite-direction trade (cash is order-independent)', () => {
    const b = buy();
    const s = sell();
    const d = tx({ type: 'DIV', quantity: 1, price: 7, cash_value: 7, cash_ccy: 'GBP' });
    // The BUY/SELL pair itself is blocked; the DIV is not.
    expect(assess(d, [b, s, d]).allowed).toBe(true);
  });
});

describe('BUY / SELL whose resulting history stays valid', () => {
  it('deleting one of several BUYs that still cover every later SELL is allowed', () => {
    const b1 = buy({ quantity: 10 });
    const b2 = buy({ date: day('2024-01-10'), quantity: 5, cash_value: 55, settle_value: 55 });
    const s = sell({ date: day('2024-02-01'), quantity: 10 });
    const a = assess(b2, [b1, b2, s]);
    expect(a.allowed).toBe(true);
    expect(a.holding).toEqual({ ticker: 'VOD.L', sharesWithRow: 5, sharesWithoutRow: 0 });
  });

  it('deleting a SELL is allowed (it can only leave more shares later)', () => {
    const b = buy({ quantity: 20, cash_value: 205, settle_value: 205 });
    const s1 = sell({ date: day('2024-02-01'), quantity: 5 });
    const s2 = sell({ date: day('2024-03-01'), quantity: 10 });
    const a = assess(s1, [b, s1, s2]);
    expect(a.allowed).toBe(true);
    expect(a.holding).toEqual({ ticker: 'VOD.L', sharesWithRow: 5, sharesWithoutRow: 10 });
  });

  it('deleting the only BUY of a holding with no later disposals is allowed', () => {
    const b = buy();
    expect(assess(b, [b]).allowed).toBe(true);
  });

  it('another holding in the same portfolio does not affect the assessment', () => {
    const b = buy();
    const bpSell = sell({ asset_id: 'a-bp', date: day('2024-01-01') });
    expect(assess(b, [b, bpSell]).allowed).toBe(true);
  });
});

describe('WOULD_OVERSELL — delete blocked when the projected holding is invalid', () => {
  it('deleting a BUY that a later SELL depends on is blocked, with a readable reason', () => {
    const b = buy();
    const s = sell({ date: day('2024-02-01') });
    const a = assess(b, [b, s]);
    expect(a.allowed).toBe(false);
    expect(codes(a)).toEqual(['WOULD_OVERSELL']);
    expect(a.reasons[0].message).toContain('SELL of 10 VOD.L on 2024-02-01');
    expect(a.reasons[0].message).toContain('(0)');
  });

  it('a partial shortfall is blocked too (sell 10 when only 6 would remain)', () => {
    const b1 = buy({ quantity: 6, cash_value: 65, settle_value: 65 });
    const b2 = buy({ date: day('2024-01-10'), quantity: 4, cash_value: 45, settle_value: 45 });
    const s = sell({ date: day('2024-02-01'), quantity: 10 });
    const a = assess(b2, [b1, b2, s]);
    expect(codes(a)).toEqual(['WOULD_OVERSELL']);
    expect(a.reasons[0].message).toContain('(6)');
  });

  it('a later TOT (unlinked) that would be oversold also blocks', () => {
    const b = buy();
    const t = tot({ date: day('2024-02-01') });
    expect(codes(assess(b, [b, t]))).toEqual(['WOULD_OVERSELL']);
  });

  it('an oversell that already exists in the history is not blamed on an unrelated delete', () => {
    // Legacy data: SELL 15 with only 10 held (already oversold before any delete).
    const b = buy();
    const legacy = sell({ date: day('2024-02-01'), quantity: 15 });
    const later = buy({ date: day('2024-06-01'), quantity: 3, cash_value: 35, settle_value: 35 });
    const a = assess(later, [b, legacy, later]);
    expect(a.allowed).toBe(true);
  });

  it('removing a legacy-unlinked TIN that later disposals depend on is blocked', () => {
    const t = tin({ settle_value: 100 });
    const s = sell({ date: day('2024-02-01') });
    expect(codes(assess(t, [t, s]))).toEqual(['WOULD_OVERSELL']);
  });
});

describe('SAME_DAY_ORDERING — replacement could not be replayed in its original position', () => {
  it('BUY sharing its day with a SELL of the same holding is blocked (the HVO/SPCE shape)', () => {
    const b = buy();
    const s = sell();
    const a = assess(b, [b, s]);
    expect(codes(a)).toContain('SAME_DAY_ORDERING');
    expect(a.allowed).toBe(false);
    expect(a.reasons.find((r) => r.code === 'SAME_DAY_ORDERING')!.message).toContain('SELL of VOD.L on 2024-01-01');
  });

  it('the SELL of that same-day pair is blocked too', () => {
    const b = buy();
    const s = sell();
    expect(codes(assess(s, [b, s]))).toEqual(['SAME_DAY_ORDERING']);
  });

  it('TIN sharing its day with a SELL is blocked (the TJX shape)', () => {
    const t = tin({ settle_value: 100 });
    const s = sell();
    expect(codes(assess(s, [t, s]))).toEqual(['SAME_DAY_ORDERING']);
  });

  it('same-day rows match on calendar day even when the times differ (Add form stores 12:00 UTC)', () => {
    const b = buy({ date: '2024-01-01T12:00:00+00:00' });
    const s = sell();
    expect(codes(assess(b, [b, s]))).toContain('SAME_DAY_ORDERING');
  });

  it('two BUYs on the same day are not blocked (order does not change average cost)', () => {
    const b1 = buy();
    const b2 = buy({ quantity: 5, cash_value: 55, settle_value: 55 });
    expect(assess(b2, [b1, b2]).allowed).toBe(true);
  });

  it('two SELLs on the same day are not blocked', () => {
    const b = buy({ quantity: 20, cash_value: 205, settle_value: 205 });
    const s1 = sell({ date: day('2024-02-01'), quantity: 5 });
    const s2 = sell({ date: day('2024-02-01'), quantity: 5 });
    expect(assess(s1, [b, s1, s2]).allowed).toBe(true);
  });

  it('a SELL of a DIFFERENT holding on the same day does not block', () => {
    const b = buy();
    const s = sell({ asset_id: 'a-bp' });
    expect(assess(b, [b, s]).allowed).toBe(true);
  });

  it('a SPL sharing its day with a BUY blocks both', () => {
    const b = buy();
    const sp = split(2);
    expect(codes(assess(sp, [b, sp]))).toContain('SAME_DAY_ORDERING');
    expect(codes(assess(b, [b, sp]))).toContain('SAME_DAY_ORDERING');
  });

  it('proves the risk: the engine gives a different result when the BUY is re-added after a same-day SELL', async () => {
    const d = cashRow('DEP', 1000);
    const wrong = buy({ price: 12, cash_value: 125, settle_value: 125 });
    const s = sell();
    const fixed = buy({ created_at: LATER_BATCH });
    const always = await engine([d, { ...fixed, id: wrong.id, created_at: IMPORT_BATCH }, s]);
    const replaced = await engine([d, s, fixed]);
    const vod = (r: typeof always) => r[0].holdings.find((h) => h.ticker === 'VOD.L')!;
    expect(vod(always).total_shares).toBe(0);
    expect(vod(replaced).total_shares).toBe(10);
    expect(codes(assess(wrong, [d, wrong, s]))).toContain('SAME_DAY_ORDERING');
  });
});

describe('TRANSFER_LINKED — rows referenced by a transfers record', () => {
  const statuses: [string, 'in' | 'out'][] = [
    ['matched', 'in'],
    ['matched', 'out'],
    ['external_in', 'in'],
    ['external_out', 'out'],
    ['pending_in', 'in'],
    ['pending_out', 'out'],
  ];
  it.each(statuses)('%s (%s leg) is blocked with a readable, non-technical message', (status, leg) => {
    const target = leg === 'in' ? tin({ date: day('2024-05-01') }) : tot({ date: day('2024-05-01') });
    const rows = leg === 'out' ? [buy(), target] : [target];
    const record: TransferRecord = {
      id: 'tr1',
      status,
      out_transaction_id: leg === 'out' ? target.id : null,
      in_transaction_id: leg === 'in' ? target.id : null,
      quantity: 10,
      native_cost: status === 'pending_in' ? null : 100,
      native_ccy: status === 'pending_in' ? null : 'GBP',
    };
    const a = assess(target, rows, [record]);
    expect(a.allowed).toBe(false);
    expect(codes(a)).toContain('TRANSFER_LINKED');
    expect(a.transferLink).toEqual({ transferId: 'tr1', status, leg });
    const msg = a.reasons.find((r) => r.code === 'TRANSFER_LINKED')!.message;
    expect(msg).toContain(`status: ${status}`);
    expect(msg).toContain(leg === 'out' ? 'outgoing' : 'incoming');
    expect(msg).not.toMatch(/foreign key|constraint|violates|transfers_(in|out)_transaction_id/i);
  });

  it('a CASH.* transfer row with no transfers record is not blocked', () => {
    const c = cashRow('TIN', 500);
    const a = assess(c, [c], [{ id: 'x', status: 'matched', out_transaction_id: 'other-out', in_transaction_id: 'other-in' }]);
    expect(a.allowed).toBe(true);
    expect(a.transferLink).toBeNull();
  });
});

describe('FEEDS_TRANSFER_OUT — earlier history frozen into a later transfer-out', () => {
  function transferred() {
    const b1 = buy({ quantity: 10, fee: 0, cash_value: 100, settle_value: 100 });
    const b2 = buy({ date: day('2024-01-15'), quantity: 10, price: 20, fee: 0, cash_value: 200, settle_value: 200 });
    const out = tot({ date: day('2024-03-01') });
    const inn = tin({ portfolio_id: 'p2', date: day('2024-03-01') });
    const record: TransferRecord = {
      id: 'tr',
      status: 'matched',
      out_transaction_id: out.id,
      in_transaction_id: inn.id,
      quantity: 10,
      native_cost: 150,
      native_ccy: 'GBP',
      base_cost: 150,
      base_ccy: 'GBP',
    };
    return { b1, b2, out, inn, record, rows: [b1, b2, out, inn] };
  }

  it('a BUY before a linked TOT of the same holding is blocked', () => {
    const { b2, rows, record } = transferred();
    const a = assess(b2, rows, [record]);
    expect(codes(a)).toEqual(['FEEDS_TRANSFER_OUT']);
    expect(a.reasons[0].message).toContain('transferred out of this portfolio (2024-03-01)');
  });

  it('a SPL before a linked TOT is blocked', () => {
    const { rows, record } = transferred();
    const sp = split(1, { date: day('2024-02-01') });
    expect(codes(assess(sp, [...rows, sp], [record]))).toContain('FEEDS_TRANSFER_OUT');
  });

  it('a pending_out TOT (parcel already frozen at import) blocks earlier history too', () => {
    const { b2, rows, record } = transferred();
    const pending = { ...record, status: 'pending_out', in_transaction_id: null };
    expect(codes(assess(b2, rows, [pending]))).toEqual(['FEEDS_TRANSFER_OUT']);
  });

  it('a BUY after the transfer-out is allowed', () => {
    const { rows, record } = transferred();
    const after = buy({ date: day('2024-06-01'), quantity: 3, cash_value: 35, settle_value: 35 });
    expect(assess(after, [...rows, after], [record]).allowed).toBe(true);
  });

  it('an unlinked (legacy) TOT does not freeze earlier history', () => {
    const b1 = buy({ quantity: 20, cash_value: 205, settle_value: 205 });
    const b2 = buy({ date: day('2024-01-15'), quantity: 5, cash_value: 55, settle_value: 55 });
    const out = tot({ date: day('2024-03-01') });
    expect(assess(b2, [b1, b2, out], []).allowed).toBe(true);
  });

  it('destination-side history is not frozen by the incoming leg', () => {
    const { rows, record } = transferred();
    const destBuy = buy({ portfolio_id: 'p2', date: day('2024-01-05'), quantity: 2, cash_value: 25, settle_value: 25 });
    expect(assess(destBuy, [...rows, destBuy], [record]).allowed).toBe(true);
  });

  it('proves the risk: replacing that earlier BUY leaves source and destination costs out of step', async () => {
    const { b1, b2, out, inn, record } = transferred();
    const fixed = buy({ date: b2.date, created_at: LATER_BATCH, quantity: 10, price: 30, fee: 0, cash_value: 300, settle_value: 300 });
    const res = await engine([b1, out, inn, fixed], [record as FakeRow]);
    const src = res.find((r) => r.portfolio.id === 'p1')!.holdings.find((h) => h.ticker === 'VOD.L')!;
    const dst = res.find((r) => r.portfolio.id === 'p2')!.holdings.find((h) => h.ticker === 'VOD.L')!;
    expect(src.total_cost).not.toBe(src.base_total_cost);
    expect(dst.total_cost).toBe(150);
  });
});

describe('SPL delete safety', () => {
  it('deleting a forward split that later SELLs depend on is blocked', () => {
    const b = buy();
    const sp = split(5, { date: day('2024-06-01') });
    const s = sell({ date: day('2024-07-01'), quantity: 50, price: 3, cash_value: 145, settle_value: 155 });
    const a = assess(sp, [b, sp, s]);
    expect(codes(a)).toEqual(['WOULD_OVERSELL']);
  });

  it('deleting a forward split with no later disposals is allowed, and the projection shows the share change', () => {
    const b = buy();
    const sp = split(5, { date: day('2024-06-01') });
    const a = assess(sp, [b, sp]);
    expect(a.allowed).toBe(true);
    expect(a.holding).toEqual({ ticker: 'VOD.L', sharesWithRow: 50, sharesWithoutRow: 10 });
    expect(a.cashEffect).toEqual([]);
  });

  it('deleting a reverse split is allowed (it only leaves more shares)', () => {
    const b = buy();
    const sp = split(0.5, { date: day('2024-06-01') });
    const s = sell({ date: day('2024-07-01'), quantity: 5 });
    expect(assess(sp, [b, sp, s]).allowed).toBe(true);
  });
});

describe('CANNOT_ASSESS — fail closed', () => {
  it('blocks when transfer records could not be read', () => {
    const d = cashRow('DEP', 1000);
    const a = assess(d, [d], null);
    expect(a.allowed).toBe(false);
    expect(codes(a)).toEqual(['CANNOT_ASSESS']);
    expect(a.reasons[0].message).toContain('Transfer records could not be read');
  });

  it('blocks when the security is unknown', () => {
    const orphan = buy({ asset_id: 'a-missing' });
    const a = assess(orphan, [orphan]);
    expect(a.allowed).toBe(false);
    expect(codes(a)).toEqual(['CANNOT_ASSESS']);
  });

  it('a row can carry several reasons at once', () => {
    const b = buy();
    const s = sell();
    const later = sell({ date: day('2024-02-01'), quantity: 1 });
    const bb = buy({ quantity: 1, cash_value: 15, settle_value: 15 });
    const a = assess(b, [b, s, bb, later]);
    expect(codes(a).sort()).toEqual(['SAME_DAY_ORDERING', 'WOULD_OVERSELL']);
  });
});

describe('cash-effect preview matches the engine', () => {
  const cases: [string, () => Txn][] = [
    ['GBP BUY', () => buy({ date: day('2024-02-02') })],
    ['GBP SELL', () => sell({ date: day('2024-03-03'), quantity: 2 })],
    ['USD BUY with GBP cash leg', () => tx({ asset_id: 'a-aapl', type: 'BUY', quantity: 2, price: 100, fee: 1, cash_value: 160.8, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8, settle_value: 201, settle_ccy: 'USD', date: day('2024-02-05') })],
    ['BUY with NULL cash_value (asset-currency fallback)', () => tx({ asset_id: 'a-aapl', type: 'BUY', quantity: 1, price: 50, fee: 0, date: day('2024-02-06') })],
    ['DIV', () => tx({ type: 'DIV', quantity: 1, price: 7, cash_value: 7.25, cash_ccy: 'GBP' })],
    ['negative-stored DIV (sign ignored, C3)', () => tx({ type: 'DIV', quantity: 1, price: 7, cash_value: -7.25, cash_ccy: 'GBP' })],
    ['OTR negative', () => tx({ type: 'OTR', quantity: 1, price: 1.39, cash_value: -1.39, cash_ccy: 'GBP' })],
    ['FXM', () => cashRow('FXM', -3.3)],
    ['BAL', () => cashRow('BAL', 12.34)],
    ['WIT', () => cashRow('WIT', 200)],
    ['FEE on CASH.GBP', () => cashRow('FEE', 3)],
    ['FEE on a security (no cash effect)', () => tx({ type: 'FEE', fee: 2, cash_value: 2, cash_ccy: 'GBP' })],
    ['DEP on a security (no cash effect)', () => tx({ type: 'DEP', cash_value: 50, cash_ccy: 'GBP' })],
    ['SPL', () => split(2, { date: day('2024-02-07') })],
    ['cash TIN', () => cashRow('TIN', 500)],
  ];

  it.each(cases)('%s: cash before minus cash after deleting == the previewed effect', async (_label, make) => {
    const base = [cashRow('DEP', 10000), buy({ quantity: 20, cash_value: 205, settle_value: 205 })];
    const target = make();
    const rows = [...base, target];
    const before = await cashOf(rows);
    const after = await cashOf(base);
    const preview = assess(target, rows).cashEffect;
    const ccys = new Set([...Object.keys(before), ...Object.keys(after), ...preview.map((p) => p.currency)]);
    for (const c of ccys) {
      const engineDelta = Math.round(((before[c] ?? 0) - (after[c] ?? 0)) * 100) / 100;
      const previewAmount = preview.find((p) => p.currency === c)?.amount ?? 0;
      expect(previewAmount).toBeCloseTo(engineDelta, 2);
    }
  });
});

describe('holding projection matches the engine', () => {
  it('sharesWithRow / sharesWithoutRow equal the engine totals with and without the row', async () => {
    const b1 = buy({ quantity: 12 });
    const sp = split(3, { date: day('2024-03-01') });
    const b2 = buy({ date: day('2024-04-01'), quantity: 4, cash_value: 45, settle_value: 45 });
    const s = sell({ date: day('2024-05-01'), quantity: 7 });
    const rows = [b1, sp, b2, s];
    const a = assess(b2, rows);
    expect(a.holding!.sharesWithRow).toBe(await sharesOf(rows, 'VOD.L'));
    expect(a.holding!.sharesWithoutRow).toBe(await sharesOf([b1, sp, s], 'VOD.L'));
  });
});

describe('delete then re-add equivalence for safe cases', () => {
  async function snapshot(rows: Txn[]) {
    const res = await engine(rows);
    return res.map((p) => ({
      id: p.portfolio.id,
      cash: p.cash_balances,
      holdings: p.holdings.map((h) => ({
        t: h.ticker,
        sh: h.total_shares,
        cost: h.total_cost,
        real: h.realised_value,
        bCost: h.base_total_cost,
        bReal: h.base_realised_value,
      })),
    }));
  }

  // deleteFirst: whether the wrong row can be deleted BEFORE the correction is
  // added. A BUY that a later SELL depends on cannot (the SELL would be oversold
  // in between), so its correction is added first and the wrong row deleted after.
  // A split is the reverse: delete first, then re-import the corrected split.
  const scenarios: [string, () => { rows: Txn[]; wrong: Txn; correct: Partial<Txn>; deleteFirst: boolean; addFirst?: boolean }][] = [
    ['BUY with the wrong price, later SELL depends on it (add correction first)', () => {
      const wrong = buy({ price: 12, cash_value: 125, settle_value: 125 });
      return { rows: [cashRow('DEP', 5000), wrong, sell({ date: day('2024-02-01') })], wrong, correct: { price: 10, cash_value: 105, settle_value: 105 }, deleteFirst: false };
    }],
    ['BUY with the wrong price, no dependent SELL', () => {
      const wrong = buy({ date: day('2024-02-05'), price: 12, cash_value: 125, settle_value: 125 });
      return { rows: [cashRow('DEP', 5000), buy(), sell({ date: day('2024-02-01') }), wrong], wrong, correct: { price: 10, cash_value: 105, settle_value: 105 }, deleteFirst: true };
    }],
    ['SELL with the wrong quantity', () => {
      const wrong = sell({ date: day('2024-02-01'), quantity: 4, cash_value: 55, settle_value: 65 });
      return { rows: [cashRow('DEP', 5000), buy(), wrong], wrong, correct: { quantity: 5, cash_value: 70, settle_value: 80 }, deleteFirst: true };
    }],
    ['DIV with the wrong amount', () => {
      const wrong = tx({ type: 'DIV', date: day('2024-03-01'), quantity: 1, price: 9, cash_value: 9, cash_ccy: 'GBP' });
      return { rows: [cashRow('DEP', 5000), buy(), wrong], wrong, correct: { cash_value: 7, price: 7 }, deleteFirst: true };
    }],
    ['OTR with the wrong sign', () => {
      const wrong = tx({ type: 'OTR', date: day('2024-03-01'), quantity: 1, price: 1.39, cash_value: 1.39, cash_ccy: 'GBP' });
      return { rows: [cashRow('DEP', 5000), buy(), wrong], wrong, correct: { cash_value: -1.39 }, deleteFirst: true };
    }],
    ['SPL with the wrong ratio, re-imported on the same date', () => {
      const wrong = split(3, { date: day('2024-06-01') });
      return { rows: [buy(), wrong], wrong, correct: { split_factor: 2 }, deleteFirst: true, addFirst: false };
    }],
    ['cross-currency BUY with the wrong cash leg', () => {
      const wrong = tx({ asset_id: 'a-aapl', type: 'BUY', quantity: 2, price: 100, fee: 0, cash_value: 170, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.85, settle_value: 200, settle_ccy: 'USD', date: day('2024-02-10') });
      return { rows: [cashRow('DEP', 5000), wrong], wrong, correct: { cash_value: 160, cash_fx_to_portfolio: 0.8 }, deleteFirst: true };
    }],
  ];

  it.each(scenarios)('%s: delete + re-add == always correct', async (_label, build) => {
    const { rows, wrong, correct, deleteFirst, addFirst = true } = build();
    const replacement = { ...wrong, ...correct, id: 'replacement', created_at: LATER_BATCH };
    expect(assess(wrong, rows).allowed).toBe(deleteFirst);
    // With the correction already added, deleting the wrong row is allowed —
    // except a split, whose same-day correction would itself trip SAME_DAY_ORDERING.
    expect(assess(wrong, [...rows, replacement]).allowed).toBe(addFirst);
    const alwaysCorrect = rows.map((r) => (r.id === wrong.id ? { ...r, ...correct } : r));
    const replaced = [...rows.filter((r) => r.id !== wrong.id), replacement];
    expect(await snapshot(replaced)).toEqual(await snapshot(alwaysCorrect));
  });
});
