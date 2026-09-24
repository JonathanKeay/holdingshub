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
//
// C16 (FIXED 2026-09-24): when at least one row imports, the success response
// reports rows dropped by validation or portfolio matching in rejectedRows, and
// 'GBP' placeholder rows in ignoredRows, with counts in the message. Reporting
// only: which rows import is unchanged. See the "C16" describe block below.
//
// C17 (FIXED 2026-09-24): an SPL ratio (CSV quantity) <= 0, including a blank,
// is invalid input. Preview reports it as an invalid row; confirm refuses the
// WHOLE import with HTTP 400 naming the rows, before any write (no asset
// creation, no transactions). See the "C17" describe block below.
//
// C18 (FIXED 2026-09-24): a CSV portfolio name matches one of the user's own
// portfolios only when it equals that portfolio's one effective import name
// (import_name when set, else the display name), trimmed and case-insensitive.
// The substring/prefix/first-12-characters fallbacks are gone. An unmatched or
// ambiguous name is a rejected row. See the "C18" describe block below and
// tests/import/portfolio-name-match.spec.ts.

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
});

// ---------------------------------------------------------------------------
// C17 (FIXED 2026-09-24): an SPL ratio <= 0 is invalid input. Preview reports
// the row; confirm refuses the WHOLE import with HTTP 400 before any write.
// The bad split is never skipped while the rest imports.
// ---------------------------------------------------------------------------

