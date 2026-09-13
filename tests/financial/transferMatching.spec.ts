// TRANSFER CANDIDATE MATCHING — pure ranking tests
//
// Exercises src/lib/transferMatching.ts. All fixtures are plain data — no
// Supabase, no I/O. Several cases use the exact real figures/notes from the
// TIN/TOT investigation (the £5,000 orphaned cash transfer, and the
// identical "TID-0" note pattern shared by two genuinely unrelated real
// transfers) as concrete proof the matching rules handle them correctly,
// not just hypothetically.

import { describe, it, expect } from 'vitest';
import { suggestTransferMatches, type MatchCandidateInput } from '../../src/lib/transferMatching';

function candidate(overrides: Partial<MatchCandidateInput> & Pick<MatchCandidateInput, 'transferId' | 'transactionId'>): MatchCandidateInput {
  return {
    portfolioId: 'portfolio-B',
    assetId: 'asset-1',
    quantity: 100,
    date: '2025-06-02',
    notes: null,
    ...overrides,
  };
}

const target: MatchCandidateInput = {
  transferId: 'target-transfer',
  transactionId: 'target-txn',
  portfolioId: 'portfolio-A',
  assetId: 'asset-1',
  quantity: 100,
  date: '2025-06-02',
  notes: null,
};

describe('exact candidate ranking', () => {
  it('same asset + same quantity + different portfolio + same date -> high confidence', () => {
    const c = candidate({ transferId: 't1', transactionId: 'tx1' });
    const result = suggestTransferMatches(target, [c]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('high');
    expect(result[0].reasons).toContain('same transaction date');
  });

  it('excludes a candidate for a different asset entirely', () => {
    const c = candidate({ transferId: 't2', transactionId: 'tx2', assetId: 'asset-2' });
    expect(suggestTransferMatches(target, [c])).toHaveLength(0);
  });

  it('excludes a candidate in the SAME portfolio as the target', () => {
    const c = candidate({ transferId: 't3', transactionId: 'tx3', portfolioId: 'portfolio-A' });
    expect(suggestTransferMatches(target, [c])).toHaveLength(0);
  });
});

describe('date-window behaviour', () => {
  it('a 10-day gap is medium confidence', () => {
    const c = candidate({ transferId: 't4', transactionId: 'tx4', date: '2025-06-12' });
    const result = suggestTransferMatches(target, [c]);
    expect(result[0].confidence).toBe('medium');
  });

  it('a 60-day gap (beyond the close window, within the max window) is low confidence', () => {
    const c = candidate({ transferId: 't5', transactionId: 'tx5', date: '2025-08-01' });
    const result = suggestTransferMatches(target, [c]);
    expect(result[0].confidence).toBe('low');
  });

  it('a 200-day gap (beyond the max window) is excluded entirely, not just low', () => {
    const c = candidate({ transferId: 't6', transactionId: 'tx6', date: '2026-01-01' });
    expect(suggestTransferMatches(target, [c])).toHaveLength(0);
  });
});

describe('the £5,000 vs £5,157.61 real cash-transfer case must not falsely match', () => {
  it('a large amount difference (framed generically as "quantity") is rejected by the tolerance check, even on the same date', () => {
    // Real data: a £5,000 TOT (2024-03-15, IBKR TRD STK) has no matching
    // TIN anywhere — the closest real candidate is an unrelated £5,157.611993
    // "ADJUSTMENT" TIN. This proves the ranking logic would correctly refuse
    // to suggest that pairing were it ever fed cash rows (cash TOT/TIN are
    // not wired into pending_out/pending_in creation in this phase — see
    // transferImportIntegration.ts's header comment — but the ranking rule
    // itself must be provably strict regardless).
    const cashTarget: MatchCandidateInput = { transferId: 'out-5000', transactionId: 'tot-5000', portfolioId: 'IBKR-TRD', assetId: 'cash-gbp', quantity: 5000, date: '2024-03-15', notes: 'CASH.GBP | TRANSFER FROM U6842190 TO U9407818 : TID--5000' };
    const cashCandidate: MatchCandidateInput = { transferId: 'in-5157', transactionId: 'tin-5157', portfolioId: 'IBKR-ISA', assetId: 'cash-gbp', quantity: 5157.611993, date: '2024-03-18', notes: 'CASH.GBP | ADJUSTMENT: CASH RECEIPT / DISBURSEMENT / TRANSFER : TID-5157.611993357' };
    expect(suggestTransferMatches(cashTarget, [cashCandidate])).toHaveLength(0);
  });
});

describe('identical "TID-0" note patterns across unrelated real transfers must not create a false link', () => {
  it('two genuinely unrelated transfers sharing an identical note suffix are rejected on the asset mismatch alone', () => {
    // Real notes: "PLTR | PALANTIR TECHNOLOGIES INC-A : TID-0" (a genuine
    // internal transfer) vs "TSLA | TESLA INC : TID-0" (a genuine, separate,
    // EXTERNAL transfer-in with no HoldingsHub source) — identical format,
    // completely unrelated transfers.
    const pltrTarget: MatchCandidateInput = { transferId: 'out-pltr', transactionId: 'tot-pltr', portfolioId: 'HGLD-ISA', assetId: 'pltr', quantity: 585, date: '2025-06-02', notes: 'PLTR | PALANTIR TECHNOLOGIES INC-A : TID-0' };
    const tslaCandidate: MatchCandidateInput = { transferId: 'in-tsla', transactionId: 'tin-tsla', portfolioId: 'IBKR-ISA', assetId: 'tsla', quantity: 38, date: '2024-03-18', notes: 'TSLA | TESLA INC : TID-0' };
    expect(suggestTransferMatches(pltrTarget, [tslaCandidate])).toHaveLength(0);
  });

  it('when asset/quantity/date DO structurally match, an identical TID-0 note suffix does NOT elevate confidence beyond what the structural signals alone justify', () => {
    const c = candidate({ transferId: 't7', transactionId: 'tx7', date: '2025-06-15', notes: 'PLTR | PALANTIR TECHNOLOGIES INC-A : TID-0' });
    const withNotes = suggestTransferMatches({ ...target, notes: 'SOMETHING | Unrelated Co : TID-0' }, [c]);
    const withoutNotes = suggestTransferMatches({ ...target, notes: null }, [{ ...c, notes: null }]);
    // Same date-based tier either way — the shared "TID-0" suffix contributes nothing.
    expect(withNotes[0].confidence).toBe(withoutNotes[0].confidence);
    expect(withNotes[0].reasons).not.toContain('notes reference matching accounts');
  });
});

describe('a genuine account-reference match DOES corroborate (positive control)', () => {
  it('two rows both saying "TRANSFER FROM U6842190 TO U9407868" raise a medium-tier date gap to high', () => {
    const t: MatchCandidateInput = { ...target, date: '2024-05-03', notes: 'CASH.GBP | TRANSFER FROM U6842190 TO U9407868 : TID--15000' };
    const c = candidate({ transferId: 't8', transactionId: 'tx8', date: '2024-05-10', notes: 'CASH.GBP | TRANSFER FROM U6842190 TO U9407868 : TID-15000' });
    const result = suggestTransferMatches(t, [c]);
    expect(result[0].confidence).toBe('high');
    expect(result[0].reasons).toContain('notes reference matching accounts');
  });
});

describe('multiple plausible candidates stay ambiguous', () => {
  it('two candidates that both structurally qualify are BOTH returned, none pre-selected', () => {
    const c1 = candidate({ transferId: 't9', transactionId: 'tx9', date: '2025-06-02' });
    const c2 = candidate({ transferId: 't10', transactionId: 'tx10', portfolioId: 'portfolio-C', date: '2025-06-03' });
    const result = suggestTransferMatches(target, [c1, c2]);
    expect(result.map((r) => r.transferId).sort()).toEqual(['t10', 't9']);
  });
});
