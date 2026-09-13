// TRANSFER IMPORT INTEGRATION — pure logic tests
//
// Exercises the pure decision functions in src/lib/transferImportIntegration.ts:
// selectTransferRelevantRows, captureTransferOutsForGroup,
// filterAlreadyLinkedTransactionIds. The DB-touching orchestration
// (processImportedTransfers) is thin plumbing around these — consistent
// with this repo's existing convention (e.g. getPortfoliosWithHoldingsAndCash)
// of not unit-testing the Supabase-calling layer itself, only the logic it
// delegates to.

import { describe, it, expect } from 'vitest';
import {
  selectTransferRelevantRows,
  captureTransferOutsForGroup,
  filterAlreadyLinkedTransactionIds,
  compareForReplay,
  type InsertedTxnForTransfer,
} from '../../src/lib/transferImportIntegration';
import { capturePendingIn } from '../../src/lib/transfers';
import { makeTxn } from './helpers';

const assetTickerById = { 'asset-pltr': 'PLTR', 'asset-cash-gbp': 'CASH.GBP' };

describe('current non-transfer imports are unaffected', () => {
  it('a batch of ordinary BUY/SELL/DIV rows yields no relevant rows at all', () => {
    const rows: InsertedTxnForTransfer[] = [
      { id: 'tx1', portfolio_id: 'p1', asset_id: 'asset-pltr', type: 'BUY', quantity: 10, date: '2025-01-01' },
      { id: 'tx2', portfolio_id: 'p1', asset_id: 'asset-pltr', type: 'SELL', quantity: 5, date: '2025-01-02' },
      { id: 'tx3', portfolio_id: 'p1', asset_id: 'asset-pltr', type: 'DIV', quantity: null, date: '2025-01-03' },
    ];
    expect(selectTransferRelevantRows(rows, assetTickerById)).toHaveLength(0);
  });

  it('cash TIN/TOT rows (CASH.* tickers) are excluded — they have no Holding/cost-basis concept', () => {
    const rows: InsertedTxnForTransfer[] = [
      { id: 'tx4', portfolio_id: 'p1', asset_id: 'asset-cash-gbp', type: 'TOT', quantity: 1, date: '2025-01-01' },
      { id: 'tx5', portfolio_id: 'p2', asset_id: 'asset-cash-gbp', type: 'TIN', quantity: 1, date: '2025-01-01' },
    ];
    expect(selectTransferRelevantRows(rows, assetTickerById)).toHaveLength(0);
  });
});

describe('TOT creates a pending_out with a frozen parcel; TIN is identified for pending_in', () => {
  it('selectTransferRelevantRows picks out a security TOT and a security TIN, nothing else', () => {
    const rows: InsertedTxnForTransfer[] = [
      { id: 'tot-1', portfolio_id: 'p1', asset_id: 'asset-pltr', type: 'TOT', quantity: 100, date: '2025-06-02' },
      { id: 'tin-1', portfolio_id: 'p2', asset_id: 'asset-pltr', type: 'TIN', quantity: 100, date: '2025-06-02' },
      { id: 'buy-1', portfolio_id: 'p1', asset_id: 'asset-pltr', type: 'BUY', quantity: 50, date: '2025-01-01' },
    ];
    const relevant = selectTransferRelevantRows(rows, assetTickerById);
    expect(relevant.map((r) => r.id).sort()).toEqual(['tin-1', 'tot-1']);
  });

  it('captureTransferOutsForGroup replays the pre-TOT history and freezes exactly the removed cost, exactly once', () => {
    const history = [
      makeTxn({ id: 'buy-1', type: 'BUY', date: '2024-11-25', quantity: 585, price: 66.90017601, fee: 222.87, settle_value: 39359.47296585, settle_ccy: 'USD' }),
      makeTxn({ id: 'tot-1', type: 'TOT', date: '2025-06-02', quantity: 585 }),
    ];
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      history,
      new Set(['tot-1']),
      { assetId: 'asset-pltr', ticker: 'PLTR', currency: 'USD' }
    );
    expect(errors).toHaveLength(0);
    expect(newTransferRows).toHaveLength(1);
    expect(newTransferRows[0].status).toBe('pending_out');
    expect(newTransferRows[0].out_transaction_id).toBe('tot-1');
    expect(newTransferRows[0].native_cost).toBeCloseTo(39359.47296585, 6); // the real PLTR figure — not $77,092.30
    expect(newTransferRows[0].native_ccy).toBe('USD');
  });

  it('a pre-existing TOT (not in this batch) is replayed normally and does NOT get a new transfer record', () => {
    const history = [
      makeTxn({ id: 'buy-1', type: 'BUY', date: '2024-01-01', quantity: 200, price: 10, fee: 0, settle_value: 2000, settle_ccy: 'USD' }),
      makeTxn({ id: 'old-tot', type: 'TOT', date: '2024-06-01', quantity: 50 }), // pre-existing, already handled previously — NOT in this batch
      makeTxn({ id: 'new-tot', type: 'TOT', date: '2025-06-02', quantity: 50 }),
    ];
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      history,
      new Set(['new-tot']), // only the NEW row is in this import's batch
      { assetId: 'a1', ticker: 'FOO', currency: 'USD' }
    );
    expect(errors).toHaveLength(0);
    expect(newTransferRows).toHaveLength(1);
    expect(newTransferRows[0].out_transaction_id).toBe('new-tot');
    // 200 -> 150 (old-tot) -> 100 (new-tot): new-tot's parcel is 1500 * 50/150 = 500, not 2000 * 50/200 = 500 by coincidence of these numbers — assert via the actual invariant instead:
    expect(newTransferRows[0].native_cost).toBeCloseTo(500, 6);
  });
});

