// DEFINITION B ACTIVATION — orchestration-layer tests
//
// Exercises the two changes that activate Definition B in the live callers
// (src/lib/queries.ts's getPortfoliosWithHoldingsAndCash /
// getAllHoldingsAndCashSummary) plus the new pure resolution helper,
// src/lib/definitionBDisplay.ts's resolveDefinitionBBaseCurrencies, that
// decides whether a cross-portfolio blended ticker may safely be opted in.
//
// No DB is touched here (matching this repo's established convention) —
// per-portfolio activation is exercised by building a Holding exactly as
// getPortfoliosWithHoldingsAndCash now does (base_currency set at
// construction, before any transaction is applied) and replaying through
// the real, already-tested applyTransactionToHolding /
// applyTransactionToHoldingResolvingTransfers. The cross-portfolio
// resolution rule is exercised directly and purely.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding, applyTransactionToHoldingResolvingTransfers } from '../../src/lib/queries';
import { applyTransferOut, applyTransferIn } from '../../src/lib/transferCostBasis';
import { resolveDefinitionBBaseCurrencies, type OpenCostContribution } from '../../src/lib/definitionBDisplay';
import {
  indexResolvedTransfersByOutTransactionId,
  type ResolvedTransferForReplay,
} from '../../src/lib/holdingsTransferIntegration';
import { makeHolding, makeTxn } from './helpers';

const OPEN_COST_TYPES = new Set(['BUY', 'SELL', 'TIN', 'TOT']);

describe('1. GBP portfolio / USD asset — reliable holding activates', () => {
  it('base_currency set at construction, base_total_cost and base_realised_value populate correctly', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 0, settle_value: 5000, settle_ccy: 'USD', cash_value: 4000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 100, settle_value: 5500, settle_ccy: 'USD', cash_value: 4400, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_realised_reliable).toBe(true);
    expect(holding.base_realised_value).toBeCloseTo(400, 6); // 4400 - (5000*0.8)
  });
});

describe('2. USD-base portfolio — reliable holding activates', () => {
  it('a EUR asset in a USD-base portfolio (the ETRO/SAP.DE shape, but reliable) activates correctly', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'EUR', cash_value: 1080, cash_ccy: 'USD', cash_fx_to_portfolio: 1.08 }));
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_total_cost).toBeCloseTo(1080, 6);
  });
});

describe('3. Same-currency holding', () => {
  it('a GBP asset in a GBP-base portfolio needs no FX — base cost equals native cost exactly', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 5, settle_value: 1005, settle_ccy: 'GBP', cash_value: 1005, cash_ccy: 'GBP' }));
    expect(holding.base_total_cost).toBe(holding.total_cost);
  });
});

describe('4. Resolved matched-transfer holding', () => {
  it('a linked TIN (via applyTransferIn) activates Definition B on the destination correctly', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD', base_currency: 'GBP', total_shares: 585, total_cost: 39359.472966, base_total_cost: 31306.52, base_cost_reliable: true });
    const parcel = applyTransferOut(source, 585);
    const dest = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD', base_currency: 'GBP' });
    applyTransferIn(dest, parcel);
    expect(dest.base_cost_reliable).toBe(true);
    expect(dest.base_total_cost).toBeCloseTo(31306.52, 6);
    expect(dest.total_cost).toBeCloseTo(39359.472966, 6); // native unaffected by activation
  });
});

describe('5. Verified-zero POLB.L shape', () => {
  it('a genuine £0 BUY remains reliable and available after activation, never unavailable', () => {
    const holding = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 48337, price: 0, fee: 0, settle_value: 0, settle_ccy: 'GBP', cash_value: 0, cash_ccy: 'GBP', cash_fx_to_portfolio: 0 }));
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_total_cost).toBe(0);
  });
});