describe('import — C17: an SPL ratio <= 0 is invalid input and refuses the whole import', () => {
  const REASON = 'Invalid split ratio: SPL quantity must be greater than 0.';

  function csvOf(rows: CsvRow[]) {
    return toCsv(COLUMNS, rows.map((r) => COLUMNS.map((c) => r[c] ?? '')));
  }

  async function previewCsv(rows: CsvRow[]) {
    const fake = createImportFake({ portfolios: PORTFOLIOS, assets: ASSETS, asset_aliases: [], fx_rates: FX_RATES });
    h.client = fake.client;
    const fd = new FormData();
    fd.append('file', new File([csvOf(rows)], 'import.csv', { type: 'text/csv' }));
    const res = await POST(new Request('http://localhost/api/import-transactions?stage=preview', { method: 'POST', body: fd }) as any);
    return { status: res.status, body: await res.json(), fake };
  }

  const BUY = gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['blank (still parsed as 0)', ''],
  ])('%s ratio: confirm returns HTTP 400 naming the CSV row, and inserts nothing (valid rows included)', async (_label, ratio) => {
    const { status, body, fake } = await importCsv([BUY, gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: ratio })]);
    expect(status).toBe(400);
    expect(body.message).toBe(
      'Import aborted — nothing was imported. Invalid split ratio on row 3: SPL quantity must be greater than 0. Fix the file and import it again.',
    );
    expect(body.invalidSplitRows).toEqual([{ row: 3, ticker: 'VOD.L', reason: REASON }]);
    expect(fake.transactionInserts).toHaveLength(0);
    expect(fake.calls.filter((c) => c.op === 'insert')).toEqual([]);
  });

  it('several invalid splits: every row is named (plural wording)', async () => {
    const { status, body } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0 }),
      BUY,
      gbp({ ticker: 'AAPL', transaction_type: 'split', quantity: -1 }),
    ]);
    expect(status).toBe(400);
    expect(body.message).toBe(
      'Import aborted — nothing was imported. Invalid split ratio on rows 2, 4: SPL quantity must be greater than 0. Fix the file and import it again.',
    );
    expect(body.invalidSplitRows.map((r: any) => [r.row, r.ticker])).toEqual([[2, 'VOD.L'], [4, 'AAPL']]);
  });

  it('preview reports the invalid split as an invalid row with its CSV row number and reason; valid rows are still counted', async () => {
    const { status, body, fake } = await previewCsv([BUY, BUY, gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0 })]);
    expect(status).toBe(200);
    expect(body.validCount).toBe(2);
    expect(body.invalidCount).toBe(1);
    expect(body.errors).toEqual([{ row: 4, issues: [{ message: REASON }] }]);
    expect(fake.calls.filter((c) => c.op === 'insert')).toEqual([]);
  });

  it('a newly confirmed ticker in the same request is NOT created as an asset: the abort comes before asset creation and any lookup', async () => {
    const fake = createImportFake({ portfolios: PORTFOLIOS, assets: ASSETS, asset_aliases: [], fx_rates: FX_RATES });
    h.client = fake.client;
    const fd = new FormData();
    fd.append('file', new File([csvOf([
      gbp({ ticker: 'NEWCO', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0 }),
    ])], 'import.csv', { type: 'text/csv' }));
    fd.append('confirmedTickers', JSON.stringify(['NEWCO']));
    // A valid manual currency means that, without the C17 check, the route would go
    // straight to inserting the NEWCO asset (which this harness refuses loudly).
    fd.append('manualTickerMetadata', JSON.stringify({ NEWCO: { currency: 'GBP', name: 'New Co' } }));
    const res = await POST(new Request('http://localhost/api/import-transactions?stage=confirm', { method: 'POST', body: fd }) as any);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.invalidSplitRows).toEqual([{ row: 3, ticker: 'VOD.L', reason: REASON }]);
    expect(fake.calls.filter((c) => c.op === 'insert')).toEqual([]);
    expect(fake.calls.filter((c) => c.table === 'fx_rates')).toEqual([]);
  });

  it('a split row that already fails portfolio matching keeps its portfolio reason (C16) and does not abort the import', async () => {
    const { status, body, inserted } = await importCsv([
      BUY,
      { portfolio: 'Someone Else', date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0 },
    ]);
    expect(status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(body.rejectedRows).toEqual([{ row: 3, reason: "No matching portfolio for 'Someone Else'" }]);
  });

  it('valid SPL rows are unchanged: fractional and > 1 ratios import alongside other rows exactly as before', async () => {
    const { status, body, inserted } = await importCsv([
      BUY,
      gbp({ ticker: 'VOD.L', transaction_type: 'SPL', quantity: 0.5 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'split', quantity: 3 }),
    ]);
    expect(status).toBe(200);
    expect(body.message).toBe('Imported 3 transactions.');
    expect(body.rejectedRows).toEqual([]);
    expect(inserted.slice(1).map(noCreatedAt)).toEqual([
      expectedRow({ asset_id: 'a-vod', type: 'SPL', quantity: 0, price: 0, fee: 0, cash_value: null, cash_ccy: null, settle_value: 0, settle_ccy: 'GBP', cash_fx_to_portfolio: null, split_factor: 0.5 }),
      expectedRow({ asset_id: 'a-vod', type: 'SPL', quantity: 0, price: 0, fee: 0, cash_value: null, cash_ccy: null, settle_value: 0, settle_ccy: 'GBP', cash_fx_to_portfolio: null, split_factor: 3 }),
    ]);
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
});

// ---------------------------------------------------------------------------
// C16 (FIXED 2026-09-24): rejected and ignored rows are reported on success.
// Reporting only: which rows import, reject or are ignored is unchanged.
// ---------------------------------------------------------------------------

describe('import confirm — C16: rejected and ignored rows are reported in the success response', () => {
  const INVALID_TYPE = 'Invalid transaction_type';
  const IGNORED_REASON = "'GBP' cash placeholder row; ignored, not imported.";

  it('valid rows still import; rows failing validation or portfolio matching (including another user\'s portfolio) are reported in rejectedRows with row number and reason; a GBP placeholder is ignored, not rejected', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', quantity: 1, price: 10, cash_value: 10 }),
      { portfolio: 'Someone Else', date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 },
      gbp({ ticker: 'GBP', transaction_type: 'DEP', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 }),
    ]);
    expect(status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ portfolio_id: 'p-gbp', type: 'BUY', asset_id: 'a-vod' });
    expect(body.rejectedRows).toEqual([
      { row: 2, reason: INVALID_TYPE },
      // Same wording as the preview: it does not reveal that another user owns a portfolio of that name.
      { row: 3, reason: "No matching portfolio for 'Someone Else'" },
    ]);
    expect(body.ignoredRows).toEqual([{ row: 4, reason: IGNORED_REASON }]);
    expect(body.skippedCashLeg).toEqual([]);
    expect(body.message).toBe(
      "Imported 1 transaction. 2 rows rejected — failed validation or portfolio matching (see rejectedRows). 1 'GBP' placeholder row ignored (see ignoredRows).",
    );
    expect(Object.keys(body).sort()).toEqual(['ignoredRows', 'message', 'rejectedRows', 'skippedCashLeg', 'transferResult']);
  });

  it('a row with several validation issues is one rejected row whose reasons are joined with "; "', async () => {
    const { body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', date_time: 'not-a-date', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }),
    ]);
    expect(inserted).toHaveLength(1);
    expect(body.rejectedRows).toEqual([{ row: 2, reason: `${INVALID_TYPE}; Invalid date_time: not-a-date` }]);
  });

  it('singular and plural wording: one rejected row and several ignored placeholders', async () => {
    const { body } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'GBP', transaction_type: 'DEP', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'gbp', transaction_type: 'WIT', quantity: 1, price: 5, cash_value: 5 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 2, price: 10, cash_value: 20 }),
    ]);
    expect(body.message).toBe(
      "Imported 2 transactions. 1 row rejected — failed validation or portfolio matching (see rejectedRows). 2 'GBP' placeholder rows ignored (see ignoredRows).",
    );
    expect(body.ignoredRows.map((r: any) => r.row)).toEqual([3, 4]);
  });

  it('singular and plural wording: several rejected rows and one ignored placeholder', async () => {
    const { body } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', quantity: 1, price: 10, cash_value: 10 }),
      { portfolio: 'Nonexistent', date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 },
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', date_time: 'bad', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'GBP', transaction_type: 'DEP', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }),
    ]);
    expect(body.message).toBe(
      "Imported 1 transaction. 3 rows rejected — failed validation or portfolio matching (see rejectedRows). 1 'GBP' placeholder row ignored (see ignoredRows).",
    );
    expect(body.rejectedRows.map((r: any) => r.row)).toEqual([2, 3, 4]);
  });

  it('no rejected or ignored rows: the message is exactly the existing simple success message, and both lists are empty', async () => {
    const { body } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }),
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 2, price: 10, cash_value: 20 }),
    ]);
    expect(body.message).toBe('Imported 2 transactions.');
    expect(body.rejectedRows).toEqual([]);
    expect(body.ignoredRows).toEqual([]);
  });

  it('mixed rejectedRows, ignoredRows and skippedCashLeg: each is reported separately and accurately, and only the valid row imports', async () => {
    const { status, body, inserted } = await importCsv([
      gbp({ ticker: 'VOD.L', transaction_type: 'bogus', quantity: 1, price: 10, cash_value: 10 }), // rejected
      gbp({ ticker: 'AAPL', transaction_type: 'BUY', quantity: 10, price: 150, fee: 2 }), // no usable FX -> skippedCashLeg
      gbp({ ticker: 'CASH.GBP', transaction_type: 'OTR', quantity: 1, price: 1 }), // blank required cash -> skippedCashLeg
      gbp({ ticker: 'GBP', transaction_type: 'DEP', quantity: 1, price: 10, cash_value: 10 }), // ignored placeholder
      gbp({ ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, cash_value: 10 }), // imported
    ]);
    expect(status).toBe(200);
    expect(inserted.map((r) => [r.asset_id, r.type])).toEqual([['a-vod', 'BUY']]);
    expect(body.rejectedRows).toEqual([{ row: 2, reason: INVALID_TYPE }]);
    expect(body.ignoredRows).toEqual([{ row: 5, reason: IGNORED_REASON }]);
    expect(body.skippedCashLeg.map((s: any) => s.row)).toEqual([3, 4]);
    expect(body.message).toBe(
      "Imported 1 transaction. 1 row rejected — failed validation or portfolio matching (see rejectedRows). 1 'GBP' placeholder row ignored (see ignoredRows). " +
      '1 row skipped — no reliable currency conversion; 1 row skipped — required cash_value was blank (see skippedCashLeg).',
    );
  });
});

