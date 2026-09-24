// IMPORT ROUTE — confirm-stage row construction: CURRENT behaviour (Phase 0 safety net)
//
// Characterises exactly what POST /api/import-transactions?stage=confirm passes
// to transactions.insert() today, before its row-building logic is extracted
// or refactored (cleanup item B9). See docs/ACCOUNTING.md §2 and §12.
//
// These tests describe CURRENT behaviour. Several pin known defects; those are
// labelled "KNOWN DEFECT Cn" and cross-reference
// tests/financial/known-defects.characterisation.spec.ts. A passing test here
// does NOT mean the behaviour is correct or approved. An approved behavioural
// fix must update the affected test in the same commit, citing the decision.
//
// Isolation:
//   - the session and the service-role Supabase client are mocked; the client
//     is the in-memory fake from ./importRouteHarness.ts;
//   - processImportedTransfers is stubbed (transfer persistence is out of scope);
//   - every network-capable dependency (yahoo-finance2, the Finnhub/logo
//     helpers, domain enrichment, global fetch) is replaced by a stub that
//     records and throws, and every test asserts none of them was called;
//   - only existing tickers are used, so no asset-creation path runs.
//
// C15 (FIXED 2026-09-24, Option A): a BLANK cash_value or fxrate cell means
// "not supplied" (null); an explicit 0 means zero. Before the fix a blank cell
// was coerced to 0. Regression tests are in the "C15" describe block below:
//   - BUY/SELL with blank cash and blank fxrate can reach the cached fx_rates
//     step (a SELL still uses C1 net proceeds);
//   - DIV/INT/DEP/WIT/FEE/OTR and FXM with a blank cash_value are NOT imported:
//     they are reported in skippedCashLeg, never given an estimated amount;
//   - security TIN/TOT with a blank cash_value store null (no cash amount is
//     invented for a non-cash transfer); settle_value is unchanged;
//   - cash_fx_to_portfolio stores null, not 0, where a blank CSV fxrate is copied.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createImportFake, confirmRequest, toCsv, type Row } from './importRouteHarness';

const h = vi.hoisted(() => ({
  client: null as any,
  networkCalls: [] as string[],
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => h.client),
}));

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServerClient: vi.fn(async () => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
  })),
}));

vi.mock('@/lib/transferImportIntegration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/transferImportIntegration')>();
  return {
    ...actual,
    processImportedTransfers: vi.fn(async () => ({ created: [], suggestions: {}, errors: [] })),
  };
});

vi.mock('yahoo-finance2', () => ({
  default: {
    quoteSummary: vi.fn(() => {
      h.networkCalls.push('yahoo-finance2.quoteSummary');
      throw new Error('network blocked in tests');
    }),
  },
}));

vi.mock('@/lib/logo', () => ({
  fetchCompanyWeburlFromFinnhub: vi.fn(() => {
    h.networkCalls.push('logo.fetchCompanyWeburlFromFinnhub');
    throw new Error('network blocked in tests');
  }),
}));

vi.mock('@/lib/newAssetDomainEnrichment', () => ({
  enrichNewAssetDomain: vi.fn(() => {
    h.networkCalls.push('newAssetDomainEnrichment.enrichNewAssetDomain');
    throw new Error('network blocked in tests');
  }),
}));

import { POST } from '../../src/app/api/import-transactions/route';
import { processImportedTransfers } from '@/lib/transferImportIntegration';

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const PORTFOLIOS: Row[] = [
  { id: 'p-gbp', name: 'ISA Account', base_currency: 'GBP', user_id: 'user-1' },
  { id: 'p-usd', name: 'US Book', base_currency: 'USD', user_id: 'user-1' },
  { id: 'p-other-user', name: 'Someone Else', base_currency: 'GBP', user_id: 'user-2' },
];

