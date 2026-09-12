// Tests for the CSV import all-or-nothing ticker-resolution gate
// (src/lib/unresolvedTickers.ts). See the confirm-stage abort check in
// src/app/api/import-transactions/route.ts: if this function returns any
// rows, the whole import is aborted before any transaction is inserted.

import { describe, it, expect } from 'vitest';
import { findUnresolvedTickerRows } from '../../src/lib/unresolvedTickers';

const portfolioName = (id: string) => (id === 'p1' ? 'T212 ISA STK' : id === 'p2' ? 'IBKR ISA STK' : id);

describe('findUnresolvedTickerRows — everything resolves', () => {
  it('returns an empty array (proceed) when every ticker matches an existing asset', () => {
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 2, ticker: 'AAPL', date: '2025-01-01', portfolioId: 'p1' }],
      (ticker) => ticker === 'AAPL',
      portfolioName
    );
    expect(rows).toEqual([]);
  });

  it('resolves via the .L suffix match, same as the importer\'s own asset lookup', () => {
    const known = new Set(['VOD.L']);
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 5, ticker: 'VOD', date: '2025-02-01', portfolioId: 'p1' }],
      (ticker) => known.has(ticker) || known.has(`${ticker}.L`),
      portfolioName
    );
    expect(rows).toEqual([]);
  });
});

describe('findUnresolvedTickerRows — GBP cash-placeholder handling preserved', () => {
  it('never reports a GBP-ticker row, even if hasAsset would say no', () => {
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 3, ticker: 'GBP', date: '2025-01-01', portfolioId: 'p1' }],
      () => false,
      portfolioName
    );
    expect(rows).toEqual([]);
  });
});

describe('findUnresolvedTickerRows — one or more unresolved rows', () => {
  it('reports a single unresolved row with row/ticker/date/portfolio/reason', () => {
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 7, ticker: 'ZZZQ', date: '2025-03-04', portfolioId: 'p2' }],
      () => false,
      portfolioName
    );
    expect(rows).toEqual([
      {
        row: 7,
        ticker: 'ZZZQ',
        date: '2025-03-04',
        portfolio: 'IBKR ISA STK',
        reason: "Ticker 'ZZZQ' is not a recognised asset — it was not confirmed for import, or its asset could not be created.",
      },
    ]);
  });

  it('reports every unresolved row across different tickers, portfolios and dates', () => {
    const known = new Set(['AAPL']);
    const rows = findUnresolvedTickerRows(
      [
        { rowNum: 2, ticker: 'AAPL', date: '2025-01-01', portfolioId: 'p1' },
        { rowNum: 4, ticker: 'FOOBAR', date: '2025-01-02', portfolioId: 'p1' },
        { rowNum: 9, ticker: 'BAZQUX', date: '2025-01-05', portfolioId: 'p2' },
      ],
      (ticker) => known.has(ticker),
      portfolioName
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row)).toEqual([4, 9]);
    expect(rows[0]).toMatchObject({ ticker: 'FOOBAR', date: '2025-01-02', portfolio: 'T212 ISA STK' });
    expect(rows[1]).toMatchObject({ ticker: 'BAZQUX', date: '2025-01-05', portfolio: 'IBKR ISA STK' });
  });

  it('a mix of resolved and unresolved rows reports only the unresolved ones', () => {
    const known = new Set(['AAPL', 'MSFT']);
    const rows = findUnresolvedTickerRows(
      [
        { rowNum: 2, ticker: 'AAPL', date: '2025-01-01', portfolioId: 'p1' },
        { rowNum: 3, ticker: 'NEWCO', date: '2025-01-01', portfolioId: 'p1' },
        { rowNum: 4, ticker: 'MSFT', date: '2025-01-02', portfolioId: 'p1' },
      ],
      (ticker) => known.has(ticker),
      portfolioName
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('NEWCO');
  });
});
