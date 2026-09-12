// BAL RECONCILIATION — computeBalancePreview
//
// Unit tests for the new, canonical-engine-based reconciliation preview used
// by the Cash Balance Adjustment tool (src/app/tools/cash-balance/actions.ts).
// Uses controlled, synthetic transaction data only — never the restored
// production snapshot.

import { describe, it, expect } from 'vitest';
import { calculateCashBalancesMulti, computeBalancePreview } from '../../src/lib/queries';
import { makeTxn, assetMetaFor, cashFor } from './helpers';

const assets = assetMetaFor({
  'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' },
  'cash-usd': { ticker: 'CASH.USD', currency: 'USD' },
  wynn: { ticker: 'WYNN', currency: 'USD' },
});

describe('computeBalancePreview — reconciliation-tool preview built on the canonical cash engine', () => {
  it('broker cash higher than modelled: positive diff', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 595.54, cash_ccy: 'GBP' })];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 610.0 });
    expect(preview.current).toBeCloseTo(595.54, 2);
    expect(preview.diff).toBeCloseTo(14.46, 2);
    expect(preview.ccy).toBe('GBP');
  });

  it('broker cash lower than modelled: negative diff', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 595.54, cash_ccy: 'GBP' })];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 580.0 });
    expect(preview.diff).toBeCloseTo(-15.54, 2);
  });

  it('a USD-base portfolio (e.g. ETRO) reconciles in USD, not GBP', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-usd', date: '2026-01-01', cash_value: 1326.85, cash_ccy: 'USD' })];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'USD', asOf: '2026-09-12', mode: 'post', target: 1300.0 });
    expect(preview.ccy).toBe('USD');
    expect(preview.diff).toBeCloseTo(-26.85, 2);
  });

  it('post-trade includes a same-day transaction in "current"; pre-trade excludes it', () => {
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-09-01', cash_value: 500, cash_ccy: 'GBP' }),
      makeTxn({ type: 'BUY', asset_id: 'wynn', date: '2026-09-12', cash_value: 120, cash_ccy: 'GBP' }),
    ];
    const post = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 380 });
    const pre = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'pre', target: 380 });
    expect(post.current).toBeCloseTo(380, 2); // 500 deposit - 120 same-day BUY
    expect(pre.current).toBeCloseTo(500, 2); // same-day BUY excluded pre-trade
    expect(post.diff).toBeCloseTo(0, 2);
    expect(pre.diff).toBeCloseTo(-120, 2);
  });

  it('round-trips exactly: feeding the previewed BAL row back into the canonical engine reproduces target', () => {
    const base = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 595.54, cash_ccy: 'GBP' })];
    const preview = computeBalancePreview(base, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 610.0 });

    const balRow = makeTxn({
      type: 'BAL',
      asset_id: 'cash-gbp',
      date: '2026-09-12',
      quantity: null,
      cash_value: preview.diff,
      cash_ccy: 'GBP',
    });

    const after = calculateCashBalancesMulti([...base, balRow], assets, { asOf: '2026-09-12' });
    expect(cashFor(after, 'GBP')).toBeCloseTo(610.0, 2);
  });
});

describe('computeBalancePreview — foreignCurrencyWarning (no auto-FX, base-currency ledger only)', () => {
  it('no warning when all cash effects in scope are in the portfolio base currency', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 500, cash_ccy: 'GBP' })];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 500 });
    expect(preview.foreignCurrencyWarning).toBeNull();
  });

  it('warns when a GBP-base portfolio has a USD cash event in scope', () => {
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 500, cash_ccy: 'GBP' }),
      makeTxn({ type: 'DEP', asset_id: 'cash-usd', date: '2026-01-01', cash_value: 200, cash_ccy: 'USD' }),
    ];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 500 });
    expect(preview.foreignCurrencyWarning).not.toBeNull();
    expect(preview.foreignCurrencyWarning?.currencies).toEqual(['USD']);
    expect(preview.foreignCurrencyWarning?.message).toMatch(/USD/);
    expect(preview.foreignCurrencyWarning?.message).toMatch(/not.*(been )?converted|no.*conversion/i);
  });

  it('the base-currency balance is unaffected by the unsupported foreign bucket — no silent inclusion', () => {
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-01-01', cash_value: 500, cash_ccy: 'GBP' }),
      makeTxn({ type: 'DEP', asset_id: 'cash-usd', date: '2026-01-01', cash_value: 200, cash_ccy: 'USD' }),
    ];
    const preview = computeBalancePreview(txns, assets, { baseCcy: 'GBP', asOf: '2026-09-12', mode: 'post', target: 500 });
    expect(preview.current).toBeCloseTo(500, 2); // USD 200 must NOT be folded in
    expect(preview.diff).toBeCloseTo(0, 2);
  });
});
