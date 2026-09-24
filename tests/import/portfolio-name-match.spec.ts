// Tests for CSV portfolio-name matching (C18, src/lib/portfolioNameMatch.ts).
// The rule: each portfolio accepts ONE effective import name — import_name when
// set, otherwise the display name — matched trimmed, case-insensitive and in
// full against the importing user's own portfolios. No substring/prefix/
// similar-name fallback. A key shared by two of the user's portfolios is
// ambiguous and matches none.
// Route-level behaviour (rejectedRows, nothing imported, another user's
// portfolio) is in import-route.characterisation.spec.ts, "C18" block.
// The database side of the same key (public.portfolio_import_key and the
// unique index) is checked by supabase/tests/portfolio_import_name.sql.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  effectiveImportName,
  indexPortfoliosByName,
  matchPortfolioByName,
  portfolioNameKey,
} from '../../src/lib/portfolioNameMatch';

// The real DEV portfolio set after the C18 backfill.
const IBKR_ISA = { id: 'p-ibkr-isa', name: 'IBKR ISA STK (U9407868)', import_name: 'IBKR ISA STK' };
const IBKR_TRD = { id: 'p-ibkr-trd', name: 'IBKR TRD STK (U6842190)', import_name: 'IBKR TRD STK' };
const ETRO_TRD = { id: 'p-etro-trd', name: 'ETRO TRD STK', import_name: null };
const T212_ISA = { id: 'p-t212-isa', name: 'T212 ISA STK', import_name: null };
const T212_TRD = { id: 'p-t212-trd', name: 'T212 TRD STK', import_name: null };
const HGLD_ISA = { id: 'p-hgld-isa', name: 'HGLD ISA STK', import_name: null };
const HGLD_TRD = { id: 'p-hgld-trd', name: 'HGLD TRD STK', import_name: null };
const REAL = [ETRO_TRD, HGLD_ISA, HGLD_TRD, IBKR_ISA, IBKR_TRD, T212_ISA, T212_TRD];
const realIndex = indexPortfoliosByName(REAL);
const match = (name: string | null | undefined) => matchPortfolioByName(name, realIndex);

describe('C18 — the real import names', () => {
  it.each([
    ['IBKR ISA STK', IBKR_ISA],
    ['IBKR TRD STK', IBKR_TRD],
    ['ETRO TRD STK', ETRO_TRD],
    ['T212 ISA STK', T212_ISA],
    ['T212 TRD STK', T212_TRD],
  ])('"%s" matches its portfolio', (csvName, portfolio) => {
    expect(match(csvName)).toEqual({ status: 'matched', portfolio });
  });

  it('the IBKR short import name matches the portfolio displayed with the account-number suffix', () => {
    expect(match('IBKR ISA STK')).toEqual({ status: 'matched', portfolio: IBKR_ISA });
    expect(IBKR_ISA.name).toBe('IBKR ISA STK (U9407868)');
  });

  it('the full suffixed IBKR display name is NOT accepted once import_name is set', () => {
    expect(match('IBKR ISA STK (U9407868)')).toEqual({ status: 'none' });
    expect(match('IBKR TRD STK (U6842190)')).toEqual({ status: 'none' });
  });

  it('ETRO/T212 (import_name null) match via their display names', () => {
    expect(effectiveImportName(ETRO_TRD)).toBe('ETRO TRD STK');
    expect(match('etro trd stk')).toEqual({ status: 'matched', portfolio: ETRO_TRD });
    expect(match('t212 isa stk')).toEqual({ status: 'matched', portfolio: T212_ISA });
    expect(match('T212 trd STK')).toEqual({ status: 'matched', portfolio: T212_TRD });
  });
});

