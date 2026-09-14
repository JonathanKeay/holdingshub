// src/lib/importConfirmSelection.ts
//
// Pure state-transition helper for the CSV import confirm-stage UI
// (src/app/import/page.tsx). Extracted so the fix below is directly
// testable — see tests/import/import-confirm-selection.spec.ts and the
// full end-to-end regression coverage in
// tests/integration/shopManualCurrencyConfirm.spec.ts.
//
// Root cause of the 2026-09-14 SHOP DEV acceptance-test failure: the "New
// Tickers" checkbox (confirmedTickers state) and the manual-currency
// <select> (manualMeta state) were two completely independent pieces of
// React state. A user could select a currency for a ticker that needed
// manual currency entry WITHOUT ever ticking that ticker's checkbox — the
// currency panel is rendered and interactive regardless of checkbox state.
// When that happened, handleConfirm() only ever reads confirmedTickers to
// build the `confirmedTickers` list sent to the server, so the ticker
// silently never reached the server as confirmed — even though the user
// had filled in everything the on-screen warning asked for. The server then
// correctly (by design) refused to create an unconfirmed asset, and the
// all-or-nothing unresolved-ticker gate aborted the whole import with a
// generic "not confirmed for import, or its asset could not be created"
// message that gave no hint the checkbox itself was the missing piece.
// Reproduced exactly via a live authenticated request to /api/import-
// transactions during the investigation (confirmedTickers: [],
// manualTickerMetadata: { SHOP: { currency: 'USD' } }) — this exact
// combination is what the pure browser UI was capable of sending.
//
// Fix: selecting a non-empty currency for a ticker is itself a deliberate,
// explicit user action naming that ticker — treat it as confirming the
// ticker too, exactly like ticking its checkbox would. This does not weaken
// the "never silently create an unconfirmed asset" safeguard: an asset is
// still only ever created because of an explicit, visible user action (now
// either control), never automatically or by inference from unrelated
// state. The checkbox itself still works exactly as before and still shows
// its state correctly (it's driven by the same confirmedTickers map this
// function updates).

export function withCurrencySelected<T extends Record<string, boolean>>(
  confirmedTickers: T,
  ticker: string,
  currency: string
): T {
  if (!ticker || !currency) return confirmedTickers;
  if (confirmedTickers[ticker]) return confirmedTickers;
  return { ...confirmedTickers, [ticker]: true };
}