const ASSETS: Row[] = [
  { id: 'a-vod', ticker: 'VOD.L', currency: 'GBP', status: 'active', resolved_ticker: null },
  { id: 'a-aapl', ticker: 'AAPL', currency: 'USD', status: 'active', resolved_ticker: null },
  { id: 'a-cash-gbp', ticker: 'CASH.GBP', currency: 'GBP', status: 'active', resolved_ticker: null },
  { id: 'a-cash-usd', ticker: 'CASH.USD', currency: 'USD', status: 'active', resolved_ticker: null },
];

const NO_CACHE_DATE = '2024-03-01';
const CACHE_DATE = '2024-03-04'; // fx_rates has GBPUSD 1.25 -> USD->GBP 0.8
const FX_RATES: Row[] = [{ date: CACHE_DATE, quotes: { GBPUSD: 1.25 } }];

const BASE_TIME_MS = Date.UTC(2026, 8, 24, 12, 0, 0); // fixed "now" for created_at staggering

const COLUMNS = ['portfolio', 'ticker', 'transaction_type', 'date_time', 'quantity', 'price', 'fee', 'fxrate', 'cash_value', 'notes'];

type CsvRow = Partial<Record<string, string | number>>;

async function importCsv(rows: CsvRow[], extraColumns: string[] = []) {
  const header = [...COLUMNS, ...extraColumns];
  const csv = toCsv(header, rows.map((r) => header.map((c) => r[c] ?? '')));
  const fake = createImportFake({ portfolios: PORTFOLIOS, assets: ASSETS, asset_aliases: [], fx_rates: FX_RATES });
  h.client = fake.client;
  const res = await POST(confirmRequest(csv) as any);
  const body = await res.json();
  return { status: res.status, body, inserted: fake.transactionInserts[0] ?? [], fake };
}

/** Inserted row without created_at (asserted separately in its own test). */
function noCreatedAt(r: Row): Row {
  const { created_at: _ignored, ...rest } = r;
  return rest;
}

/** The exact inserted-row shape, with the common defaults filled in. */
function expectedRow(o: Row): Row {
  return {
    portfolio_id: 'p-gbp',
    date: NO_CACHE_DATE,
    notes: '',
    split_factor: null,
    ...o,
  };
}

const gbp = (o: CsvRow): CsvRow => ({ portfolio: 'ISA Account', date_time: NO_CACHE_DATE, ...o });

beforeEach(() => {
  h.networkCalls.length = 0;
  vi.stubEnv('SUPABASE_URL', 'http://fake-supabase.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role-key');
  vi.stubGlobal('fetch', vi.fn(() => {
    h.networkCalls.push('fetch');
    throw new Error('network blocked in tests');
  }));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_TIME_MS);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(processImportedTransfers).mockClear();
});