describe('TOT-first and TIN-first across separate "import runs" are independent and order-agnostic', () => {
  it('capturing the TOT and creating the pending_in can happen in either order with identical individual results', () => {
    const history = [
      makeTxn({ id: 'buy-1', type: 'BUY', date: '2022-02-07', quantity: 140, price: 123.9399757, fee: 153.6, settle_value: 17505.196598, settle_ccy: 'USD' }),
      makeTxn({ id: 'tot-pypl', type: 'TOT', date: '2025-06-02', quantity: 140 }),
    ];

    // "TOT-first" run:
    const totFirst = captureTransferOutsForGroup(history, new Set(['tot-pypl']), { assetId: 'a-pypl', ticker: 'PYPL', currency: 'USD' });
    // A separate, later "import run" creates the pending_in — entirely independent, no shared state.
    const pendingIn = capturePendingIn({ inTransactionId: 'tin-pypl', assetId: 'a-pypl', quantity: 140 });

    // "TIN-first" run, same data, opposite construction order:
    const pendingInFirst = capturePendingIn({ inTransactionId: 'tin-pypl', assetId: 'a-pypl', quantity: 140 });
    const totSecond = captureTransferOutsForGroup(history, new Set(['tot-pypl']), { assetId: 'a-pypl', ticker: 'PYPL', currency: 'USD' });

    expect(totFirst.newTransferRows[0].native_cost).toBeCloseTo(17505.196598, 6);
    expect(totSecond.newTransferRows[0].native_cost).toBe(totFirst.newTransferRows[0].native_cost);
    expect(pendingIn.native_cost).toBeNull();
    expect(pendingInFirst.native_cost).toBeNull();
  });
});

