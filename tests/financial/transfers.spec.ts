// TRANSFER PERSISTENCE FOUNDATION (Phase 1) — pure builder/validator tests
//
// Exercises src/lib/transfers.ts against the schema in
// supabase/migrations/20260913091500_create_transfers_table.sql. Uses the
// existing pure transferCostBasis/queries primitives for all financial math
// — nothing here re-implements proportional cost removal.
//
// "Same transaction cannot participate in two transfer records" (test list
// item 14) is a DB-level uniqueness constraint, not application logic — it
// is verified directly against the local dev database via psql (see the
// implementation report) rather than duplicated here, consistent with this
// repo's existing convention of a 100%-pure, DB-free vitest suite.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding } from '../../src/lib/queries';
import {
  captureTransferOut,
  capturePendingIn,
  matchTransfer,
  confirmExternalOut,
  confirmExternalIn,
  type TransferRecord,
  type NewTransferRow,
} from '../../src/lib/transfers';
import { makeHolding, makeTxn } from './helpers';

function toRecord(id: string, row: NewTransferRow, ts = '2025-01-01T00:00:00Z'): TransferRecord {
  return { id, created_at: ts, updated_at: ts, ...row };
}

describe('1. pending_out freezes native cost', () => {
  it('captures native_cost/native_ccy immediately from the source holding', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-1', quantity: 50 });
    expect(transfer.status).toBe('pending_out');
    expect(transfer.out_transaction_id).toBe('tot-1');
    expect(transfer.in_transaction_id).toBeNull();
    expect(transfer.native_cost).toBeCloseTo(500, 6);
    expect(transfer.native_ccy).toBe('USD');
    expect(transfer.quantity).toBe(50);
  });
});

describe('2. pending_out freezes reliable base cost', () => {
  it('captures base_cost/base_ccy with base_cost_status = verified when the source Definition B ledger is reliable', () => {
    const holding = makeHolding({
      asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP',
      total_shares: 200, total_cost: 2000, base_total_cost: 1700, base_cost_reliable: true,
    });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-1', quantity: 50 });
    expect(transfer.base_cost).toBeCloseTo(425, 6); // worked example: 1700 * (50/200)
    expect(transfer.base_ccy).toBe('GBP');
    expect(transfer.base_cost_status).toBe('verified');
  });
});

describe('3. pending_out with unavailable base cost stores NULL, not zero', () => {
  it('a holding with no Definition B tracking at all yields base_cost = null, base_cost_status = null', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 100, total_cost: 1000, avg_price: 10 });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-2', quantity: 40 });
    expect(transfer.base_cost).toBeNull();
    expect(transfer.base_ccy).toBeNull();
    expect(transfer.base_cost_status).toBeNull();
    expect(transfer.base_cost).not.toBe(0);
  });

  it('a holding whose Definition B ledger is itself unreliable also yields NULL, never a tainted-but-fabricated number', () => {
    const holding = makeHolding({
      asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP',
      total_shares: 100, total_cost: 1000, base_total_cost: 800, base_cost_reliable: false,
    });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-3', quantity: 40 });
    expect(transfer.base_cost).toBeNull();
    expect(transfer.base_cost_status).toBeNull();
  });
});

describe('4. pending_in contains no historical cost', () => {
  it('records asset/quantity/relationship only — no invented transfer-date market value', () => {
    const row = capturePendingIn({ inTransactionId: 'tin-1', assetId: 'a1', quantity: 40 });
    expect(row.status).toBe('pending_in');
    expect(row.in_transaction_id).toBe('tin-1');
    expect(row.out_transaction_id).toBeNull();
    expect(row.quantity).toBe(40);
    expect(row.native_cost).toBeNull();
    expect(row.native_ccy).toBeNull();
    expect(row.base_cost).toBeNull();
  });
});