afterEach(() => {
  expect(h.networkCalls).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Same-currency BUY / SELL
// ---------------------------------------------------------------------------

describe('import confirm — same-currency BUY/SELL (GBP asset, GBP portfolio)', () => {
  it('BUY with explicit cash: cash_value is the explicit value; settle_value = qty*price+fee; fx = cash/settle', async () => {
    const { status, inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1004.5 })]);
    expect(status).toBe(200);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1004.5, cash_ccy: 'GBP', settle_value: 1005, settle_ccy: 'GBP', cash_fx_to_portfolio: 1004.5 / 1005 }),
    ]);
  });

  it('BUY with blank cash (not supplied): same-currency fallback stores cash_value = qty*price+fee with fx 1', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 5 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1005, cash_ccy: 'GBP', settle_value: 1005, settle_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    ]);
  });

  it('SELL with explicit cash: cash_value is the explicit net proceeds; settle_value is still qty*price+fee (not net)', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'SELL', quantity: 40, price: 12, fee: 3, cash_value: 477 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'SELL', quantity: 40, price: 12, fee: 3, cash_value: 477, cash_ccy: 'GBP', settle_value: 483, settle_ccy: 'GBP', cash_fx_to_portfolio: 477 / 483 }),
    ]);
  });

  it('C1 (fixed): SELL with blank cash stores net proceeds qty*price-fee = 477.00; settle_value stays qty*price+fee = 483.00', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'SELL', quantity: 40, price: 12, fee: 3 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'SELL', quantity: 40, price: 12, fee: 3, cash_value: 477, cash_ccy: 'GBP', settle_value: 483, settle_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    ]);
  });

  it('C1 (fixed): SELL with blank cash and fee >= qty*price is BLOCKED (skippedCashLeg), not given invented cash', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'SELL', quantity: 1, price: 2, fee: 3 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    expect(inserted.map((r) => r.type)).toEqual(['BUY']);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'VOD.L', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: 'Net sale proceeds (quantity x price - fee) are not positive and no explicit cash value was supplied.' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cross-currency BUY / SELL (USD asset, GBP portfolio)
// ---------------------------------------------------------------------------

describe('import confirm — cross-currency BUY/SELL (USD asset, GBP portfolio)', () => {
  it('explicit positive cash is used for both BUY and SELL; settle stays in USD', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2, cash_value: 1185.98 }),
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', quantity: 10, price: 150, fee: 10, cash_value: 1192 }),
    ]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-aapl', type: 'BUY', quantity: 10, price: 150, fee: 2, cash_value: 1185.98, cash_ccy: 'GBP', settle_value: 1502, settle_ccy: 'USD', cash_fx_to_portfolio: 1185.98 / 1502 }),
      expectedRow({ asset_id: 'a-aapl', type: 'SELL', quantity: 10, price: 150, fee: 10, cash_value: 1192, cash_ccy: 'GBP', settle_value: 1510, settle_ccy: 'USD', cash_fx_to_portfolio: 1192 / 1510 }),
    ]);
  });

  it('explicit fxrate with blank cash: BUY cash_value = (qty*price+fee) x rate; SELL (C1 fixed) = (qty*price-fee) x rate', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2, fxrate: 0.8 }),
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', quantity: 10, price: 150, fee: 10, fxrate: 0.8 }),
    ]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-aapl', type: 'BUY', quantity: 10, price: 150, fee: 2, cash_value: 1502 * 0.8, cash_ccy: 'GBP', settle_value: 1502, settle_ccy: 'USD', cash_fx_to_portfolio: 0.8 }),
      expectedRow({ asset_id: 'a-aapl', type: 'SELL', quantity: 10, price: 150, fee: 10, cash_value: 1490 * 0.8, cash_ccy: 'GBP', settle_value: 1510, settle_ccy: 'USD', cash_fx_to_portfolio: 0.8 }),
    ]);
  });

  it('C15 (fixed): blank cash and blank fxrate on a date WITH a cached rate use the cached rate (USD->GBP 0.8); the SELL keeps C1 net proceeds', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 2 }),
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 10 }),
    ]);
    expect(status).toBe(200);
    expect(body.skippedCashLeg).toEqual([]);
    // BUY: (1,500 + 2) USD x 0.8 = £1,201.60 paid. SELL: (1,500 - 10) USD x 0.8 = £1,192.00 received.
    expect(inserted[0].cash_value).toBeCloseTo(1201.6, 10);
    expect(inserted[1].cash_value).toBeCloseTo(1192.0, 10);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ date: CACHE_DATE, asset_id: 'a-aapl', type: 'BUY', quantity: 10, price: 150, fee: 2, cash_value: inserted[0].cash_value, cash_ccy: 'GBP', settle_value: 1502, settle_ccy: 'USD', cash_fx_to_portfolio: 0.8 }),
      expectedRow({ date: CACHE_DATE, asset_id: 'a-aapl', type: 'SELL', quantity: 10, price: 150, fee: 10, cash_value: inserted[1].cash_value, cash_ccy: 'GBP', settle_value: 1510, settle_ccy: 'USD', cash_fx_to_portfolio: 0.8 }),
    ]);
  });

  it('no usable rate: BUY and SELL are BLOCKED, reported in skippedCashLeg and NOT inserted; other rows still import', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2 }),
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', quantity: 10, price: 150, fee: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    const reason = 'No reliable USD->GBP conversion is available for this transaction (no explicit cash value, no FX rate, and no cached rate for the trade date).';
    expect(status).toBe(200);
    expect(inserted.map((r) => r.asset_id)).toEqual(['a-vod']);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'AAPL', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason },
      { row: 3, ticker: 'AAPL', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason },
    ]);
    expect(body.message).toBe('Imported 1 transaction. 2 rows skipped — no reliable currency conversion (see skippedCashLeg).');
  });

  it('when EVERY row is blocked: HTTP 400 "No transactions to insert" and no insert call at all', async () => {
    const { status, body, fake } = await importCsv([gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2 })]);
    expect(status).toBe(400);
    expect(body.message).toBe('No transactions to insert');
    expect(body.skippedCashLeg).toHaveLength(1);
    expect(fake.transactionInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative / non-positive explicit cash on BUY/SELL
// ---------------------------------------------------------------------------

describe('import confirm — CURRENT handling of a negative explicit cash_value on BUY/SELL', () => {
  it('same-currency: the negative explicit value is ignored and the qty*price+fee fallback is stored', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: -1004.5 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1005, cash_ccy: 'GBP', settle_value: 1005, settle_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    ]);
  });

  it('cross-currency with an fxrate: the negative explicit value is ignored and the fxrate conversion is stored', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2, fxrate: 0.8, cash_value: -1185.98 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-aapl', type: 'BUY', quantity: 10, price: 150, fee: 2, cash_value: 1502 * 0.8, cash_ccy: 'GBP', settle_value: 1502, settle_ccy: 'USD', cash_fx_to_portfolio: 0.8 }),
    ]);
  });

  it('cross-currency with NO fxrate on a date that HAS a cached rate: BLOCKED (the cache is consulted only when cash_value is null)', async () => {
    const { status, body, fake } = await importCsv([gbp({ ticker: 'AAPL', transaction_type: 'BUY', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 2, cash_value: -1185.98 })]);
    expect(status).toBe(400);
    expect(body.skippedCashLeg).toEqual([
      {
        row: 2,
        ticker: 'AAPL',
        date: CACHE_DATE,
        portfolio: 'ISA Account',
        reason: 'No reliable USD->GBP conversion is available for this transaction (no explicit cash value, no FX rate, and no cached rate for the trade date).',
      },
    ]);
    expect(fake.transactionInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Signed cash-impact types, FXM, SPL
// ---------------------------------------------------------------------------

describe('import confirm — signed cash-impact types', () => {
  it('CURRENT BEHAVIOUR — cross-reference KNOWN DEFECT C3: a negative DIV cash_value is STORED signed (-5.00, fx -1); the cash engine later adds abs()', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0, cash_value: -5 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'DIV', quantity: 1, price: 5, fee: 0, cash_value: -5, cash_ccy: 'GBP', settle_value: 5, settle_ccy: 'GBP', cash_fx_to_portfolio: -1 }),
    ]);
  });

  it('C15 (fixed): a same-currency OTR with blank cash is NOT imported (its sign is unknown, so no amount is estimated) and is reported', async () => {
    const { status, body, fake } = await importCsv([gbp({ ticker: 'CASH.GBP', transaction_type: 'OTR', quantity: 1, price: 0.02, fee: 0 })]);
    expect(status).toBe(400);
    expect(fake.transactionInserts).toHaveLength(0);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: 'cash_value is required for OTR rows and was blank; the row was not imported.' },
    ]);
  });

  it('CURRENT BEHAVIOUR — KNOWN DEFECT C9 (not desired): DIV and CASH.* TOT with explicit cash but qty*price+fee = 0 are BLOCKED', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 0, price: 0, fee: 0, cash_value: 12.5 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'TOT', quantity: 0, price: 0, fee: 0, cash_value: 100 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    const reason = 'No settlement amount to derive a cash leg from.';
    expect(inserted.map((r) => r.type)).toEqual(['BUY']);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'VOD.L', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason },
      { row: 3, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason },
    ]);
  });
});