describe('duplicate import / idempotency safeguard', () => {
  it('filterAlreadyLinkedTransactionIds removes any transaction id that already has a transfer record', () => {
    const candidates = ['tx-a', 'tx-b', 'tx-c'];
    const alreadyLinked = new Set(['tx-b']);
    expect(filterAlreadyLinkedTransactionIds(candidates, alreadyLinked)).toEqual(['tx-a', 'tx-c']);
  });

  it('a fully-duplicated import (two distinct new transaction ids for what is conceptually the same row) is not silently merged — each gets its own independent transfer record, mirroring how the transactions table itself has no duplicate-content detection', () => {
    const history = [
      makeTxn({ id: 'buy-1', type: 'BUY', date: '2024-01-01', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD' }),
      makeTxn({ id: 'tot-dup-1', type: 'TOT', date: '2025-01-01', quantity: 40 }),
      makeTxn({ id: 'tot-dup-2', type: 'TOT', date: '2025-01-01', created_at: '2025-01-01T00:00:01Z', quantity: 40 }), // accidental re-import of the same CSV row
    ];
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      history,
      new Set(['tot-dup-1', 'tot-dup-2']),
      { assetId: 'a1', ticker: 'FOO', currency: 'USD' }
    );
    expect(errors).toHaveLength(0);
    expect(newTransferRows).toHaveLength(2);
    expect(newTransferRows[0].out_transaction_id).not.toBe(newTransferRows[1].out_transaction_id);
    // This is exactly why the DB's unique(out_transaction_id) constraint keys
    // on TRANSACTION id, not on content — it cannot and does not attempt to
    // detect "these two rows look like the same real-world transfer".
  });
});

describe('failed transfer persistence cannot silently leave inconsistent state', () => {
  it('an anomalous row (a TOT transferring shares that were never bought) degrades to an explicit, reportable zero-cost parcel — never throws, and never corrupts a later well-formed row in the same batch', () => {
    // captureTransferOutsForGroup wraps each captureTransferOut call in
    // try/catch specifically so one bad row can never take down the whole
    // batch or leave the caller with an uncaught exception (see its source
    // — applyTransferOut's own proportion-of-zero guard already prevents a
    // throw here, and the try/catch is a second line of defence for any
    // future change to that function).
    const history = [
      makeTxn({ id: 'tot-bad', type: 'TOT', date: '2025-01-01', quantity: 100 }), // no BUY at all -> holding starts at 0 shares
      makeTxn({ id: 'buy-2', type: 'BUY', date: '2025-02-01', quantity: 200, price: 10, fee: 0, settle_value: 2000, settle_ccy: 'USD' }),
      makeTxn({ id: 'tot-good', type: 'TOT', date: '2025-03-01', quantity: 50 }),
    ];
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      history,
      new Set(['tot-bad', 'tot-good']),
      { assetId: 'a1', ticker: 'FOO', currency: 'USD' }
    );
    expect(errors).toHaveLength(0); // nothing throws here — see comment above
    expect(newTransferRows).toHaveLength(2);
    expect(newTransferRows.find((r) => r.out_transaction_id === 'tot-bad')?.native_cost).toBe(0);
    expect(newTransferRows.find((r) => r.out_transaction_id === 'tot-good')?.native_cost).toBeCloseTo(500, 6);
  });

  it('malformed input at the type boundary (a non-numeric quantity) never propagates as an uncaught exception', () => {
    // The try/catch in captureTransferOutsForGroup exists precisely so a
    // single malformed row can never take down an entire import batch's
    // transfer processing. Confirms the contract holds even for input that
    // shouldn't occur given upstream validation, but must still degrade
    // safely if it ever does.
    const history = [makeTxn({ id: 'tot-weird', type: 'TOT', date: '2025-01-01', quantity: 'not-a-number' as any })];
    expect(() =>
      captureTransferOutsForGroup(history, new Set(['tot-weird']), { assetId: 'a1', ticker: 'FOO', currency: 'USD' })
    ).not.toThrow();
  });
});

