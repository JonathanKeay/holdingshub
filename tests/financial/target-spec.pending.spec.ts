// TARGET-SPECIFICATION TESTS
//
// These describe AGREED future behaviour that the current engine does not yet
// implement. Per the implementation boundary: A1 is tests only — production
// financial calculation behaviour must NOT be changed just to make these
// pass. Each test below is either:
//   - `it.skip(...)`  — the function it needs already exists and is callable,
//                       but asserts a value that is known to differ from
//                       today's real output (so it must not be run yet), or
//   - `it.todo(...)` — no function exists yet at all to call (writing a
//                       fake/stub implementation just to exercise it would
//                       misrepresent it as real production code), so only the
//                       intended behaviour and worked numbers are recorded.
//
// None of these tests are weakened to match current behaviour — the expected
// values are exactly what was agreed, even though the engine cannot produce
// them yet.

import { describe, it, expect } from 'vitest';
import { calculateCashBalancesMulti } from '../../src/lib/queries';
import { makeTxn, assetMetaFor, cashFor } from './helpers';

const assets = assetMetaFor({
  'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' },
  'cash-usd': { ticker: 'CASH.USD', currency: 'USD' },
  wynn: { ticker: 'WYNN', currency: 'USD' },
});

// T17 — BAL signed cash_value target: IMPLEMENTED. Moved to
// current-behaviour.cash.spec.ts (now describes actual, current behaviour)
// as part of the BAL reconciliation design — see git history for this file's
// previous pending version.

