// LIVE HOLDINGS REPLAY — resolved-transfer integration
//
// Exercises applyTransactionToHoldingResolvingTransfers (src/lib/queries.ts)
// and the pure lookup/parcel helpers in src/lib/holdingsTransferIntegration.ts.
// applyTransactionToHolding itself is never touched by this workstream —
// every current-behaviour.*.spec.ts test still exercises it directly and
// unmodified.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding, applyTransactionToHoldingResolvingTransfers } from '../../src/lib/queries';
import {
  indexResolvedTransfersByTinTransactionId,
  type ResolvedTransferForReplay,
  type ResolvedTransferLookup,
} from '../../src/lib/holdingsTransferIntegration';
import { makeHolding, makeTxn } from './helpers';

function resolvedTransfer(
  overrides: Partial<ResolvedTransferForReplay> & Pick<ResolvedTransferForReplay, 'id' | 'in_transaction_id'>
): ResolvedTransferForReplay {
  return {
    status: 'matched',
    quantity: 0,
    native_cost: 0,
    native_ccy: 'USD',
    base_cost: null,
    base_ccy: null,
    ...overrides,
  };
}

function lookupOf(...transfers: ResolvedTransferForReplay[]): ResolvedTransferLookup {
  return indexResolvedTransfersByTinTransactionId(transfers);
}

describe('1. matched internal TIN ignores its own market-value cost and inherits frozen native cost', () => {
  it('the real PLTR case: legacy would book $77,092.30, matched inherits the true $39,359.47296585', () => {
    const legacyTxn = makeTxn({ id: 'tin-pltr', type: 'TIN', quantity: 585, price: 131.78, fee: 1, settle_value: 77092.3, settle_ccy: 'USD' });

    const legacyHolding = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(legacyHolding, legacyTxn, lookupOf()); // no transfer record at all
    expect(legacyHolding.total_cost).toBeCloseTo(77092.3, 2);

    const resolvedHolding = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-1', in_transaction_id: 'tin-pltr', status: 'matched', quantity: 585, native_cost: 39359.47296585, native_ccy: 'USD' }));
    applyTransactionToHoldingResolvingTransfers(resolvedHolding, legacyTxn, resolved);
    expect(resolvedHolding.total_cost).toBeCloseTo(39359.47296585, 6);
    expect(resolvedHolding.total_shares).toBe(585);
  });
});

describe('2. matched partial transfer inherits exact proportional cost', () => {
  it('worked example: 200 sh / $2,000 -> transfer 50 -> destination receives 50 sh / $500, not a market-value guess', () => {
    const txn = makeTxn({ id: 'tin-partial', type: 'TIN', quantity: 50, price: 999, fee: 0, settle_value: 49950, settle_ccy: 'USD' }); // deliberately wrong market-value figure
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-2', in_transaction_id: 'tin-partial', quantity: 50, native_cost: 500, native_ccy: 'USD' }));
    applyTransactionToHoldingResolvingTransfers(holding, txn, resolved);
    expect(holding.total_shares).toBe(50);
    expect(holding.total_cost).toBeCloseTo(500, 6);
  });
});

describe('3. external_in uses explicit supplied historical cost', () => {
  it('an external_in transfer record overrides the TIN exactly like a matched one', () => {
    const txn = makeTxn({ id: 'tin-ext', type: 'TIN', quantity: 100, price: 50, fee: 0, settle_value: 5000, settle_ccy: 'GBP' }); // wrong market-value guess
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-3', in_transaction_id: 'tin-ext', status: 'external_in', quantity: 100, native_cost: 1200, native_ccy: 'GBP' }));
    applyTransactionToHoldingResolvingTransfers(holding, txn, resolved);
    expect(holding.total_cost).toBeCloseTo(1200, 6);
  });
});

describe('4. pending_in continues legacy behaviour for now', () => {
  it('a pending_in transfer record (no cost yet) is filtered out of the resolved lookup, so legacy derivation still applies', () => {
    const txn = makeTxn({ id: 'tin-pending', type: 'TIN', quantity: 40, settle_value: 380, settle_ccy: 'GBP' });
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    // pending_in has no native_cost — even if somehow passed in, indexResolvedTransfersByTinTransactionId excludes non-matched/external_in statuses.
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-4', in_transaction_id: 'tin-pending', status: 'pending_in' as any, quantity: 40, native_cost: null as any, native_ccy: null as any }));
    expect(resolved.size).toBe(0);
    applyTransactionToHoldingResolvingTransfers(holding, txn, resolved);
    expect(holding.total_cost).toBeCloseTo(380, 6); // legacy settle_value-derived figure, unchanged
  });
});