// ---------------------------------------------------------------------------
// C18 (FIXED 2026-09-24): a CSV portfolio name must equal the portfolio's one
// effective import name (import_name when set, else the display name), trimmed
// and case-insensitive. Before the fix the route fell back to
// first-12-characters, starts-with and contains matching, and took the first
// similar portfolio it found.
// ---------------------------------------------------------------------------

describe('import — C18: a CSV portfolio name must equal one of the user\'s effective import names (trimmed, case-insensitive)', () => {
  // The real DEV portfolio set after the C18 backfill, plus another user's portfolios.
  const OWN: Row[] = [
    { id: 'p-ibkr-isa', name: 'IBKR ISA STK (U9407868)', import_name: 'IBKR ISA STK', base_currency: 'GBP', user_id: 'user-1' },
    { id: 'p-ibkr-trd', name: 'IBKR TRD STK (U6842190)', import_name: 'IBKR TRD STK', base_currency: 'GBP', user_id: 'user-1' },
    { id: 'p-etro-trd', name: 'ETRO TRD STK', import_name: null, base_currency: 'USD', user_id: 'user-1' },
    { id: 'p-t212-isa', name: 'T212 ISA STK', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
    { id: 'p-t212-trd', name: 'T212 TRD STK', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
    { id: 'p-hgld-isa', name: 'HGLD ISA STK', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
    { id: 'p-other-user', name: 'Someone Else', import_name: null, base_currency: 'GBP', user_id: 'user-2' },
    { id: 'p-other-user-ibkr', name: 'Their IBKR', import_name: 'OTHER IBKR', base_currency: 'GBP', user_id: 'user-2' },
  ];

  const buy = (portfolio: string): CsvRow => ({ portfolio, date_time: NO_CACHE_DATE, ticker: 'VOD.L', transaction_type: 'BUY', quantity: 1, price: 10, fee: 0, cash_value: 10 });
  const csvOf = (rows: CsvRow[]) => toCsv(COLUMNS, rows.map((r) => COLUMNS.map((c) => r[c] ?? '')));

  async function run(stage: 'preview' | 'confirm', rows: CsvRow[], portfolios: Row[] = OWN) {
    const fake = createImportFake({ portfolios, assets: ASSETS, asset_aliases: [], fx_rates: FX_RATES });
    h.client = fake.client;
    const req = stage === 'confirm'
      ? confirmRequest(csvOf(rows))
      : (() => {
          const fd = new FormData();
          fd.append('file', new File([csvOf(rows)], 'import.csv', { type: 'text/csv' }));
          return new Request('http://localhost/api/import-transactions?stage=preview', { method: 'POST', body: fd });
        })();
    const res = await POST(req as any);
    return { status: res.status, body: await res.json(), inserted: fake.transactionInserts[0] ?? [], fake };
  }

  it('the portfolios query reads import_name, scoped to the session user', async () => {
    const { fake } = await run('confirm', [buy('IBKR ISA STK')]);
    expect(fake.calls).toContainEqual({ table: 'portfolios', op: 'select', columns: 'id, name, base_currency, import_name' });
    expect(fake.calls).toContainEqual({ table: 'portfolios', op: 'eq', column: 'user_id', value: 'user-1' });
  });

  it('the IBKR short import names import into the portfolios displayed with the account-number suffix', async () => {
    const { status, body, inserted } = await run('confirm', [buy('IBKR ISA STK'), buy('IBKR TRD STK')]);
    expect(status).toBe(200);
    expect(body.rejectedRows).toEqual([]);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-ibkr-isa', 'p-ibkr-trd']);
  });

  it('the full suffixed IBKR display name is rejected once import_name is set', async () => {
    const { status, body, inserted } = await run('confirm', [buy('IBKR ISA STK (U9407868)'), buy('IBKR TRD STK (U6842190)'), buy('IBKR ISA STK')]);
    expect(status).toBe(200);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-ibkr-isa']);
    expect(body.rejectedRows).toEqual([
      { row: 2, reason: "No matching portfolio for 'IBKR ISA STK (U9407868)'" },
      { row: 3, reason: "No matching portfolio for 'IBKR TRD STK (U6842190)'" },
    ]);
  });

  it('ETRO and T212 (import_name null) match via their display names', async () => {
    const { body, inserted } = await run('confirm', [buy('ETRO TRD STK'), buy('T212 ISA STK'), buy('T212 TRD STK')]);
    expect(body.rejectedRows).toEqual([]);
    expect(inserted.map((r) => [r.portfolio_id, r.cash_ccy])).toEqual([
      ['p-etro-trd', 'USD'],
      ['p-t212-isa', 'GBP'],
      ['p-t212-trd', 'GBP'],
    ]);
  });

  it('matching is trimmed, case-insensitive and exact', async () => {
    const { body, inserted } = await run('confirm', [buy('ibkr isa stk'), buy('  IBKR TRD STK  '), buy('etro trd stk'), buy('T212 isa STK')]);
    expect(body.rejectedRows).toEqual([]);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-ibkr-isa', 'p-ibkr-trd', 'p-etro-trd', 'p-t212-isa']);
  });

  it('substring and prefix names are rejected, reported and not imported', async () => {
    const { status, body, inserted } = await run('confirm', [
      buy('ISA'),
      buy('IBKR'),
      buy('IBKR ISA'),
      buy('T212'),
      buy('ETRO TRD STK 2'),
      buy('IBKR ISA STK (U1234567)'),
      buy('T212 ISA STK'),
    ]);
    expect(status).toBe(200);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-t212-isa']);
    expect(body.rejectedRows).toEqual([
      { row: 2, reason: "No matching portfolio for 'ISA'" },
      { row: 3, reason: "No matching portfolio for 'IBKR'" },
      { row: 4, reason: "No matching portfolio for 'IBKR ISA'" },
      { row: 5, reason: "No matching portfolio for 'T212'" },
      { row: 6, reason: "No matching portfolio for 'ETRO TRD STK 2'" },
      { row: 7, reason: "No matching portfolio for 'IBKR ISA STK (U1234567)'" },
    ]);
    expect(body.message).toBe('Imported 1 transaction. 6 rows rejected — failed validation or portfolio matching (see rejectedRows).');
  });

  it('"ISA" does not match "ISA Account", "Trading" does not match "Trading 212", and similar names never first-match', async () => {
    const portfolios: Row[] = [
      { id: 'p-isa-account', name: 'ISA Account', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-trading-212', name: 'Trading 212', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-a', name: 'ZZ IMPORT TEST AAAAAA', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-b', name: 'ZZ IMPORT TEST BBBBBB', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
    ];
    const { body, inserted } = await run('confirm', [
      buy('ISA'),
      buy('Trading'),
      buy('ZZ IMPORT TEST BBBBBB'),
      buy('ZZ IMPORT TEST'),
      buy('ZZ IMPORT TEST AAAAAA'),
    ], portfolios);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-b', 'p-a']);
    expect(body.rejectedRows.map((r: any) => r.row)).toEqual([2, 3, 5]);
  });

  it('when no row matches, nothing is imported (existing all-rows-dropped HTTP 400)', async () => {
    const { status, body, fake } = await run('confirm', [buy('ISA'), buy('IBKR ISA STK (U9407868)')]);
    expect(status).toBe(400);
    expect(body.message).toBe('No transactions to insert');
    expect(body.errors).toEqual([
      { row: 2, issues: [{ message: "No matching portfolio for 'ISA'" }] },
      { row: 3, issues: [{ message: "No matching portfolio for 'IBKR ISA STK (U9407868)'" }] },
    ]);
    expect(fake.transactionInserts).toHaveLength(0);
  });

  it('preview counts an unmatched name as an invalid row with the same reason', async () => {
    const { status, body } = await run('preview', [buy('IBKR ISA STK (U9407868)'), buy('IBKR ISA STK')]);
    expect(status).toBe(200);
    expect(body.validCount).toBe(1);
    expect(body.invalidCount).toBe(1);
    expect(body.errors).toEqual([{ row: 2, issues: [{ message: "No matching portfolio for 'IBKR ISA STK (U9407868)'" }] }]);
  });

  it('another user\'s portfolio (by display name or import_name) is indistinguishable from a nonexistent one, in preview and confirm', async () => {
    const reasonFor = (name: string) => `No matching portfolio for '${name}'`;
    for (const stage of ['preview', 'confirm'] as const) {
      for (const theirs of ['Someone Else', 'OTHER IBKR', 'Their IBKR']) {
        const other = await run(stage, [buy(theirs), buy('IBKR ISA STK')]);
        const missing = await run(stage, [buy('Nobody Here'), buy('IBKR ISA STK')]);
        expect(other.status).toBe(missing.status);
        if (stage === 'preview') {
          expect(other.body.errors).toEqual([{ row: 2, issues: [{ message: reasonFor(theirs) }] }]);
          expect(missing.body.errors).toEqual([{ row: 2, issues: [{ message: reasonFor('Nobody Here') }] }]);
          expect(other.body.availablePortfolios).toEqual(missing.body.availablePortfolios);
          expect(other.body.availablePortfolios.map((p: any) => p.id)).not.toContain('p-other-user');
          expect(other.body.availablePortfolios.map((p: any) => p.id)).not.toContain('p-other-user-ibkr');
        } else {
          expect(other.body.rejectedRows).toEqual([{ row: 2, reason: reasonFor(theirs) }]);
          expect(missing.body.rejectedRows).toEqual([{ row: 2, reason: reasonFor('Nobody Here') }]);
          expect(other.body.message).toBe(missing.body.message);
          expect(other.inserted.map((r) => r.portfolio_id)).toEqual(['p-ibkr-isa']);
        }
      }
    }
  });

  it('a same-name portfolio owned by another user does not make the user\'s own match ambiguous', async () => {
    const shared: Row[] = [
      { id: 'p-mine', name: 'Mine (U1)', import_name: 'IBKR ISA STK', base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-theirs', name: 'IBKR ISA STK', import_name: null, base_currency: 'GBP', user_id: 'user-2' },
    ];
    const { body, inserted } = await run('confirm', [buy('ibkr isa stk')], shared);
    expect(body.rejectedRows).toEqual([]);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-mine']);
  });

  it('runtime ambiguity (the database index should prevent it): one portfolio\'s import_name equals another\'s display name — the row is rejected, neither is chosen', async () => {
    const dupes: Row[] = [
      { id: 'p-a', name: 'IBKR ISA STK', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-b', name: 'Something Else', import_name: ' ibkr isa stk ', base_currency: 'GBP', user_id: 'user-1' },
      { id: 'p-c', name: 'Other', import_name: null, base_currency: 'GBP', user_id: 'user-1' },
    ];
    const { status, body, inserted } = await run('confirm', [buy('IBKR ISA STK'), buy('Other')], dupes);
    expect(status).toBe(200);
    expect(inserted.map((r) => r.portfolio_id)).toEqual(['p-c']);
    expect(body.rejectedRows).toEqual([
      { row: 2, reason: "Portfolio name 'IBKR ISA STK' matches more than one of your portfolios; rename them so each name is unique" },
    ]);
  });
});