describe('6. Unreliable SAP.DE shape', () => {
  it('the real SAP.DE BUY (cash_fx_to_portfolio = 0, EUR relabelled as USD) is unavailable, not fabricated', () => {
    const holding = makeHolding({ asset_id: 'sap', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 0.19605, price: 255.0369804, fee: 0, settle_value: 50.00000000742, settle_ccy: 'EUR', cash_value: 50, cash_ccy: 'USD', cash_fx_to_portfolio: 0 }));
    // The RELIABILITY FLAG, not the raw number, is what marks this
    // unavailable — base_total_cost legitimately starts at 0 for a fresh
    // holding regardless of reliability, exactly like POLB.L's genuine
    // verified zero (test 5). The distinguishing signal is
    // base_cost_reliable === false here vs === true there — never inferred
    // from the number alone.
    expect(holding.base_cost_reliable).toBe(false);
    expect(holding.base_avg_cost).toBeUndefined();
    expect(holding.total_cost).toBeCloseTo(50.00000000742, 6); // native unaffected
  });
});

describe('7. Realised-unreliable closed holding (PYPL/HVO/TSLA/UKW/VOD/TJX shape)', () => {
  it('an unresolved external TIN followed by a full SELL leaves base_realised_reliable permanently false after activation', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'HVO', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'TIN', quantity: 44000, settle_value: 12541, settle_ccy: 'GBP' })); // unresolved — no transfer record
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 44000, settle_value: 2022, settle_ccy: 'GBP', cash_value: 2022, cash_ccy: 'GBP' }));
    expect(holding.total_shares).toBe(0);
    expect(holding.base_cost_reliable).toBe(true); // open dimension resets on full close
    expect(holding.base_realised_reliable).toBe(false); // cumulative dimension stays tainted
    expect(holding.base_realised_value).toBe(0); // the skipped disposal contributed nothing — not fabricated
  });
});

describe('8. Global ticker with one base currency activates', () => {
  it('a single contributing portfolio resolves to its own base currency', () => {
    const contributions: OpenCostContribution[] = [
      { ticker: 'NVDA', type: 'BUY', portfolioId: 'p-ibkr-isa' },
      { ticker: 'NVDA', type: 'SELL', portfolioId: 'p-ibkr-isa' },
    ];
    const result = resolveDefinitionBBaseCurrencies(contributions, { 'p-ibkr-isa': 'GBP' }, OPEN_COST_TYPES);
    expect(result['NVDA']).toBe('GBP');
  });
});

describe('9. Global ticker spanning multiple portfolios with the SAME base currency activates', () => {
  it('two different GBP-base portfolios both contributing resolve cleanly to GBP, not MIXED', () => {
    const contributions: OpenCostContribution[] = [
      { ticker: 'SOFI', type: 'BUY', portfolioId: 'p-ibkr-isa' },
      { ticker: 'SOFI', type: 'BUY', portfolioId: 'p-t212-isa' },
      { ticker: 'SOFI', type: 'SELL', portfolioId: 'p-ibkr-isa' },
    ];
    const result = resolveDefinitionBBaseCurrencies(
      contributions,
      { 'p-ibkr-isa': 'GBP', 'p-t212-isa': 'GBP' },
      OPEN_COST_TYPES
    );
    expect(result['SOFI']).toBe('GBP');
  });
});

describe('10. Global ticker spanning GBP + USD base portfolios does NOT get a guessed base_currency', () => {
  it('resolves to undefined (never a guess) when contributing portfolios genuinely differ', () => {
    const contributions: OpenCostContribution[] = [
      { ticker: 'AMD', type: 'BUY', portfolioId: 'p-ibkr-trd' },   // GBP-base
      { ticker: 'AMD', type: 'BUY', portfolioId: 'p-etro-trd' },   // USD-base
      { ticker: 'AMD', type: 'SELL', portfolioId: 'p-ibkr-trd' },
    ];
    const result = resolveDefinitionBBaseCurrencies(
      contributions,
      { 'p-ibkr-trd': 'GBP', 'p-etro-trd': 'USD' },
      OPEN_COST_TYPES
    );
    expect(result['AMD']).toBeUndefined();

    // Confirm the downstream consequence: a holding built with base_currency
    // left unset (exactly what the caller does when the resolution is
    // undefined) never runs the Definition B block at all — legacy/dormant
    // behaviour, not a guess.
    const holding = makeHolding({ asset_id: 'amd', ticker: 'AMD', currency: 'USD' }); // no base_currency
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 10, price: 100, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'GBP' }));
    expect(holding.base_total_cost).toBeUndefined();
    expect(holding.base_cost_reliable).toBeUndefined();
  });
});