describe('import confirm — FXM (ungated)', () => {
  it('a signed FXM cash_value passes through unchanged; cash_ccy is the portfolio currency; a blank fxrate is stored as null (C15 fixed)', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 0, price: 0, fee: 0, cash_value: -12.34 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-cash-gbp', type: 'FXM', quantity: 0, price: 0, fee: 0, cash_value: -12.34, cash_ccy: 'GBP', settle_value: 0, settle_ccy: 'GBP', cash_fx_to_portfolio: null }),
    ]);
  });

  it('an unvalidated CSV fxrate is stored as-is on FXM', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 1, price: 3, fee: 0, fxrate: 0.5, cash_value: 2.5 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-cash-gbp', type: 'FXM', quantity: 1, price: 3, fee: 0, cash_value: 2.5, cash_ccy: 'GBP', settle_value: 3, settle_ccy: 'GBP', cash_fx_to_portfolio: 0.5 }),
    ]);
  });

  it('C15 (fixed): FXM with blank cash is NOT imported (quantity x price is never used as an FX gain/loss) and is reported', async () => {
    const { status, body, fake } = await importCsv([gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 1, price: 3, fee: 0, fxrate: 0.5 })]);
    expect(status).toBe(400);
    expect(fake.transactionInserts).toHaveLength(0);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: 'cash_value is required for FXM rows and was blank; the row was not imported.' },
    ]);
  });
});