describe('C18 — trimmed, case-insensitive, exact', () => {
  it('case-insensitive exact name', () => {
    expect(match('ibkr isa stk')).toEqual({ status: 'matched', portfolio: IBKR_ISA });
    expect(match('Ibkr Trd Stk')).toEqual({ status: 'matched', portfolio: IBKR_TRD });
  });

  it('leading/trailing whitespace on the CSV value is ignored (spaces, tabs, non-breaking spaces)', () => {
    expect(match('  IBKR ISA STK\t')).toEqual({ status: 'matched', portfolio: IBKR_ISA });
    expect(match('\u00A0T212 ISA STK\u00A0')).toEqual({ status: 'matched', portfolio: T212_ISA });
  });

  it('leading/trailing whitespace on the stored import_name or name is ignored', () => {
    const idx = indexPortfoliosByName([
      { id: 'p1', name: 'Display One', import_name: '  Import One ' },
      { id: 'p2', name: ' Padded Name ', import_name: null },
    ]);
    expect(matchPortfolioByName('import one', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p1' } });
    expect(matchPortfolioByName('padded name', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p2' } });
  });

  it('a portfolio row without an import_name property at all uses its display name', () => {
    const idx = indexPortfoliosByName([{ id: 'p1', name: 'Legacy Row' }]);
    expect(matchPortfolioByName('legacy row', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p1' } });
  });
});

describe('C18 — substring, prefix and similar names are rejected', () => {
  it.each([
    ['"ISA" (contained in several names)', 'ISA'],
    ['"IBKR" (prefix of both IBKR import names)', 'IBKR'],
    ['"T212" (prefix of both T212 names)', 'T212'],
    ['"IBKR ISA" (prefix)', 'IBKR ISA'],
    ['"IBKR ISA STK X" (longer name containing the import name)', 'IBKR ISA STK X'],
    ['"IBKR ISA STK (U1234567)" (same first 12 letters/digits, different account)', 'IBKR ISA STK (U1234567)'],
    ['"ETRO TRD" (prefix)', 'ETRO TRD'],
    ['"ETRO-TRD-STK" (punctuation differs)', 'ETRO-TRD-STK'],
    ['"ETRO  TRD STK" (inner whitespace is not collapsed)', 'ETRO  TRD STK'],
  ])('%s', (_label, csvName) => {
    expect(match(csvName)).toEqual({ status: 'none' });
  });

  it('"ISA" must not match "ISA Account", and "Trading" must not match "Trading 212"', () => {
    const idx = indexPortfoliosByName([
      { id: 'p-isa', name: 'ISA Account', import_name: null },
      { id: 'p-t212', name: 'Trading 212', import_name: null },
    ]);
    expect(matchPortfolioByName('ISA', idx)).toEqual({ status: 'none' });
    expect(matchPortfolioByName('Trading', idx)).toEqual({ status: 'none' });
  });

  it('two similar portfolio names never produce first-match behaviour', () => {
    const idx = indexPortfoliosByName([
      { id: 'p-a', name: 'ZZ IMPORT TEST AAAAAA', import_name: null },
      { id: 'p-b', name: 'ZZ IMPORT TEST BBBBBB', import_name: null },
    ]);
    // Formerly both matched the same 12-character prefix and the first won.
    expect(matchPortfolioByName('ZZ IMPORT TEST BBBBBB', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p-b' } });
    expect(matchPortfolioByName('ZZ IMPORT TEST', idx)).toEqual({ status: 'none' });
    expect(matchPortfolioByName('ZZ IMPORT TEST CCCCCC', idx)).toEqual({ status: 'none' });
  });

  it('blank or missing CSV name matches nothing', () => {
    expect(match('')).toEqual({ status: 'none' });
    expect(match('   ')).toEqual({ status: 'none' });
    expect(match(null)).toEqual({ status: 'none' });
    expect(match(undefined)).toEqual({ status: 'none' });
  });

  it('a portfolio whose effective import name is blank has no import name (never matched)', () => {
    const idx = indexPortfoliosByName([
      { id: 'p1', name: '   ', import_name: null },
      { id: 'p2', name: null, import_name: null },
    ]);
    expect(idx.size).toBe(0);
  });
});

describe('C18 — runtime ambiguity (second guard behind the database unique index)', () => {
  it('one portfolio\'s import_name equal to another\'s display name (import_name null): ambiguous, neither chosen', () => {
    const idx = indexPortfoliosByName([
      { id: 'p-a', name: 'IBKR ISA STK', import_name: null },
      { id: 'p-b', name: 'Something Else', import_name: ' ibkr isa stk ' },
    ]);
    expect(matchPortfolioByName('IBKR ISA STK', idx)).toEqual({ status: 'ambiguous' });
  });

  it('two import_names differing only by case/whitespace: ambiguous', () => {
    const idx = indexPortfoliosByName([
      { id: 'p1', name: 'One', import_name: 'Shared' },
      { id: 'p2', name: 'Two', import_name: ' SHARED ' },
      { id: 'p3', name: 'Other', import_name: null },
    ]);
    expect(matchPortfolioByName('shared', idx)).toEqual({ status: 'ambiguous' });
    expect(matchPortfolioByName('Other', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p3' } });
  });

  it('a portfolio\'s display name equal to another\'s import_name does not count once that portfolio has its own import_name', () => {
    // p-old's display name is shadowed by its import_name, so only p-new owns "ibkr isa stk (u9407868)".
    const idx = indexPortfoliosByName([
      { id: 'p-old', name: 'IBKR ISA STK (U9407868)', import_name: 'IBKR ISA STK' },
      { id: 'p-new', name: 'IBKR ISA STK (U9407868)', import_name: null },
    ]);
    expect(matchPortfolioByName('IBKR ISA STK (U9407868)', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p-new' } });
    expect(matchPortfolioByName('IBKR ISA STK', idx)).toMatchObject({ status: 'matched', portfolio: { id: 'p-old' } });
  });
});

describe('portfolioNameKey — parity with the database key function', () => {
  it('only trims and lower-cases', () => {
    expect(portfolioNameKey('  IBKR ISA STK (U9407868) ')).toBe('ibkr isa stk (u9407868)');
    expect(portfolioNameKey('A  B')).toBe('a  b');
  });

  it('the whitespace set spelled out in public.portfolio_import_key equals exactly what JavaScript trim() removes', () => {
    const migration = readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20260924130000_portfolio_import_name.sql'),
      'utf8',
    );
    const classMatch = migration.match(/'\^\[([^\]]+)\]\+\|/);
    expect(classMatch).not.toBeNull();
    const sqlSet = new Set<number>();
    for (const m of classMatch![1].matchAll(/\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?/g)) {
      const from = parseInt(m[1], 16);
      const to = m[2] ? parseInt(m[2], 16) : from;
      for (let c = from; c <= to; c++) sqlSet.add(c);
    }
    const jsSet = new Set<number>();
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (`${ch}x${ch}`.trim() === 'x') jsSet.add(c);
    }
    expect([...sqlSet].sort((a, b) => a - b)).toEqual([...jsSet].sort((a, b) => a - b));
  });
});