describe('11. Mixed-base decision is derived from data, not ticker names', () => {
  it('a completely made-up ticker with genuinely mixed contributions is also resolved to undefined — no special-casing', () => {
    const contributions: OpenCostContribution[] = [
      { ticker: 'ZZZ-NOT-A-REAL-TICKER', type: 'BUY', portfolioId: 'p1' },
      { ticker: 'ZZZ-NOT-A-REAL-TICKER', type: 'BUY', portfolioId: 'p2' },
    ];
    const result = resolveDefinitionBBaseCurrencies(contributions, { p1: 'GBP', p2: 'USD' }, OPEN_COST_TYPES);
    expect(result['ZZZ-NOT-A-REAL-TICKER']).toBeUndefined();
  });

  it('AMD/MARA/FUBO — the real-data mixed tickers — resolve to a real currency when their contributions are NOT actually mixed, proving no hard-coded exclusion exists', () => {
    for (const ticker of ['AMD', 'MARA', 'FUBO']) {
      const contributions: OpenCostContribution[] = [
        { ticker, type: 'BUY', portfolioId: 'p-single' },
        { ticker, type: 'SELL', portfolioId: 'p-single' },
      ];
      const result = resolveDefinitionBBaseCurrencies(contributions, { 'p-single': 'GBP' }, OPEN_COST_TYPES);
      expect(result[ticker]).toBe('GBP'); // resolved from the data given, not excluded by name
    }
  });

  it('DIV/INT/FEE contributions never influence the resolution (only BUY/SELL/TIN/TOT do)', () => {
    const contributions: OpenCostContribution[] = [
      { ticker: 'FOO', type: 'BUY', portfolioId: 'p1' },
      { ticker: 'FOO', type: 'DIV', portfolioId: 'p2' }, // a different-currency portfolio, but DIV doesn't touch cost
      { ticker: 'FOO', type: 'FEE', portfolioId: 'p2' },
    ];
    const result = resolveDefinitionBBaseCurrencies(contributions, { p1: 'GBP', p2: 'USD' }, OPEN_COST_TYPES);
    expect(result['FOO']).toBe('GBP'); // p2's DIV/FEE-only activity is correctly irrelevant
  });
});

describe('12. Native ledger unchanged after activation', () => {
  it('identical transaction sequences applied to an activated vs a dormant holding produce byte-identical native fields', () => {
    const txns = [
      makeTxn({ id: 't1', type: 'BUY', quantity: 100, price: 50, fee: 1, settle_value: 5001, settle_ccy: 'USD', cash_value: 4000.8, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }),
      makeTxn({ id: 't2', type: 'SELL', quantity: 40, settle_value: 2200, settle_ccy: 'USD', cash_value: 1760, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }),
      makeTxn({ id: 't3', type: 'BUY', quantity: 20, price: 60, fee: 0, settle_value: 1200, settle_ccy: 'USD', cash_value: 960, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }),
    ];

    const dormant = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' }); // no base_currency
    const activated = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });

    for (const t of txns) {
      applyTransactionToHolding(dormant, t);
      applyTransactionToHolding(activated, t);
    }

    for (const field of ['total_shares', 'total_cost', 'avg_price', 'realised_value', 'realised_cost', 'realised_proceeds'] as const) {
      expect(activated[field]).toBe(dormant[field]);
    }
  });

  it('holds equally true through the resolved-transfer dispatch (applyTransactionToHoldingResolvingTransfers)', () => {
    const txn = makeTxn({ id: 'tin-1', type: 'TIN', quantity: 100, settle_value: 5000, settle_ccy: 'USD' }); // unresolved TIN

    const dormant = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    const activated = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });

    applyTransactionToHoldingResolvingTransfers(dormant, txn, new Map());
    applyTransactionToHoldingResolvingTransfers(activated, txn, new Map());

    expect(activated.total_shares).toBe(dormant.total_shares);
    expect(activated.total_cost).toBe(dormant.total_cost);
  });
});