describe('5. captureTransferOut — exactly-once regression', () => {
  it('produces exactly one proportional removal, identical to what the unchanged production replay (applyTransactionToHolding) does for the same TOT', () => {
    const viaReplay = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });
    const viaCapture = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });

    // Path A: the existing, unchanged production replay path — applied to
    // its OWN holding.
    applyTransactionToHolding(viaReplay, makeTxn({ type: 'TOT', quantity: 50 }));

    // Path B: the persistence layer's capture — applied to an INDEPENDENT
    // pre-TOT holding, never the same object as Path A.
    const { parcel, transfer } = captureTransferOut(viaCapture, { outTransactionId: 'tot-1', quantity: 50 });

    expect(viaCapture.total_cost).toBeCloseTo(viaReplay.total_cost, 6);
    expect(viaCapture.total_shares).toBe(viaReplay.total_shares);
    expect(parcel.nativeCost).toBeCloseTo(500, 6);
    expect(transfer.native_cost).toBeCloseTo(500, 6);

    // Conservation: transferred cost + remaining source cost = pre-TOT cost.
    expect(parcel.nativeCost + viaCapture.total_cost).toBeCloseTo(2000, 6);
  });

  it('DANGER (documents the failure mode, not a supported call pattern): running captureTransferOut on a holding the replay has ALREADY reduced double-removes cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });

    applyTransactionToHolding(holding, makeTxn({ type: 'TOT', quantity: 50 })); // holding is now 150 sh / £1,500 (correct, single removal)
    captureTransferOut(holding, { outTransactionId: 'tot-1', quantity: 50 }); // WRONG: same TOT, same holding, a second time

    // The real-world transfer was 50 shares, once. Here it has been removed
    // twice — 100 shares and £1,000 gone from a holding that only ever
    // transferred 50 — leaving a corrupted remainder (100 sh / £1,000)
    // instead of the correct 150 sh / £1,500. (Each individual call's own
    // proportional math is internally consistent for whatever pool exists
    // at that moment — average-cost accounting keeps avg_price constant
    // across any single removal — which is precisely why this bug is easy
    // to miss by eye: it corrupts the aggregate, not any one calculation.)
    // This is exactly the bug captureTransferOut's caller contract prevents:
    // it must be called INSTEAD OF letting the normal replay's own TOT
    // branch run for that same row, never in addition to it.
    expect(holding.total_shares).not.toBe(150);
    expect(holding.total_shares).toBe(100);
    expect(holding.total_cost).not.toBeCloseTo(1500, 6);
    expect(holding.total_cost).toBeCloseTo(1000, 6);
  });
});

describe('6. partial transfer conservation (persistence layer)', () => {
  it('(frozen parcel cost) + (remaining source cost) = pre-transfer source cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 340, total_cost: 3111.6, avg_price: 9.152941176 });
    const original = holding.total_cost;
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-4', quantity: 77 });
    expect(transfer.native_cost! + holding.total_cost).toBeCloseTo(original, 6);
  });
});

describe('7. full transfer conservation', () => {
  it('a full transfer leaves the source at exactly zero, parcel equals full original cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 585, total_cost: 39359.47296585, avg_price: 67.28 });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-pltr', quantity: 585 });
    expect(holding.total_cost).toBe(0);
    expect(transfer.native_cost).toBeCloseTo(39359.47296585, 6);
  });
});