describe('5. TIN with no transfer record continues legacy behaviour', () => {
  it('an empty lookup behaves identically to calling applyTransactionToHolding directly', () => {
    const txn = makeTxn({ id: 'tin-none', type: 'TIN', quantity: 40, settle_value: 380, settle_ccy: 'GBP' });
    const legacy = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    const viaDispatch = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransactionToHolding(legacy, txn);
    applyTransactionToHoldingResolvingTransfers(viaDispatch, txn, lookupOf());
    expect(viaDispatch).toEqual(legacy);
  });
});

describe('6. external_out unchanged — TOT behaviour is untouched regardless of resolved-transfer lookup content', () => {
  it('a TOT produces identical output via the dispatch wrapper as via applyTransactionToHolding directly', () => {
    const txn = makeTxn({ id: 'tot-1', type: 'TOT', quantity: 40 });
    const legacy = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    const viaDispatch = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    // A resolved lookup that (incorrectly, hypothetically) contained an
    // entry keyed by this TOT's id must still have no effect — resolution
    // only ever applies to TIN.
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-6', in_transaction_id: 'tot-1', quantity: 40, native_cost: 999, native_ccy: 'GBP' }));
    applyTransactionToHolding(legacy, txn);
    applyTransactionToHoldingResolvingTransfers(viaDispatch, txn, resolved);
    expect(viaDispatch).toEqual(legacy);
  });
});

describe('7. no realised P/L on a matched transfer', () => {
  it('realised_value/realised_cost/realised_proceeds are untouched by a resolved TIN', () => {
    const txn = makeTxn({ id: 'tin-realised', type: 'TIN', quantity: 50, settle_value: 5000, settle_ccy: 'USD' });
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', realised_value: 42, realised_cost: 7, realised_proceeds: 49 });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-7', in_transaction_id: 'tin-realised', quantity: 50, native_cost: 500, native_ccy: 'USD' }));
    applyTransactionToHoldingResolvingTransfers(holding, txn, resolved);
    expect(holding.realised_value).toBe(42);
    expect(holding.realised_cost).toBe(7);
    expect(holding.realised_proceeds).toBe(49);
  });
});

describe('8. original transaction object remains unchanged', () => {
  it('a frozen transaction object survives resolution untouched', () => {
    const txn = Object.freeze(makeTxn({ id: 'tin-frozen', type: 'TIN', quantity: 50, price: 999, settle_value: 49950, settle_ccy: 'USD' }));
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-8', in_transaction_id: 'tin-frozen', quantity: 50, native_cost: 500, native_ccy: 'USD' }));
    expect(() => applyTransactionToHoldingResolvingTransfers(holding, txn, resolved)).not.toThrow();
    expect(txn.settle_value).toBe(49950); // unchanged — the wrong legacy figure is still sitting there, as an audit record
    expect(holding.total_cost).toBeCloseTo(500, 6); // but never consulted for cost
  });
});

describe('9. arrival order does not matter once status = matched', () => {
  it('two resolved transfer records built from opposite capture orders, but with the same frozen values, produce identical holdings', () => {
    const txnA = makeTxn({ id: 'tin-order-a', type: 'TIN', quantity: 140, settle_value: 9840.2, settle_ccy: 'USD' });
    const txnB = makeTxn({ id: 'tin-order-b', type: 'TIN', quantity: 140, settle_value: 9840.2, settle_ccy: 'USD' });

    // "TOT-first" capture and "TIN-first" capture both ultimately resolve to
    // the identical frozen parcel (proven independently in
    // transfers.spec.ts's arrival-order tests) — here we confirm the
    // REPLAY layer treats them identically regardless of that history.
    const resolvedA = lookupOf(resolvedTransfer({ id: 'tr-9a', in_transaction_id: 'tin-order-a', quantity: 140, native_cost: 17505.196598, native_ccy: 'USD' }));
    const resolvedB = lookupOf(resolvedTransfer({ id: 'tr-9b', in_transaction_id: 'tin-order-b', quantity: 140, native_cost: 17505.196598, native_ccy: 'USD' }));

    const holdingA = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD' });
    const holdingB = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(holdingA, txnA, resolvedA);
    applyTransactionToHoldingResolvingTransfers(holdingB, txnB, resolvedB);

    expect(holdingA.total_cost).toBe(holdingB.total_cost);
    expect(holdingA.total_shares).toBe(holdingB.total_shares);
  });
});