// ---------------------------------------------------------------------------
// 13. Resolved TOT correction (blended/global-view reliability)
//
// Found during live local-dev verification: POLB.L showed base_cost_reliable
// = true in every per-portfolio view but = false in the blended/global view,
// even though its transfer (HGLD ISA STK -> IBKR ISA STK) is fully resolved
// with a verified £0 base cost. Root cause: the plain TOT branch in
// applyTransactionToHolding unconditionally marks base_cost_reliable false,
// and that taint only clears via the "position fully closed" reset
// (total_shares === 0). In a single-portfolio replay a TOT that empties that
// portfolio's own position genuinely does reach zero, masking the taint. In
// the blended replay, the SAME ticker held by other portfolios means the
// pooled total_shares essentially never lands on exactly zero at the moment
// of an internal TOT, so the taint became permanent — even though the
// transfer's true cost is fully known via its frozen parcel. These tests
// reproduce that exact shape and confirm the fix (applyTransactionToHoldingResolvingTransfers's
// resolved-TOT correction, queries.ts) resolves it without breaking the
// already-correct full-close case or laundering unrelated pre-existing taint.
// ---------------------------------------------------------------------------
describe('13. Resolved TOT correction (blended/global-view reliability)', () => {
  it('POLB.L shape: a resolved TOT that only partially empties a blended pool no longer permanently taints base_cost_reliable', () => {
    const resolvedTotTransfers = indexResolvedTransfersByOutTransactionId([
      {
        id: 'transfer-polb', status: 'matched', out_transaction_id: 'tot-polb', in_transaction_id: 'tin-polb',
        quantity: 48337, native_cost: 0, native_ccy: 'GBP', base_cost: 0, base_ccy: 'GBP',
      } as ResolvedTransferForReplay,
    ]);

    const holding = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP', base_currency: 'GBP' });
    // Other contributing portfolios' shares, already accumulated before the
    // TOT — this is what stops the blended pool from ever reaching zero at
    // the TOT itself.
    applyTransactionToHoldingResolvingTransfers(holding, makeTxn({ id: 'buy-other-1', type: 'BUY', quantity: 18398, cash_value: 0, cash_ccy: 'GBP' }), new Map(), new Map());
    applyTransactionToHoldingResolvingTransfers(holding, makeTxn({ id: 'buy-other-2', type: 'BUY', quantity: 15513.14, cash_value: 0, cash_ccy: 'GBP' }), new Map(), new Map());
    // The source portfolio's own shares, about to be transferred.
    applyTransactionToHoldingResolvingTransfers(holding, makeTxn({ id: 'buy-source', type: 'BUY', quantity: 48337, cash_value: 0, cash_ccy: 'GBP' }), new Map(), new Map());
    expect(holding.base_cost_reliable).toBe(true); // sanity: still reliable going into the TOT

    const totTxn = makeTxn({ id: 'tot-polb', type: 'TOT', quantity: 48337, cash_value: 0, cash_ccy: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(holding, totTxn, new Map(), resolvedTotTransfers);

    expect(holding.total_shares).toBeCloseTo(18398 + 15513.14, 6); // not zero — the full-close reset never fires here
    expect(holding.base_cost_reliable).toBe(true); // FIXED: known £0 parcel no longer permanently taints the pool
    expect(holding.base_total_cost).toBeCloseTo(0, 6); // verified £0 — must remain valid, not "incomplete"
  });

  it('PLTR shape: a resolved TOT that exactly empties the pool relies on the existing full-close reset, not a double correction', () => {
    const resolvedTotTransfers = indexResolvedTransfersByOutTransactionId([
      {
        id: 'transfer-pltr', status: 'matched', out_transaction_id: 'tot-pltr', in_transaction_id: 'tin-pltr',
        quantity: 585, native_cost: 39359.472966, native_ccy: 'USD', base_cost: 31306.52, base_ccy: 'GBP',
      } as ResolvedTransferForReplay,
    ]);
    const holding = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(
      holding,
      makeTxn({ id: 'buy-pltr', type: 'BUY', quantity: 585, settle_value: 39359.472966, settle_ccy: 'USD', cash_value: 31306.52, cash_ccy: 'GBP' }),
      new Map(),
      new Map()
    );

    const totTxn = makeTxn({ id: 'tot-pltr', type: 'TOT', quantity: 585, cash_value: 0, cash_ccy: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(holding, totTxn, new Map(), resolvedTotTransfers);

    expect(holding.total_shares).toBe(0);
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_total_cost).toBe(0); // already zeroed by the existing full-close reset — the correction must not subtract again
  });

  it('a resolved TOT with a known base cost does not repair unrelated pre-existing unreliability (no laundering)', () => {
    const resolvedTotTransfers = indexResolvedTransfersByOutTransactionId([
      {
        id: 'transfer-x', status: 'matched', out_transaction_id: 'tot-x', in_transaction_id: 'tin-x',
        quantity: 100, native_cost: 500, native_ccy: 'GBP', base_cost: 500, base_ccy: 'GBP',
      } as ResolvedTransferForReplay,
    ]);
    const holding = makeHolding({ asset_id: 'x', ticker: 'X', currency: 'GBP', base_currency: 'GBP' });
    // An earlier, unrelated unresolved TIN legitimately taints the holding first.
    applyTransactionToHoldingResolvingTransfers(
      holding,
      makeTxn({ id: 'tin-unresolved', type: 'TIN', quantity: 200, settle_value: 1000, settle_ccy: 'GBP' }),
      new Map(),
      new Map()
    );
    expect(holding.base_cost_reliable).toBe(false); // sanity

    const totTxn = makeTxn({ id: 'tot-x', type: 'TOT', quantity: 100, cash_value: 0, cash_ccy: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(holding, totTxn, new Map(), resolvedTotTransfers);

    expect(holding.total_shares).toBeCloseTo(100, 6); // not zero
    expect(holding.base_cost_reliable).toBe(false); // stays tainted — a known OUT parcel cannot retroactively repair a different, unrelated gap
  });

  it('a resolved TOT whose parcel carries no known base cost leaves the conservative taint in place', () => {
    const resolvedTotTransfers = indexResolvedTransfersByOutTransactionId([
      {
        id: 'transfer-y', status: 'external_out', out_transaction_id: 'tot-y', in_transaction_id: null,
        quantity: 50, native_cost: 250, native_ccy: 'GBP', base_cost: null, base_ccy: null,
      } as ResolvedTransferForReplay,
    ]);
    const holding = makeHolding({ asset_id: 'y', ticker: 'Y', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(
      holding,
      makeTxn({ id: 'buy-y', type: 'BUY', quantity: 100, cash_value: 500, cash_ccy: 'GBP' }),
      new Map(),
      new Map()
    );
    expect(holding.base_cost_reliable).toBe(true);

    const totTxn = makeTxn({ id: 'tot-y', type: 'TOT', quantity: 50, cash_value: 0, cash_ccy: 'GBP' });
    applyTransactionToHoldingResolvingTransfers(holding, totTxn, new Map(), resolvedTotTransfers);

    expect(holding.total_shares).toBeCloseTo(50, 6); // not zero
    expect(holding.base_cost_reliable).toBe(false); // resolved != known base cost — stays conservative, never guessed
  });
});