describe('import confirm — SPL', () => {
  it('split_factor comes from the CSV quantity; quantity/price/fee/settle_value are zeroed; cash_value/cash_ccy are null; fx is the raw CSV fxrate (blank -> null, C15 fixed)', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 2, price: 99, fee: 1 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'SPL', quantity: 0, price: 0, fee: 0, cash_value: null, cash_ccy: null, settle_value: 0, settle_ccy: 'GBP', cash_fx_to_portfolio: null, split_factor: 2 }),
    ]);
  });

  it('CURRENT behaviour: an SPL with a zero ratio aborts the WHOLE import with HTTP 500, inserting nothing (valid rows included)', async () => {
    const { status, body, fake } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0 }),
    ]);
    expect(status).toBe(500);
    expect(body.message).toBe('Server error during import');
    expect(fake.transactionInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Currencies, ignored columns, ordering, transfers, parsing
// ---------------------------------------------------------------------------

describe('import confirm — currencies and ignored CSV columns', () => {
  it('CSV settle_value / settle_ccy / cash_ccy columns are ignored: settle_value is recomputed, settle_ccy is the asset currency, cash_ccy the portfolio base', async () => {
    const { inserted } = await importCsv(
      [gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 5, settle_value: 999999, settle_ccy: 'EUR', cash_ccy: 'USD' })],
      ['settle_value', 'settle_ccy', 'cash_ccy']
    );
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1005, cash_ccy: 'GBP', settle_value: 1005, settle_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    ]);
  });

  it('cash_ccy is always the portfolio base currency (USD portfolio buying a GBP asset: cash_ccy USD, settle_ccy GBP)', async () => {
    const { inserted } = await importCsv([
      { portfolio: 'US Book', date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1300 },
    ]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ portfolio_id: 'p-usd', asset_id: 'a-vod', type: 'BUY', quantity: 100, price: 10, fee: 5, cash_value: 1300, cash_ccy: 'USD', settle_value: 1005, settle_ccy: 'GBP', cash_fx_to_portfolio: 1300 / 1005 }),
    ]);
  });
});

