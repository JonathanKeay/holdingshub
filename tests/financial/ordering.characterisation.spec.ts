// TRANSACTION ORDERING — characterisation (Phase 0 safety net)
//
// Three copies of the replay ordering exist (cleanup item B1):
//   - src/lib/queries.ts            compareTxForHoldings + TYPE_PRIORITY (not exported)
//   - src/lib/transferImportIntegration.ts  compareForReplay + TYPE_PRIORITY (exported)
//   - src/app/api/portfolio-series/route.ts compareTxForHoldings + TYPE_PRIORITY (route-local)
//
// Only compareForReplay is importable today, so it is pinned directly here.
// Parcel capture at import relies on it matching the live engine's order
// exactly (see transferImportIntegration.spec.ts "Same-date ordering regression").
// A direct three-way agreement test needs the approved D1/D2 extractions
// and is deliberately not attempted yet.
//
// These tests describe CURRENT ordering, including one known divergence (FXM).

import { describe, it, expect } from 'vitest';
import { compareForReplay } from '../../src/lib/transferImportIntegration';
import { makeTxn } from './helpers';
import type { Txn } from '../../src/lib/queries';

const SAME_DATE = '2024-05-01';
const SAME_CREATED = '2024-05-01T09:00:00.000Z';

function sameInstant(type: string, id: string): Txn {
  return makeTxn({ id, type, date: SAME_DATE, created_at: SAME_CREATED });
}

function order(txns: Txn[]): string[] {
  return [...txns].sort(compareForReplay).map((t) => t.type);
}

describe('compareForReplay — CURRENT ordering', () => {
  it('same date and created_at: sorts by type priority SPL < TIN < BUY < SELL < TOT < DIV < INT < FEE < DEP < WIT < OTR < BAL', () => {
    const expected = ['SPL', 'TIN', 'BUY', 'SELL', 'TOT', 'DIV', 'INT', 'FEE', 'DEP', 'WIT', 'OTR', 'BAL'];
    // Deliberately reversed input, with ids that would sort the opposite way,
    // so only the type priority can produce the expected order.
    const input = [...expected].reverse().map((type, i) => sameInstant(type, `id-${String(i).padStart(2, '0')}`));
    expect(order(input)).toEqual(expected);
  });

  it('same-day BUY/SELL/TIN/TOT with identical created_at: entries (TIN, BUY) precede exits (SELL, TOT)', () => {
    const input = [sameInstant('TOT', 'a'), sameInstant('SELL', 'b'), sameInstant('BUY', 'c'), sameInstant('TIN', 'd')];
    expect(order(input)).toEqual(['TIN', 'BUY', 'SELL', 'TOT']);
  });

  it('created_at outranks type priority: a SELL created before a same-day BUY sorts first', () => {
    const sell = makeTxn({ id: 'z', type: 'SELL', date: SAME_DATE, created_at: '2024-05-01T09:00:00.000Z' });
    const buy = makeTxn({ id: 'a', type: 'BUY', date: SAME_DATE, created_at: '2024-05-01T09:00:00.001Z' });
    expect(order([buy, sell])).toEqual(['SELL', 'BUY']);
  });

  it('date outranks created_at', () => {
    const later = makeTxn({ id: 'a', type: 'BUY', date: '2024-05-02', created_at: '2024-01-01T00:00:00.000Z' });
    const earlier = makeTxn({ id: 'b', type: 'BUY', date: '2024-05-01', created_at: '2024-12-31T00:00:00.000Z' });
    expect([later, earlier].sort(compareForReplay).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('identical date, created_at and type: id is the final tiebreak', () => {
    const input = [sameInstant('BUY', 'c'), sameInstant('BUY', 'a'), sameInstant('BUY', 'b')];
    expect([...input].sort(compareForReplay).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('CURRENT DIVERGENCE (cleanup item B1, not a fix): FXM is absent from this TYPE_PRIORITY, so it sorts after BAL like an unknown type (queries.ts gives FXM 99, alongside OTR)', () => {
    const input = [sameInstant('FXM', 'a'), sameInstant('BAL', 'b'), sameInstant('OTR', 'c')];
    expect(order(input)).toEqual(['OTR', 'BAL', 'FXM']);

    // Same treatment as a genuinely unknown type: both fall back to priority 1000, then id.
    const withUnknown = [sameInstant('XYZ', 'b'), sameInstant('FXM', 'a'), sameInstant('BAL', 'c')];
    expect(order(withUnknown)).toEqual(['BAL', 'FXM', 'XYZ']);
  });
});