describe('8/9/10. Arrival order — TOT-first and TIN-first converge on the same matched record', () => {
  function buildPendingOut(recordId: string, outTxnId: string): TransferRecord {
    const holding = makeHolding({
      asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP',
      total_shares: 200, total_cost: 2000, base_total_cost: 1700, base_cost_reliable: true,
    });
    const { transfer } = captureTransferOut(holding, { outTransactionId: outTxnId, quantity: 50 });
    return toRecord(recordId, transfer, '2025-01-01T00:00:00Z');
  }
  function buildPendingIn(recordId: string, inTxnId: string): TransferRecord {
    const row = capturePendingIn({ inTransactionId: inTxnId, assetId: 'a1', quantity: 50 });
    return toRecord(recordId, row, '2025-02-01T00:00:00Z');
  }

  it('TOT-first: pending_out exists before pending_in, then matched', () => {
    const pendingOut = buildPendingOut('rec-out-1', 'tot-1');
    const pendingIn = buildPendingIn('rec-in-1', 'tin-1');
    const matched = matchTransfer(pendingOut, pendingIn);
    expect(matched.status).toBe('matched');
    expect(matched.in_transaction_id).toBe('tin-1');
    expect(matched.native_cost).toBeCloseTo(500, 6);
    expect(matched.base_cost).toBeCloseTo(425, 6);
  });

  it('TIN-first: pending_in exists before pending_out, then matched — same result', () => {
    const pendingIn = buildPendingIn('rec-in-2', 'tin-2');
    const pendingOut = buildPendingOut('rec-out-2', 'tot-2');
    const matched = matchTransfer(pendingOut, pendingIn);
    expect(matched.status).toBe('matched');
    expect(matched.in_transaction_id).toBe('tin-2');
    expect(matched.native_cost).toBeCloseTo(500, 6);
    expect(matched.base_cost).toBeCloseTo(425, 6);
  });

  it('arrival order produces byte-for-byte identical cost fields on the matched record', () => {
    const a = matchTransfer(buildPendingOut('x1', 'tot-a'), buildPendingIn('y1', 'tin-a'));
    const b = matchTransfer(buildPendingOut('x2', 'tot-b'), buildPendingIn('y2', 'tin-b'));
    expect(a.native_cost).toBe(b.native_cost);
    expect(a.native_ccy).toBe(b.native_ccy);
    expect(a.base_cost).toBe(b.base_cost);
    expect(a.base_ccy).toBe(b.base_ccy);
    expect(a.base_cost_status).toBe(b.base_cost_status);
  });
});

describe('11. matching preserves the frozen parcel exactly', () => {
  it('every cost field on the matched record equals the original pending_out — nothing recomputed', () => {
    const holding = makeHolding({
      asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP',
      total_shares: 200, total_cost: 2000, base_total_cost: 1700, base_cost_reliable: true,
    });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-5', quantity: 50 });
    const pendingOut = toRecord('rec-out-5', transfer);
    const pendingIn = toRecord('rec-in-5', capturePendingIn({ inTransactionId: 'tin-5', assetId: 'a1', quantity: 50 }));

    const matched = matchTransfer(pendingOut, pendingIn);

    expect(matched.native_cost).toBe(pendingOut.native_cost);
    expect(matched.native_ccy).toBe(pendingOut.native_ccy);
    expect(matched.base_cost).toBe(pendingOut.base_cost);
    expect(matched.base_ccy).toBe(pendingOut.base_ccy);
    expect(matched.base_cost_status).toBe(pendingOut.base_cost_status);
    expect(matched.quantity).toBe(pendingOut.quantity);
  });
});

describe('12. matching rejects a mismatched asset', () => {
  it('throws rather than silently linking two different assets', () => {
    const holding = makeHolding({ asset_id: 'asset-A', ticker: 'FOO', currency: 'USD', total_shares: 100, total_cost: 1000, avg_price: 10 });
    const out = toRecord('rec-out-6', captureTransferOut(holding, { outTransactionId: 'tot-6', quantity: 10 }).transfer);
    const in_ = toRecord('rec-in-6', capturePendingIn({ inTransactionId: 'tin-6', assetId: 'asset-B', quantity: 10 }));
    expect(() => matchTransfer(out, in_)).toThrow(/asset mismatch/);
  });
});