describe('10. PLTR real-data regression', () => {
  it('legacy ≈ $77,092.30 vs matched = $39,359.47296585', () => {
    const txn = makeTxn({ id: 'tin-pltr-2', type: 'TIN', quantity: 585, price: 131.78, fee: 1, settle_value: 77092.3, settle_ccy: 'USD' });

    const legacy = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(legacy, txn, lookupOf());
    expect(legacy.total_cost).toBeCloseTo(77092.3, 2);

    const matched = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-10', in_transaction_id: 'tin-pltr-2', quantity: 585, native_cost: 39359.47296585, native_ccy: 'USD' }));
    applyTransactionToHoldingResolvingTransfers(matched, txn, resolved);
    expect(matched.total_cost).toBeCloseTo(39359.47296585, 6);
    expect(matched.total_cost).not.toBeCloseTo(77092.3, 2);
  });
});

describe('11. PYPL real-data regression', () => {
  it('legacy ≈ $9,840.20 vs matched = $17,505.196598', () => {
    const txn = makeTxn({ id: 'tin-pypl-2', type: 'TIN', quantity: 140, price: 70.28, fee: 1, settle_value: 9840.2, settle_ccy: 'USD' });

    const legacy = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(legacy, txn, lookupOf());
    expect(legacy.total_cost).toBeCloseTo(9840.2, 2);

    const matched = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-11', in_transaction_id: 'tin-pypl-2', quantity: 140, native_cost: 17505.196598, native_ccy: 'USD' }));
    applyTransactionToHoldingResolvingTransfers(matched, txn, resolved);
    expect(matched.total_cost).toBeCloseTo(17505.196598, 6);
    expect(matched.total_cost).not.toBeCloseTo(9840.2, 2);
  });
});

describe('12. POLB.L real-data regression', () => {
  it('legacy ≈ £1,547.78 vs matched = £0', () => {
    const txn = makeTxn({ id: 'tin-polb-2', type: 'TIN', quantity: 48337, price: 0.031999917, fee: 1, settle_value: 1547.7799880290002, settle_ccy: 'GBP' });

    const legacy = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(legacy, txn, lookupOf());
    expect(legacy.total_cost).toBeCloseTo(1547.78, 2);

    const matched = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP' });
    const resolved = lookupOf(resolvedTransfer({ id: 'tr-12', in_transaction_id: 'tin-polb-2', quantity: 48337, native_cost: 0, native_ccy: 'GBP' }));
    applyTransactionToHoldingResolvingTransfers(matched, txn, resolved);
    expect(matched.total_cost).toBe(0);
    expect(matched.total_cost).not.toBeCloseTo(1547.78, 2);
  });
});

describe('13. resolved-transfer lookup is batched/indexed, not one DB query per transaction', () => {
  // The actual "one query per replay" guarantee is architectural: both
  // getPortfoliosWithHoldingsAndCash and getAllHoldingsAndCashSummary fetch
  // `transfers` exactly once, BEFORE their per-portfolio/per-transaction
  // loops (see src/lib/queries.ts) — there is no code path that queries
  // per transaction. What's unit-testable here is the O(1)-per-lookup
  // shape this enables: build the index once from a batch, then perform
  // many independent lookups against it with no further iteration.
  it('a single index build serves many independent O(1) lookups correctly, even with unrelated rows mixed in', () => {
    const unrelated = Array.from({ length: 500 }, (_, i) =>
      resolvedTransfer({ id: `tr-noise-${i}`, in_transaction_id: `tin-noise-${i}`, quantity: i, native_cost: i, native_ccy: 'USD' })
    );
    const target = resolvedTransfer({ id: 'tr-target', in_transaction_id: 'tin-target', quantity: 585, native_cost: 39359.47296585, native_ccy: 'USD' });

    const index = indexResolvedTransfersByTinTransactionId([...unrelated, target]); // built ONCE
    expect(index.size).toBe(501);

    const txn = makeTxn({ id: 'tin-target', type: 'TIN', quantity: 585, settle_value: 77092.3, settle_ccy: 'USD' });
    const holding = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(holding, txn, index); // O(1) Map.get against the pre-built index
    expect(holding.total_cost).toBeCloseTo(39359.47296585, 6);

    // An unrelated txn not in this batch resolves to nothing (legacy path).
    const otherTxn = makeTxn({ id: 'tin-not-present', type: 'TIN', quantity: 10, settle_value: 100, settle_ccy: 'USD' });
    const otherHolding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransactionToHoldingResolvingTransfers(otherHolding, otherTxn, index);
    expect(otherHolding.total_cost).toBeCloseTo(100, 6);
  });
});
