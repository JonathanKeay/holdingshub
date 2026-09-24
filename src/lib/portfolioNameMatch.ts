// src/lib/portfolioNameMatch.ts
//
// Pure decision logic for matching a CSV row's `portfolio` value to one of
// the importing user's own portfolios (C18).
//
// Each portfolio accepts exactly ONE import name, its effective import name:
// `import_name` when set, otherwise the display `name`. When import_name is
// set the display name is NOT also accepted (e.g. "IBKR ISA STK" is accepted
// for the portfolio displayed as "IBKR ISA STK (U9407868)", and the display
// name is not). The only tolerance is surrounding whitespace and letter case:
// the trimmed, lower-cased CSV value must equal the trimmed, lower-cased
// effective import name in full. There is deliberately no substring,
// starts-with, contains, prefix or "first similar match" fallback (see
// docs/ACCOUNTING.md §12 and §15 item 24).
//
// The database enforces the same key per owner with a unique index
// (supabase/migrations/20260924130000_portfolio_import_name.sql,
// public.portfolio_import_key), so ambiguity should not occur; it is still
// rejected here as a second guard.
//
// The caller passes only the user's own portfolios, so a name that belongs to
// another user is simply "none", exactly like a name that doesn't exist.

export type PortfolioNameCandidate = { id: string; name: string | null; import_name?: string | null };

export type PortfolioNameMatch<P extends PortfolioNameCandidate> =
  | { status: 'matched'; portfolio: P }
  | { status: 'none' }
  // More than one of the user's portfolios has the same effective import
  // name. None is chosen.
  | { status: 'ambiguous' };

/**
 * The comparison key: surrounding whitespace removed, lower-cased. Nothing
 * else. Must stay identical to public.portfolio_import_key in the database
 * (JavaScript's trim() removes exactly the whitespace set that function
 * spells out).
 */
export function portfolioNameKey(name: string | null | undefined): string {
  return (name ?? '').toString().trim().toLowerCase();
}

/** The one name a portfolio accepts from imports: import_name when set, else the display name. */
export function effectiveImportName(p: PortfolioNameCandidate): string | null {
  return p.import_name ?? p.name;
}

/** Groups portfolios by effective import key. Build once per import, then look up per row. */
export function indexPortfoliosByName<P extends PortfolioNameCandidate>(portfolios: P[]): Map<string, P[]> {
  const index = new Map<string, P[]>();
  for (const p of portfolios) {
    const key = portfolioNameKey(effectiveImportName(p));
    if (!key) continue;
    const group = index.get(key);
    if (group) group.push(p);
    else index.set(key, [p]);
  }
  return index;
}

export function matchPortfolioByName<P extends PortfolioNameCandidate>(
  csvName: string | null | undefined,
  index: Map<string, P[]>
): PortfolioNameMatch<P> {
  const key = portfolioNameKey(csvName);
  const group = key ? index.get(key) : undefined;
  if (!group || group.length === 0) return { status: 'none' };
  if (group.length > 1) return { status: 'ambiguous' };
  return { status: 'matched', portfolio: group[0] };
}