describe('import confirm — created_at staggering', () => {
  it('each inserted row gets now + (its index among INSERTED rows) ms, in CSV order; a blocked row does not consume an index', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 100, price: 10, fee: 0, cash_value: 1000 }),
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2 }), // blocked: no rate
      gbp({ ticker: 'VOD.L', transaction_type: 'SELL', quantity: 40, price: 12, fee: 0, cash_value: 480 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'DEP', quantity: 1, price: 100, fee: 0, cash_value: 100 }),
    ]);
    expect(inserted.map((r) => r.type)).toEqual(['BUY', 'SELL', 'DEP']);
    expect(inserted.map((r) => r.created_at)).toEqual([
      new Date(BASE_TIME_MS + 0).toISOString(),
      new Date(BASE_TIME_MS + 1).toISOString(),
      new Date(BASE_TIME_MS + 2).toISOString(),
    ]);
  });
});

describe('import confirm — security TIN/TOT (ungated)', () => {
  it('a security TIN is never FX-gated or blocked, even for a USD asset with no rate; blank cash is stored as null (C15 fixed); settle_value = qty*price+fee in the asset currency', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'TIN', quantity: 10, price: 5, fee: 0 }),
      gbp({ ticker: 'AAPL', transaction_type: 'TIN', quantity: 10, price: 150, fee: 0 }),
      gbp({ ticker: 'AAPL', transaction_type: 'TIN', quantity: 10, price: 150, fee: 0, cash_value: 1500 }),
    ]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'TIN', quantity: 10, price: 5, fee: 0, cash_value: null, cash_ccy: 'GBP', settle_value: 50, settle_ccy: 'GBP', cash_fx_to_portfolio: null }),
      expectedRow({ asset_id: 'a-aapl', type: 'TIN', quantity: 10, price: 150, fee: 0, cash_value: null, cash_ccy: 'GBP', settle_value: 1500, settle_ccy: 'USD', cash_fx_to_portfolio: null }),
      // CURRENT behaviour: an explicit value is stored as supplied and labelled with the portfolio
      // currency, without conversion. Nothing downstream reads a security TIN's cash_value.
      expectedRow({ asset_id: 'a-aapl', type: 'TIN', quantity: 10, price: 150, fee: 0, cash_value: 1500, cash_ccy: 'GBP', settle_value: 1500, settle_ccy: 'USD', cash_fx_to_portfolio: null }),
    ]);
    expect(vi.mocked(processImportedTransfers)).toHaveBeenCalledTimes(1);
  });

  it('a generic "transfer" row with negative quantity becomes a TOT with the absolute quantity', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'transfer', quantity: -10, price: 5, fee: 0 })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'TOT', quantity: 10, price: 5, fee: 0, cash_value: null, cash_ccy: 'GBP', settle_value: 50, settle_ccy: 'GBP', cash_fx_to_portfolio: null }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// C15 regression: blank means "not supplied"; explicit 0 means zero
// ---------------------------------------------------------------------------

