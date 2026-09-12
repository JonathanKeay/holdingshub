// src/lib/unresolvedTickers.ts
//
// Pure decision logic for the CSV import all-or-nothing ticker-resolution
// gate: after the asset-confirmation/creation step, every transaction row
// must reference a ticker that now resolves to a real asset. If any row
// doesn't, the whole import is aborted before any transaction is inserted —
// see the abort check in src/app/api/import-transactions/route.ts.

export type UnresolvedTickerRow = {
  row: number;
  ticker: string;
  date: string;
  portfolio: string;
  reason: string;
};

export type UnresolvedTickerCandidate = {
  rowNum: number;
  ticker: string;
  date: string;
  portfolioId: string;
};

/**
 * Returns one entry per row whose ticker does not resolve to a known asset.
 * An empty array means the import may proceed.
 *
 * The deliberate GBP cash-placeholder exemption is preserved here exactly as
 * it exists elsewhere in the import route (such rows are already filtered
 * out earlier in the cleaning loop, so this is defensive, not load-bearing —
 * kept so this function's behaviour doesn't silently depend on that).
 */
export function findUnresolvedTickerRows(
  rows: UnresolvedTickerCandidate[],
  hasAsset: (ticker: string) => boolean,
  portfolioName: (portfolioId: string) => string
): UnresolvedTickerRow[] {
  const out: UnresolvedTickerRow[] = [];

  for (const r of rows) {
    if (r.ticker === 'GBP') continue; // deliberate cash-placeholder handling — preserved as-is
    if (hasAsset(r.ticker)) continue;

    out.push({
      row: r.rowNum,
      ticker: r.ticker,
      date: r.date,
      portfolio: portfolioName(r.portfolioId),
      reason: `Ticker '${r.ticker}' is not a recognised asset — it was not confirmed for import, or its asset could not be created.`,
    });
  }

  return out;
}
