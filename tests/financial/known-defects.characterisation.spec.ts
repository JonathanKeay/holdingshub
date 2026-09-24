// KNOWN-DEFECT CHARACTERISATION MARKERS (Phase 0 safety net)
//
// !!! These tests pin CURRENT behaviour that has been identified as a
// !!! probable defect. A passing test here does NOT mean the behaviour is
// !!! correct or approved — it means it has not changed.
//
// Purpose: every behavioural fix must be a deliberate, reviewed decision. If a
// test in this file fails, either
//   (a) a change has altered financial behaviour unintentionally — revert it; or
//   (b) an explicitly approved fix for that defect ID has landed — update the
//       matching marker IN THE SAME COMMIT as the fix, rewriting it to assert
//       the new, approved behaviour and citing the decision.
// Never "fix" a failure here by adjusting the expected number alone.
//
// Defect IDs match the HoldingsHub cleanup discovery plan (2026-09-24):
//   C1  FIXED 2026-09-24: SELL write-time fallback now uses qty*price - fee (net proceeds)
//   C3  negative DIV/INT/DEP cash_value increases cash (docs/ACCOUNTING.md §15 item 11)
//   C5  import-time TOT parcel capture ignores earlier resolved TIN parcels
//   C9  gated row with qty*price+fee = 0 is blocked despite an explicit cash_value
//   C11 SELL implied FX = cash_value / (qty*price + fee), biased low by the fee
//   C12 cash_ccy outside GBP/USD/EUR produces NaN; the canonical engine then drops it
// See docs/ACCOUNTING.md §2, §8, §14 and §15 for the surrounding behaviour.

import { describe, it, expect } from 'vitest';
import { resolveCashLeg, resolveRowCashLeg } from '../../src/lib/cashLeg';
import {
  applyTransactionToHolding,
  applyTransactionToHoldingResolvingTransfers,
  calculateCashBalancesMulti,
  type Holding,
} from '../../src/lib/queries';
import { applyCashTxn, newCashMap, type AssetMeta as SAssetMeta, type Txn as STxn } from '../../src/lib/portfolio-series-cash';
import { captureTransferOutsForGroup } from '../../src/lib/transferImportIntegration';
import {
  indexResolvedTransfersByTinTransactionId,
  type ResolvedTransferForReplay,
} from '../../src/lib/holdingsTransferIntegration';
import { makeTxn, makeHolding, assetMetaFor } from './helpers';

const KD = 'CURRENT BEHAVIOUR — KNOWN DEFECT';

