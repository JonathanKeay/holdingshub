// src/lib/transactionOrdering.ts
//
// The shared transaction replay ordering for the three application paths that
// previously each had their own copy of the comparator:
//   - src/lib/queries.ts — live holdings replay (getPortfoliosWithHoldingsAndCash,
//     getAllHoldingsAndCashSummary);
//   - src/lib/transferImportIntegration.ts — import-time transfer parcel capture,
//     which must replay a source holding in exactly the live engine's order;
//   - src/app/api/portfolio-series/route.ts — historical chart replay.
//
// Of those three application copies, only queries.ts ranked FXM (99, alongside
// OTR). This module adopts the queries.ts rule unchanged. Pure, no imports, no I/O.
//
// Outside src/, scripts/price-streamer.ts still keeps its own copy of the
// ordering (FXM unlisted) and a simplified holdings replay, used only to decide
// which tickers to stream prices for (ACCOUNTING.md §15 item 23).

/** Deterministic intra-day ordering so entries (TIN/BUY/SPL) precede exits (SELL/TOT). Unlisted types rank 1000. */
export const TRANSACTION_TYPE_PRIORITY: Readonly<Record<string, number>> = {
  SPL: 10,
  TIN: 20,
  BUY: 30,
  SELL: 40,
  TOT: 50,
  DIV: 90,
  INT: 95,
  FEE: 96,
  DEP: 97,
  WIT: 98,
  OTR: 99,
  FXM: 99,
  BAL: 100,
};

type Orderable = {
  id: string;
  type?: string | null;
  date?: string | null;
  created_at?: string | null;
};

/**
 * Replay order: date, then created_at (both compared as strings, missing = ''),
 * then type priority (TRANSACTION_TYPE_PRIORITY, case-insensitive, unlisted = 1000),
 * then id.
 */
export function compareTransactionsForReplay(a: Orderable, b: Orderable): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;

  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;

  const pa = TRANSACTION_TYPE_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = TRANSACTION_TYPE_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;

  return a.id < b.id ? -1 : 1;
}