describe('import confirm — C15: blank cells are "not supplied", an explicit 0 is zero', () => {
  const blankCashReason = (type: string) => `cash_value is required for ${type} rows and was blank; the row was not imported.`;

  it('blank cash_value != explicit 0 (cross-currency BUY, cached-rate date): blank reaches the cached rate; explicit 0 is not a usable amount and does not', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 2 }),
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 2, cash_value: 0 }),
    ]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].cash_value).toBeCloseTo(1201.6, 10); // (1,500 + 2) USD x 0.8
    expect(inserted[0].cash_fx_to_portfolio).toBe(0.8);
    expect(body.skippedCashLeg.map((s: any) => s.row)).toEqual([3]);
  });

  it('blank cash_value != explicit 0 (DIV): an explicit 0 is imported as an intentional zero; a blank is skipped', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0, cash_value: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0 }),
    ]);
    expect(inserted.map((r) => [r.type, r.cash_value])).toEqual([['DIV', 0]]);
    expect(body.skippedCashLeg).toEqual([
      { row: 3, ticker: 'VOD.L', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('DIV') },
    ]);
  });

  it('explicit 0 remains an intentional zero on FXM and on a security TIN', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 0, price: 0, fee: 0, cash_value: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TIN', quantity: 10, price: 5, fee: 0, cash_value: 0 }),
    ]);
    expect(inserted.map((r) => [r.type, r.cash_value])).toEqual([
      ['FXM', 0],
      ['TIN', 0],
    ]);
  });

  it('blank fxrate != explicit 0: pass-through types (FXM, security TIN/TOT, SPL) store null for a blank and 0 for an explicit 0', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 0, price: 0, fee: 0, cash_value: -1 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 0, price: 0, fee: 0, cash_value: -1, fxrate: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TIN', quantity: 10, price: 5, fee: 0, cash_value: 50 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TIN', quantity: 10, price: 5, fee: 0, cash_value: 50, fxrate: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TOT', quantity: 10, price: 5, fee: 0, cash_value: 50 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TOT', quantity: 10, price: 5, fee: 0, cash_value: 50, fxrate: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 2 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 2, fxrate: 0 }),
    ]);
    expect(inserted.map((r) => [r.type, r.cash_fx_to_portfolio])).toEqual([
      ['FXM', null], ['FXM', 0],
      ['TIN', null], ['TIN', 0],
      ['TOT', null], ['TOT', 0],
      ['SPL', null], ['SPL', 0],
    ]);
  });

  it('cross-currency SELL on a cached-rate date: blank fxrate uses the cached rate and C1 net proceeds; an explicit 0 fxrate is (by existing design) equally unusable as a conversion rate, so it also falls to the cache', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 10 }),
      gbp({ ticker: 'AAPL', transaction_type: 'SELL', date_time: CACHE_DATE, quantity: 10, price: 150, fee: 10, fxrate: 0 }),
    ]);
    expect(body.skippedCashLeg).toEqual([]);
    // (1,500 - 10) USD x 0.8 = £1,192.00 net proceeds (C1), not (1,500 + 10) x 0.8 = £1,208.00.
    expect(inserted[0].cash_value).toBeCloseTo(1192.0, 10);
    expect(inserted[1].cash_value).toBeCloseTo(1192.0, 10);
    expect(inserted.map((r) => r.cash_fx_to_portfolio)).toEqual([0.8, 0.8]);
  });

  it('blank-cash DIV/INT/DEP/WIT/FEE/OTR/FXM rows are not imported, each is reported with a clear reason, and valid rows in the same import still import', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0 }),
      gbp({ ticker: 'AAPL', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0, fxrate: 0.8 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'INT', quantity: 1, price: 1.23, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'DEP', quantity: 1, price: 100, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'WIT', quantity: 1, price: 50, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FEE', quantity: 1, price: 3, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'OTR', quantity: 1, price: 0.02, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 1, price: 3, fee: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'DEP', quantity: 1, price: 100, fee: 0, cash_value: 100 }),
    ]);
    expect(status).toBe(200);
    expect(inserted.map((r) => [r.type, r.cash_value])).toEqual([
      ['BUY', 10],
      ['DEP', 100],
    ]);
    expect(body.skippedCashLeg).toEqual([
      { row: 2, ticker: 'VOD.L', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('DIV') },
      { row: 3, ticker: 'AAPL', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('DIV') },
      { row: 4, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('INT') },
      { row: 5, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('DEP') },
      { row: 6, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('WIT') },
      { row: 7, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('FEE') },
      { row: 8, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('OTR') },
      { row: 9, ticker: 'CASH.GBP', date: NO_CACHE_DATE, portfolio: 'ISA Account', reason: blankCashReason('FXM') },
    ]);
  });

  it('security TIN/TOT with blank cash are still imported, never FX-gated; cash_value is null (not 0, not an estimate); units and settle-side cost are unchanged', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'TIN', quantity: 10, price: 150, fee: 1 }),
      gbp({ ticker: 'AAPL', transaction_type: 'TOT', quantity: 4, price: 150, fee: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'TIN', quantity: 10, price: 5, fee: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'transfer', quantity: -10, price: 5, fee: 0 }),
    ]);
    expect(body.skippedCashLeg).toEqual([]);
    expect(inserted.map((r) => [r.type, r.quantity, r.cash_value, r.settle_value, r.settle_ccy])).toEqual([
      ['TIN', 10, null, 1501, 'USD'],
      ['TOT', 4, null, 600, 'USD'],
      ['TIN', 10, null, 50, 'GBP'],
      ['TOT', 10, null, 50, 'GBP'],
    ]);
  });

  it('skipped-row summary: blank-required-cash rows are not described as a currency-conversion problem', async () => {
    const { body } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'DIV', quantity: 1, price: 5, fee: 0 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'OTR', quantity: 1, price: 0.02, fee: 0 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    expect(body.message).toBe('Imported 1 transaction. 2 rows skipped — required cash_value was blank (see skippedCashLeg).');
  });

  it('skipped-row summary: mixed reasons are counted separately, not given a single explanation', async () => {
    const { body } = await importCsv([
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2 }), // no usable rate
      gbp({ ticker: 'CASH.GBP', transaction_type: 'FXM', quantity: 1, price: 3, fee: 0 }), // blank required cash
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    expect(body.message).toBe('Imported 1 transaction. 1 row skipped — no reliable currency conversion; 1 row skipped — required cash_value was blank (see skippedCashLeg).');
    expect(body.skippedCashLeg.map((s: any) => s.reason)).toEqual([
      'No reliable USD->GBP conversion is available for this transaction (no explicit cash value, no FX rate, and no cached rate for the trade date).',
      'cash_value is required for FXM rows and was blank; the row was not imported.',
    ]);
  });
});