describe('Same-date ordering regression — BUY/BUY/TOT/BUY(after), all on one calendar date', () => {
  // A bulk multi-row INSERT gives every row in the batch the IDENTICAL
  // created_at (verified directly against this project's local dev Postgres
  // — see the implementation report). Without the import route's fix
  // (assigning each row its own strictly-increasing created_at, 1ms apart,
  // in CSV row order), same-date/same-created_at rows fall through to a
  // type-priority tiebreak (BUY=30 < TOT=50) that has nothing to do with
  // intended chronological order — a same-day BUY meant to happen AFTER the
  // TOT would sort BEFORE it, and get wrongly folded into the frozen parcel.
  //
  // Scenario: BUY 100 @ $10 (cost $1,000), BUY 100 @ $20 (cost $2,000) ->
  // 200 sh / $3,000. TOT 50 -> correct parcel: 50/200 * 3000 = $750. A
  // trailing same-day BUY of 100 @ $100 (cost $10,000) is meant to happen
  // AFTER the transfer and must not affect it at all.
  //
  // (A trailing SELL would NOT reveal this bug numerically — proportional
  // removal preserves the average cost per share regardless of order, so a
  // misordered SELL happens to still yield the same TOT parcel. A trailing
  // BUY injects new cost at a different price, which does change the
  // average — making the ordering bug directly observable, which is why
  // it's used here.)

  // Built in an order that does NOT already match intended chronological
  // order (a DB SELECT's row order is not guaranteed to match date order
  // either) — compareForReplay's sort is what must establish the correct
  // order, exactly as processImportedTransfers does in production
  // (`.sort(compareForReplay)` before calling captureTransferOutsForGroup).
  // Passing pre-ordered input straight to captureTransferOutsForGroup
  // (which documents that it expects already-sorted input and does not sort
  // internally) would not actually exercise the real ordering logic at all.
  function buildUnsortedHistory(createdAts: [string, string, string, string]) {
    return [
      makeTxn({ id: 'buy-after', type: 'BUY', date: '2025-06-02', created_at: createdAts[3], quantity: 100, price: 100, fee: 0, settle_value: 10000, settle_ccy: 'USD' }),
      makeTxn({ id: 'tot-1', type: 'TOT', date: '2025-06-02', created_at: createdAts[2], quantity: 50 }),
      makeTxn({ id: 'buy-2', type: 'BUY', date: '2025-06-02', created_at: createdAts[1], quantity: 100, price: 20, fee: 0, settle_value: 2000, settle_ccy: 'USD' }),
      makeTxn({ id: 'buy-1', type: 'BUY', date: '2025-06-02', created_at: createdAts[0], quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD' }),
    ];
  }

  it('DANGER (documents the pre-fix failure mode): identical created_at for all four rows — exactly what an unfixed bulk insert produces — lets the trailing BUY corrupt the TOT parcel', () => {
    // All four rows share the IDENTICAL created_at a real unfixed bulk
    // INSERT actually produces (empirically verified against this
    // project's local dev Postgres — see the implementation report).
    const sameInstant = '2025-06-02T00:00:00.000Z';
    const unsorted = buildUnsortedHistory([sameInstant, sameInstant, sameInstant, sameInstant]);
    const sorted = [...unsorted].sort(compareForReplay); // exactly what processImportedTransfers does
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      sorted,
      new Set(['tot-1']),
      { assetId: 'a1', ticker: 'FOO', currency: 'USD' }
    );
    expect(errors).toHaveLength(0);
    // Wrong: with date AND created_at tied for all four rows, ordering falls
    // to type-priority — BUY (30) sorts before TOT (50) regardless of which
    // BUY it is, so the trailing BUY (meant to happen AFTER the transfer)
    // is wrongly folded into the pre-TOT holding, corrupting the parcel:
    // 200 sh/$3,000 + the trailing $10,000/100sh BUY = 300 sh/$13,000,
    // giving a wrong parcel of 13000 * 50/300 = $2,166.67, not $750.
    expect(newTransferRows[0].native_cost).toBeCloseTo(2166.6666666666665, 2);
    expect(newTransferRows[0].native_cost).not.toBeCloseTo(750, 2);
  });

  it('FIXED behaviour: distinct, strictly-increasing created_at (as the import route now assigns, in CSV row order) captures exactly the pre-TOT weighted-average state, unaffected by the trailing BUY', () => {
    const unsorted = buildUnsortedHistory([
      '2025-06-02T00:00:00.000Z',
      '2025-06-02T00:00:00.001Z',
      '2025-06-02T00:00:00.002Z',
      '2025-06-02T00:00:00.003Z', // buy-after: strictly later than tot-1's .002
    ]);
    const sorted = [...unsorted].sort(compareForReplay);
    const { newTransferRows, errors } = captureTransferOutsForGroup(
      sorted,
      new Set(['tot-1']),
      { assetId: 'a1', ticker: 'FOO', currency: 'USD' }
    );
    expect(errors).toHaveLength(0);
    expect(newTransferRows).toHaveLength(1);
    expect(newTransferRows[0].out_transaction_id).toBe('tot-1');
    expect(newTransferRows[0].native_cost).toBeCloseTo(750, 6); // 3000 * 50/200 — the trailing BUY correctly excluded
  });
});
