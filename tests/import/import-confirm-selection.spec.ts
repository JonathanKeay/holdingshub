// tests/import/import-confirm-selection.spec.ts
//
// Unit coverage for src/lib/importConfirmSelection.ts — the fix for the
// 2026-09-14 SHOP DEV acceptance-test failure (see that file's header for
// the full root-cause writeup). This alone does NOT prove the browser bug
// is fixed end-to-end — see tests/integration/shopManualCurrencyConfirm.spec.ts
// for the full confirm-flow regression test that exercises the real
// pipeline this function feeds into.

import { describe, it, expect } from 'vitest';
import { withCurrencySelected } from '../../src/lib/importConfirmSelection';

describe('withCurrencySelected', () => {
  it('confirms a ticker when a currency is selected for the first time', () => {
    const result = withCurrencySelected({}, 'SHOP', 'USD');
    expect(result).toEqual({ SHOP: true });
  });

  it('does not touch other tickers already in the map', () => {
    const result = withCurrencySelected({ AAPL: true, MSFT: false }, 'SHOP', 'USD');
    expect(result).toEqual({ AAPL: true, MSFT: false, SHOP: true });
  });

  it('does nothing when currency is cleared back to empty', () => {
    const before = { SHOP: false };
    const result = withCurrencySelected(before, 'SHOP', '');
    expect(result).toBe(before); // same reference — no unnecessary state update
  });

  it('does nothing when ticker is empty', () => {
    const before = {};
    const result = withCurrencySelected(before, '', 'USD');
    expect(result).toBe(before);
  });

  it('is a no-op (same reference) once the ticker is already confirmed', () => {
    const before = { SHOP: true };
    const result = withCurrencySelected(before, 'SHOP', 'USD');
    expect(result).toBe(before);
  });

  it('re-confirms a ticker the user had explicitly unchecked, if they then pick a currency again', () => {
    const result = withCurrencySelected({ SHOP: false }, 'SHOP', 'GBP');
    expect(result).toEqual({ SHOP: true });
  });
});