describe('13. matching rejects a mismatched quantity', () => {
  it('throws rather than silently linking a partial-quantity mismatch', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 100, total_cost: 1000, avg_price: 10 });
    const out = toRecord('rec-out-7', captureTransferOut(holding, { outTransactionId: 'tot-7', quantity: 50 }).transfer);
    const in_ = toRecord('rec-in-7', capturePendingIn({ inTransactionId: 'tin-7', assetId: 'a1', quantity: 40 }));
    expect(() => matchTransfer(out, in_)).toThrow(/quantity mismatch/);
  });
});

describe('15. external_out retains the frozen parcel, with no destination required', () => {
  it('confirmExternalOut changes only status/linked_by/linked_at — cost fields untouched', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    const { transfer } = captureTransferOut(holding, { outTransactionId: 'tot-8', quantity: 100 });
    const pendingOut = toRecord('rec-out-8', transfer);

    const ext = confirmExternalOut(pendingOut);
    expect(ext.status).toBe('external_out');
    expect(ext.in_transaction_id).toBeNull();
    expect(ext.native_cost).toBe(pendingOut.native_cost);
    expect(ext.native_ccy).toBe(pendingOut.native_ccy);
  });
});

describe('16. external_in requires an explicit native historical cost', () => {
  it('throws without a native cost', () => {
    const pendingIn = toRecord('rec-in-9', capturePendingIn({ inTransactionId: 'tin-9', assetId: 'a1', quantity: 40 }));
    expect(() => confirmExternalIn(pendingIn, { nativeCost: undefined as any, nativeCcy: 'GBP' })).toThrow(/native historical cost is required/);
  });

  it('succeeds once native cost + currency are explicitly supplied; base cost is optional', () => {
    const pendingIn = toRecord('rec-in-10', capturePendingIn({ inTransactionId: 'tin-10', assetId: 'a1', quantity: 40 }));
    const noBase = confirmExternalIn(pendingIn, { nativeCost: 500, nativeCcy: 'gbp' });
    expect(noBase.status).toBe('external_in');
    expect(noBase.native_cost).toBe(500);
    expect(noBase.native_ccy).toBe('GBP');
    expect(noBase.base_cost).toBeNull();
    expect(noBase.base_cost_status).toBeNull();

    const pendingIn2 = toRecord('rec-in-11', capturePendingIn({ inTransactionId: 'tin-11', assetId: 'a1', quantity: 40 }));
    const withBase = confirmExternalIn(pendingIn2, { nativeCost: 500, nativeCcy: 'GBP', baseCost: 480, baseCcy: 'GBP' });
    expect(withBase.base_cost).toBe(480);
    expect(withBase.base_cost_status).toBe('verified');
  });
});

describe('17. original transactions remain unchanged throughout', () => {
  it('every function here takes only ids/plain values from a transaction, never the transaction object itself, so nothing can mutate it', () => {
    // Frozen fixtures: any attempted write would throw (strict mode).
    const frozenTot = Object.freeze({ id: 'tot-imm', type: 'TOT', quantity: 50, portfolio_id: 'p1', asset_id: 'a1' });
    const frozenTin = Object.freeze({ id: 'tin-imm', type: 'TIN', quantity: 50, portfolio_id: 'p2', asset_id: 'a1' });

    const holding = makeHolding({ asset_id: frozenTot.asset_id, ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });
    const { transfer } = captureTransferOut(holding, { outTransactionId: frozenTot.id, quantity: frozenTot.quantity });
    const pendingOut = toRecord('rec-out-imm', transfer);
    const pendingIn = toRecord('rec-in-imm', capturePendingIn({ inTransactionId: frozenTin.id, assetId: frozenTin.asset_id, quantity: frozenTin.quantity }));

    const matched = matchTransfer(pendingOut, pendingIn);

    expect(frozenTot.quantity).toBe(50);
    expect(frozenTin.quantity).toBe(50);
    expect(matched.status).toBe('matched');
    expect(matched.out_transaction_id).toBe('tot-imm');
    expect(matched.in_transaction_id).toBe('tin-imm');
  });
});
