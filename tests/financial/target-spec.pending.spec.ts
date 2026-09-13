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
// IMPLEMENTED. applyTransactionToHolding gained a fully additive, opt-in
// Definition B block (holding.base_currency / base_total_cost / base_avg_cost
// / base_cost_reliable / base_realised_value, etc — see src/lib/queries.ts).
// These three scenarios are now real, passing tests in
// tests/financial/definitionB-base-cost.spec.ts, with the exact worked
// numbers this block used to record: T5's £121.15 (vs the preserved,
// unchanged current-behaviour £371.15 figure), T19's cost-conservation
// invariant proven independently of the native ledger, and T23's USD-base
// case. Removed from here (rather than left as stale it.todo) so this file
// keeps meaning "not yet built" — see git history for the original text.
//
// Still NOT built: wiring this into getPortfoliosWithHoldingsAndCash /
// getAllHoldingsAndCashSummary (no caller sets base_currency yet, so this
// remains dormant in the live app), and TIN/TOT base-cost carry-forward
// (blocked on the same transfer-linking persistence layer as T13 below —
// until then, any TIN/TOT taints base_cost_reliable rather than guessing).

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