// ---------------------------------------------------------------------------
// C1 — FIXED (approved 2026-09-24): BUY/SELL write-time fallback amount
// ---------------------------------------------------------------------------
// Approved rule (docs/ACCOUNTING.md §2, §15 item 12): with no valid positive
// explicit cash_value, BUY = (G + f) x r and SELL = (G - f) x r, where
// G = qty*price and r = 1 for same currency; a SELL with G - f <= 0 is
// BLOCKED. settle_value stays G + f. These markers now assert the fix.
describe('C1 (fixed): BUY/SELL cash fallback — BUY uses G + fee, SELL uses net proceeds G - fee', () => {
  // SELL 40 @ 12.00, fee 3.00. Net proceeds = 40*12 - 3 = 477.00; settleAbs stays 483.00.
  const settleAbs = Math.abs(40 * 12 + 3);

  it('C1: same-currency BUY with no explicit cash_value is unchanged: G + fee', () => {
    const out = resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs, explicitCashValue: null });
    expect(out).toEqual({ status: 'ok', cash_value: 483, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, source: 'same-currency' });
  });

  it('C1: same-currency SELL with no explicit cash_value stores net proceeds 477.00 (G - fee)', () => {
    const out = resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs, cashBasisAbs: 40 * 12 - 3, explicitCashValue: null });
    expect(out).toEqual({ status: 'ok', cash_value: 477, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, source: 'same-currency' });
  });

  it('C1: cross-currency BUY via explicit fxrate is unchanged: (G + fee) x rate', () => {
    const out = resolveCashLeg({ assetCcy: 'USD', baseCcy: 'GBP', settleAbs: 1502, explicitCashValue: null, explicitFxRate: 0.8 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cash_value).toBeCloseTo(1201.6, 10);
    expect(out.cash_fx_to_portfolio).toBe(0.8);
    expect(out.source).toBe('explicit-fx-rate');
  });

  it('C1: cross-currency BUY via cached fx_rates is unchanged: (G + fee) x cached rate', () => {
    const out = resolveRowCashLeg('USD', 'GBP', 1502, null, null, { GBPUSD: 1.25 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cash_value).toBeCloseTo(1201.6, 10);
    expect(out.source).toBe('cached-fx-rate');
  });

  it('C1: cross-currency SELL via explicit fxrate stores (G - fee) x rate', () => {
    // SELL 10 @ $150, fee $10 on a USD asset in a GBP portfolio, fxrate 0.8.
    // Net = (1500 - 10) * 0.8 = 1192.00 (previously 1510 * 0.8 = 1208.00).
    const out = resolveCashLeg({ assetCcy: 'USD', baseCcy: 'GBP', settleAbs: 1510, cashBasisAbs: 1490, explicitCashValue: null, explicitFxRate: 0.8 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cash_value).toBeCloseTo(1192, 10);
    expect(out.cash_fx_to_portfolio).toBe(0.8);
    expect(out.source).toBe('explicit-fx-rate');
  });

  it('C1: cross-currency SELL via cached fx_rates stores (G - fee) x cached rate', () => {
    // Cached quotes GBPUSD 1.25 -> USD->GBP 0.8.
    const out = resolveRowCashLeg('USD', 'GBP', 1510, null, null, { GBPUSD: 1.25 }, false, 1490);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.cash_value).toBeCloseTo(1192, 10);
    expect(out.cash_fx_to_portfolio).toBeCloseTo(0.8, 12);
    expect(out.source).toBe('cached-fx-rate');
  });

  it('C1: an explicit positive SELL cash_value stays authoritative over the net-proceeds fallback (same and cross currency)', () => {
    expect(resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs, cashBasisAbs: 477, explicitCashValue: 470 })).toEqual({
      status: 'ok', cash_value: 470, cash_ccy: 'GBP', cash_fx_to_portfolio: 470 / 483, source: 'explicit-cash-value',
    });
    expect(resolveCashLeg({ assetCcy: 'USD', baseCcy: 'GBP', settleAbs: 1510, cashBasisAbs: 1490, explicitCashValue: 1190, explicitFxRate: 0.8 })).toEqual({
      status: 'ok', cash_value: 1190, cash_ccy: 'GBP', cash_fx_to_portfolio: 1190 / 1510, source: 'explicit-cash-value',
    });
  });

  it('C1: a SELL with fee >= G and no explicit cash_value is BLOCKED (same and cross currency)', () => {
    const reason = 'Net sale proceeds (quantity x price - fee) are not positive and no explicit cash value was supplied.';
    // fee == G
    expect(resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 20, cashBasisAbs: 0, explicitCashValue: null })).toEqual({ status: 'blocked', reason });
    // fee > G
    expect(resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 15, cashBasisAbs: -5, explicitCashValue: 0 })).toEqual({ status: 'blocked', reason });
    expect(resolveRowCashLeg('USD', 'GBP', 15, null, 0.8, undefined, false, -5)).toEqual({ status: 'blocked', reason });
    expect(resolveRowCashLeg('USD', 'GBP', 15, null, null, { GBPUSD: 1.25 }, false, -5)).toEqual({ status: 'blocked', reason });
  });

  it('C1: the same fee >= G SELL with an explicit positive cash_value is still accepted as supplied', () => {
    expect(resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 15, cashBasisAbs: -5, explicitCashValue: 1 })).toEqual({
      status: 'ok', cash_value: 1, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 / 15, source: 'explicit-cash-value',
    });
  });
});