describe('T12b — FEE target: a standalone FEE attributed to a security must also affect the correct cash bucket (PENDING: FEE workstream — stabilisation plan decision 1)', () => {
  it.skip('debits the fee currency\'s cash bucket in addition to any performance attribution', () => {
    // Target: a £5 FEE attached to a real stock holding must reduce that
    // currency's modelled cash balance by £5 — the security attribution
    // (realised_value, already correct today — see
    // current-behaviour.cash.spec.ts T12b) is additive, not a substitute for
    // the cash entry. Today, calculateCashBalancesMulti's FEE branch is gated
    // by isCashAsset, so a FEE on a non-cash security has zero cash effect.
    const txns = [makeTxn({ type: 'FEE', asset_id: 'wynn', cash_value: 5, cash_ccy: 'USD' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'USD')).toBeCloseTo(-5, 6);
  });
});

// ---------------------------------------------------------------------------
// T5 / T19 / T23 — Definition B: parallel portfolio-base cost ledger
// ---------------------------------------------------------------------------
// No function implementing this exists anywhere in the codebase today (confirmed
// by reading src/lib/queries.ts in full) — applyTransactionToHolding tracks
// cost basis only in the asset's native currency. Writing a stub function
// here to exercise would misrepresent unimplemented behaviour as tested
// production code, so these are recorded as `test.todo` with the full
// worked numbers, for whoever implements the parallel ledger.

describe('T5 target — Definition B realised P/L for a GBP-base portfolio + USD asset', () => {
  it.todo(
    'PENDING: requires a new parallel portfolio-base cost-basis accumulator (average-cost, ' +
    'proportional removal on partial sale) alongside total_cost — see Workstream: Cash/FX ' +
    'Definition B implementation. Worked example: BUY settle_value=$5,002, actual GBP cash ' +
    'paid=£4,001.60 (implied FX 0.80). SELL settle_value=$5,497, actual GBP cash received=' +
    '£4,122.75 (implied FX 0.75). Target realised P/L (portfolio-base/GBP) = 4,122.75 - ' +
    '4,001.60 = +£121.15. Native (USD) realised P/L must be preserved separately and equals ' +
    '5,497 - 5,002 = +$495.00 (already correctly produced by today\'s code in the asset ' +
    'currency domain). Decomposition to keep, for later reporting: native return translated ' +
    'at disposal-date FX = 495 * 0.75 = £371.25 (this is today\'s current-behaviour figure, ' +
    'exercised in current-behaviour.fx-realised.spec.ts — it is not discarded, just relabelled ' +
    'as one named component); FX effect on cost = 4,001.60 - (5,002 * 0.75 = 3,751.50) = ' +
    '£250.10; check: 371.25 - 250.10 = 121.15.'
  );
});

describe('T19 target — partial sale must not leak value between the native and portfolio-base ledgers', () => {
  it.todo(
    'PENDING: same dependency as T5. Invariant to enforce once the parallel ledger exists: ' +
    'for a partial sale, (portfolio-base cost removed) + (portfolio-base cost remaining) must ' +
    'sum back to the original portfolio-base acquisition cost, independently of the equivalent ' +
    'invariant already holding for the native-currency ledger (see current-behaviour tests). ' +
    'This guards against an implementation that derives one ledger from the other via a single ' +
    'stored FX rate instead of maintaining both as genuinely independent running totals.'
  );
});

describe('T23 target — USD-base portfolio: Definition B applies in USD, GBP is reporting-layer only', () => {
  it.todo(
    'PENDING: same dependency as T5, but for a USD-base portfolio the "portfolio-base" ledger ' +
    'is denominated in USD, not GBP — actual USD cash out vs actual USD cash in, using ' +
    'cash_fx_to_portfolio to convert a EUR- (or other-) denominated settle amount into USD, ' +
    'exactly parallel to the GBP case. GBP must only enter at the consolidated cross-portfolio ' +
    'reporting layer as a spot-rate translation of the finished USD figure — never as a second ' +
    'parallel ledger for this portfolio.'
  );
});

describe('T13 target — linked TOT/TIN transfers should carry cost basis forward (arrival-order-independent; pure arithmetic now implemented, persistence/matching layer NOT implemented)', () => {
  it.todo(
    'PARTIALLY IMPLEMENTED: the pure arithmetic for this is now real, tested code — see ' +
    'tests/financial/transfer-cost-basis.spec.ts, exercising src/lib/transferCostBasis.ts\'s ' +
    'applyTransferOut()/applyTransferIn(). Given a CONFIRMED link, a destination correctly ' +
    'inherits the source\'s native-currency cost (and, once Definition B exists, its ' +
    'portfolio-base cost) exactly, regardless of which leg was recorded first or how much time ' +
    'passed between them — proven directly against the real PLTR/PYPL/POLB.L figures. What ' +
    'remains PENDING and is NOT built is everything about deciding a link exists: a persistence ' +
    'model for an unmatched transfer-out, an unmatched transfer-in, and a confirmed match ' +
    '(see the transfer pending/matching design — a dedicated transfer record, not a fuzzy ' +
    'inference, given real data already shows two genuinely different transfers sharing an ' +
    'identical note-text pattern); the matching-suggestion logic itself; and the wiring that ' +
    'calls applyTransferOut()/applyTransferIn() only once a link is confirmed. ' +
    'applyTransactionToHolding()\'s existing TIN/TOT branches (current-behaviour.positions.spec.ts ' +
    'T13/T14) are unchanged and still handle every TIN/TOT row today, linked or not.'
  );
});

describe('T13b target — pending state: TOT arrives first, no matching TIN yet', () => {
  it.todo(
    'PENDING: no persistence model exists yet for "unmatched transfer-out". Intended direction: ' +
    'recording a TOT removes shares/cost from the source exactly as today (unchanged — this part ' +
    'is a real disposal-free removal already), and captures its cost parcel (applyTransferOut()\'s ' +
    'return value, or the equivalent) against a pending transfer record — not yet linked to any ' +
    'destination. It must remain visibly "pending/unmatched" (not silently treated as an external ' +
    'transfer-out, which is a different, already-final state) until the user confirms either a ' +
    'match to a later TIN or that it truly has no HoldingsHub-tracked destination.'
  );
});

describe('T13c target — pending state: TIN arrives first, no matching TOT yet', () => {
  it.todo(
    'PENDING: no persistence model exists yet for "unmatched transfer-in". Intended direction: ' +
    'shares still appear on the destination holding immediately (the user genuinely holds them), ' +
    'but the cost basis must be marked unverified/pending rather than permanently set from ' +
    'transfer-date market value — today\'s deriveAssetCostForTIN() fallback (current-behaviour.' +
    'positions.spec.ts T13) is explicitly a provisional placeholder in this state, not a verified ' +
    'figure. If a matching TOT later arrives and is confirmed, applyTransferIn() must be able to ' +
    'REPLACE the provisional cost with the true carried-forward parcel — this is a correction, not ' +
    'an accumulation. If the user instead confirms it is an external transfer-in, the placeholder ' +
    'is replaced by whatever historical cost the user explicitly supplies — never invented.'
  );
});

describe('T13d target — an unmatched/pending TIN must not silently be treated as a verified market-value cost', () => {
  it.todo(
    'PENDING: same dependency as T13c. Any downstream figure derived from an unverified TIN\'s ' +
    'cost (unrealised gain/loss, performance reporting) must be visibly flagged as provisional ' +
    'while pending — never presented with the same confidence as a verified BUY or a resolved ' +
    'linked transfer. Quantity/current value are real and must still display normally; only ' +
    'cost-derived figures carry the pending flag.'
  );
});
