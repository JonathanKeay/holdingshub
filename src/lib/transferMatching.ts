// src/lib/transferMatching.ts
//
// Pure candidate-matching/ranking for pending transfers. No Supabase, no
// I/O — takes plain data, returns ranked suggestions. Never auto-selects or
// auto-confirms anything; the caller (import integration, and eventually a
// UI) always requires explicit user confirmation before a match is made via
// matchTransfer()/confirm_transfer_match() (see src/lib/transfers.ts).
//
// Design principle (proven against real data during the transfer-persistence
// investigation): notes text alone is never sufficient. Two genuinely
// unrelated real transfers share the identical note format
// "TICKER | Company Name : TID-0" — so an account-reference match only ever
// nudges an already-structurally-plausible candidate's confidence up one
// tier; it can never manufacture a candidate on its own, and the pattern
// recognised is deliberately narrow (an explicit "TRANSFER FROM X TO Y"
// account reference), not generic text similarity.

export type MatchCandidateInput = {
  transferId: string;
  transactionId: string;
  portfolioId: string;
  assetId: string;
  quantity: number;
  date: string | null;
  notes?: string | null;
};

export type MatchConfidence = 'high' | 'medium' | 'low';

export type MatchSuggestion = {
  transferId: string;
  transactionId: string;
  portfolioId: string;
  confidence: MatchConfidence;
  reasons: string[];
};

export type SuggestMatchesOptions = {
  /** Beyond same-day, a gap up to this many days is 'medium' confidence. Default 14. */
  closeDateWindowDays?: number;
  /** Beyond closeDateWindowDays, a gap up to this many days is 'low' confidence. Beyond this, the candidate is not suggested at all. Default 90. */
  maxDateWindowDays?: number;
  /** Relative quantity tolerance (fraction of the larger value). Default 0.0005 (0.05%) — floating-point/rounding noise only, never a genuine amount difference. */
  quantityRelativeTolerance?: number;
  quantityAbsoluteTolerance?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(da - db) / DAY_MS;
}

function quantitiesMatch(a: number, b: number, relTol: number, absTol: number): boolean {
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff <= Math.max(absTol, relTol * scale);
}

// Deliberately narrow: matches only an explicit "TRANSFER FROM <ref> TO
// <ref>" account reference (the real pattern seen in genuinely-linked
// internal cash transfers). Does NOT match generic shared substrings —
// "PLTR | PALANTIR TECHNOLOGIES INC-A : TID-0" and an unrelated
// "TSLA | TESLA INC : TID-0" share a suffix but neither matches this
// pattern at all, so neither ever contributes an account-reference signal.
const ACCOUNT_REF_RE = /transfer\s+from\s+([a-z0-9]+)\s+to\s+([a-z0-9]+)/i;

function extractAccountRefs(notes?: string | null): { from: string; to: string } | null {
  if (!notes) return null;
  const m = ACCOUNT_REF_RE.exec(notes);
  if (!m) return null;
  return { from: m[1].toUpperCase(), to: m[2].toUpperCase() };
}

function accountRefsCorroborate(a?: string | null, b?: string | null): boolean {
  const refA = extractAccountRefs(a);
  const refB = extractAccountRefs(b);
  if (!refA || !refB) return false;
  // The two legs of one real transfer describe opposite directions of the
  // same account pair.
  return (refA.from === refB.from && refA.to === refB.to) || (refA.from === refB.to && refA.to === refB.from);
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Ranks `candidates` (opposite-leg pending transfers) as possible matches
 * for `target`. Hard filters (a candidate that fails ANY of these is
 * excluded entirely, never merely down-ranked): same asset, a DIFFERENT
 * portfolio, quantity within tolerance, and a date gap within
 * maxDateWindowDays. Everything else only affects confidence tier.
 *
 * Always returns every candidate that passes the hard filters — multiple
 * plausible candidates are never collapsed to one, and nothing here decides
 * or applies a match.
 */
export function suggestTransferMatches(
  target: MatchCandidateInput,
  candidates: MatchCandidateInput[],
  opts?: SuggestMatchesOptions
): MatchSuggestion[] {
  const closeDays = opts?.closeDateWindowDays ?? 14;
  const maxDays = opts?.maxDateWindowDays ?? 90;
  const relTol = opts?.quantityRelativeTolerance ?? 0.0005;
  const absTol = opts?.quantityAbsoluteTolerance ?? 1e-6;

  const results: MatchSuggestion[] = [];

  for (const c of candidates) {
    if (c.transactionId === target.transactionId) continue;
    if (c.assetId !== target.assetId) continue;
    if (c.portfolioId === target.portfolioId) continue;
    if (!quantitiesMatch(target.quantity, c.quantity, relTol, absTol)) continue;

    const gap = daysBetween(target.date, c.date);
    if (gap == null || gap > maxDays) continue;

    let confidence: MatchConfidence;
    const reasons: string[] = ['same asset', 'same quantity', 'different portfolio'];
    if (gap === 0) {
      confidence = 'high';
      reasons.push('same transaction date');
    } else if (gap <= closeDays) {
      confidence = 'medium';
      reasons.push(`within ${closeDays} days`);
    } else {
      confidence = 'low';
      reasons.push(`within ${maxDays} days`);
    }

    if (accountRefsCorroborate(target.notes, c.notes)) {
      reasons.push('notes reference matching accounts');
      if (confidence === 'low') confidence = 'medium';
      else if (confidence === 'medium') confidence = 'high';
    }

    results.push({ transferId: c.transferId, transactionId: c.transactionId, portfolioId: c.portfolioId, confidence, reasons });
  }

  results.sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]);
  return results;
}