// ---------------------------------------------------------------------------
// C3 — negative DIV/INT/DEP increase cash in BOTH live cash engines
// ---------------------------------------------------------------------------
describe(`${KD} C3 (not desired): a negative DIV/INT/DEP cash_value increases cash`, () => {
  const qMeta = assetMetaFor({ 'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' } });
  const sMeta: SAssetMeta = {
    id: 'cash-gbp',
    ticker: 'CASH.GBP',
    currency: 'GBP',
    status: 'active',
    resolved_ticker: 'CASH.GBP',
    price_multiplier: 1,
  };

  it.each(['DIV', 'INT', 'DEP'])(`${KD} C3: %s with cash_value -5.00 adds +5.00 in calculateCashBalancesMulti and applyCashTxn`, (type) => {
    const t = makeTxn({ type, asset_id: 'cash-gbp', cash_value: -5, cash_ccy: 'GBP' });

    expect(calculateCashBalancesMulti([t], qMeta)).toEqual([{ currency: 'GBP', balance: 5 }]);

    const cash = newCashMap();
    applyCashTxn(cash, sMeta, t as STxn);
    expect(cash.GBP).toBe(5);
  });

  it('related CURRENT behaviour (not itself a listed defect): WIT/FEE subtract abs(cash_value), so their stored sign is irrelevant', () => {
    for (const type of ['WIT', 'FEE']) {
      for (const cash_value of [5, -5]) {
        const t = makeTxn({ type, asset_id: 'cash-gbp', cash_value, cash_ccy: 'GBP' });
        expect(calculateCashBalancesMulti([t], qMeta)).toEqual([{ currency: 'GBP', balance: -5 }]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C5 — import-time parcel capture is not transfer-aware
// ---------------------------------------------------------------------------
describe(`${KD} C5 (not desired): TOT parcel capture at import replays an earlier RESOLVED TIN with legacy cost`, () => {
  // Source portfolio history for one asset (GBP):
  //   tin-1: TIN 100 shares. The importer always writes settle_value = qty*price+fee,
  //          here 100 * 1.00 + 0 = 100.00 (legacy cost). In reality this TIN has a
  //          resolved external_in transfer with a frozen, asserted cost of 500.00
  //          (base cost 500.00 GBP).
  //   tot-1: TOT 40 shares — a NEW row in this import, needing a parcel captured.
  const history = [
    makeTxn({ id: 'tin-1', type: 'TIN', date: '2024-01-10', created_at: '2024-01-10T00:00:00.000Z', quantity: 100, price: 1, fee: 0, settle_value: 100, settle_ccy: 'GBP' }),
    makeTxn({ id: 'tot-1', type: 'TOT', date: '2024-03-01', created_at: '2024-03-01T00:00:00.000Z', quantity: 40, price: 0, fee: 0, settle_value: 0, settle_ccy: 'GBP' }),
  ];
  const resolvedTin: ResolvedTransferForReplay = {
    id: 'tr-1',
    status: 'external_in',
    in_transaction_id: 'tin-1',
    out_transaction_id: null,
    quantity: 100,
    native_cost: 500,
    native_ccy: 'GBP',
    base_cost: 500,
    base_ccy: 'GBP',
  } as ResolvedTransferForReplay;

  it(`${KD} C5: the captured parcel carries 40% of the LEGACY cost (40.00), while the live replay holds 40% of the resolved cost (200.00)`, () => {
    // Live engine view of the source holding immediately before the TOT.
    const live: Holding = makeHolding({ asset_id: 'asset-x', ticker: 'XYZ.L', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(live, history[0], indexResolvedTransfersByTinTransactionId([resolvedTin]), new Map());
    expect(live.total_shares).toBe(100);
    expect(live.total_cost).toBe(500); // what a correct parcel of 40 would be based on: 200.00

    const { newTransferRows, errors } = captureTransferOutsForGroup(history, new Set(['tot-1']), {
      assetId: 'asset-x',
      ticker: 'XYZ.L',
      currency: 'GBP',
    });
    expect(errors).toHaveLength(0);
    expect(newTransferRows).toHaveLength(1);
    expect(newTransferRows[0].native_cost).toBeCloseTo(40, 6); // CURRENT: legacy basis, not 200.00
  });

  it(`${KD} C5: the captured parcel never carries a base cost, because the capture replay does not opt the holding into Definition B`, () => {
    const { newTransferRows } = captureTransferOutsForGroup(history, new Set(['tot-1']), {
      assetId: 'asset-x',
      ticker: 'XYZ.L',
      currency: 'GBP',
    });
    expect(newTransferRows[0].base_cost).toBeNull();
    expect(newTransferRows[0].base_ccy).toBeNull();
    expect(newTransferRows[0].base_cost_status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C9 — zero qty*price+fee blocks despite an explicit cash_value
// ---------------------------------------------------------------------------
describe(`${KD} C9 (not desired): a gated row with qty*price+fee = 0 is BLOCKED even with a valid explicit cash_value`, () => {
  it.each([
    { label: 'DIV (signed-explicit type) with cash_value 12.50', explicitCashValue: 12.5, allowSigned: true },
    { label: 'CASH.* TOT (positive-explicit type) with cash_value 100.00', explicitCashValue: 100, allowSigned: false },
  ])(`${KD} C9: $label is blocked because settleAbs is 0`, ({ explicitCashValue, allowSigned }) => {
    const out = resolveRowCashLeg('GBP', 'GBP', 0, explicitCashValue, null, undefined, allowSigned);
    expect(out).toEqual({ status: 'blocked', reason: 'No settlement amount to derive a cash leg from.' });
  });
});

// ---------------------------------------------------------------------------
// C11 — SELL implied FX biased by the fee
// ---------------------------------------------------------------------------
describe(`${KD} C11 (not desired): SELL realised-cost conversion uses cash_value / (qty*price + fee)`, () => {
  it(`${KD} C11: USD asset in a GBP portfolio — implied rate 1192/1510 ≈ 0.78940 (true rate 0.80) understates realised cost`, () => {
    const h = makeHolding({ asset_id: 'asset-usd', ticker: 'AAPL', currency: 'USD' });

    // BUY 10 @ $100, no fee. Native cost $1,000.00.
    applyTransactionToHolding(h, makeTxn({
      type: 'BUY', asset_id: 'asset-usd', quantity: 10, price: 100, fee: 0,
      settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8,
    }));

    // SELL 10 @ $150, fee $10. Importer writes settle_value = 10*150 + 10 = 1510.
    // Broker net proceeds in GBP at the true rate 0.8: (1500 - 10) * 0.8 = 1192.00.
    applyTransactionToHolding(h, makeTxn({
      type: 'SELL', asset_id: 'asset-usd', quantity: 10, price: 150, fee: 10,
      settle_value: 1510, settle_ccy: 'USD', cash_value: 1192, cash_ccy: 'GBP', cash_fx_to_portfolio: 1192 / 1510,
    }));

    const impliedFx = 1192 / 1510; // 0.789403973...
    expect(h.realised_proceeds).toBeCloseTo(1192, 6);
    expect(h.realised_cost).toBeCloseTo(1000 * impliedFx, 6); // ≈ 789.40 (at the true rate it would be 800.00)
    expect(h.realised_value).toBeCloseTo(1192 - 1000 * impliedFx, 6); // ≈ 402.60 (at the true rate it would be 392.00)
  });
});

// ---------------------------------------------------------------------------
// C12 — unsupported cash currency (outside GBP/USD/EUR)
// ---------------------------------------------------------------------------
describe(`${KD} C12 (not desired): a cash_ccy outside GBP/USD/EUR produces NaN`, () => {
  it(`${KD} C12: calculateCashBalancesMulti silently drops the CHF movement — no CHF bucket, no error, other buckets unaffected`, () => {
    const qMeta = assetMetaFor({ 'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' } });
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 100, cash_ccy: 'GBP' }),
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 250, cash_ccy: 'CHF' }),
    ];
    expect(calculateCashBalancesMulti(txns, qMeta)).toEqual([{ currency: 'GBP', balance: 100 }]);
  });

  it(`${KD} C12: applyCashTxn leaves a NaN CHF entry in its cash map`, () => {
    const sMeta: SAssetMeta = {
      id: 'cash-gbp',
      ticker: 'CASH.GBP',
      currency: 'GBP',
      status: 'active',
      resolved_ticker: 'CASH.GBP',
      price_multiplier: 1,
    };
    const cash = newCashMap() as Record<string, number>;
    applyCashTxn(cash as any, sMeta, makeTxn({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 250, cash_ccy: 'CHF' }) as STxn);
    expect(Number.isNaN(cash.CHF)).toBe(true);
    expect(cash.GBP).toBe(0);
  });
});