describe('import confirm — parsing and row filtering', () => {
  it('numeric cleaning strips currency symbols and thousands separators ("1,000", "£1.50", "£1,502.00")', async () => {
    const { inserted } = await importCsv([gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: '1,000', price: '£1.50', fee: '£2', cash_value: '£1,502.00' })]);
    expect(inserted.map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'BUY', quantity: 1000, price: 1.5, fee: 2, cash_value: 1502, cash_ccy: 'GBP', settle_value: 1502, settle_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    ]);
  });

  it('input type aliases map to canonical types ("dividend" -> DIV, "with" -> WIT, "other" -> OTR)', async () => {
    const { inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'dividend', quantity: 1, price: 5, cash_value: 5 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'with', quantity: 1, price: 200, cash_value: 200 }),
      gbp({ ticker: 'CASH.GBP', transaction_type: 'other', quantity: 1, price: 1, cash_value: -1 }),
    ]);
    expect(inserted.map((r) => [r.type, r.cash_value])).toEqual([
      ['DIV', 5],
      ['WIT', 200],
      ['OTR', -1],
    ]);
  });

  it('CURRENT behaviour: rows that fail validation or portfolio matching (including another user\'s portfolio) are dropped, and the SUCCESS response does not report them', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', quantity: 1, price: 10, cash_value: 10 }),
      { portfolio: 'Someone Else', date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 },
      gbp({ ticker: 'GBP', transaction_type: 'DEP', quantity: 1, price: 10, cash_value: 10 }), // 'GBP' placeholder rows are skipped outright
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    expect(status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ portfolio_id: 'p-gbp', type: 'BUY' });
    expect(body.message).toBe('Imported 1 transaction.');
    expect(Object.keys(body).sort()).toEqual(['message', 'skippedCashLeg', 'transferResult']);
  });
});
