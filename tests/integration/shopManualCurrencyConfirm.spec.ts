// tests/integration/shopManualCurrencyConfirm.spec.ts
//
// DEV-ONLY end-to-end regression coverage for the 2026-09-14 SHOP DEV
// acceptance-test failure: a real browser import of a genuinely-new ticker
// (SHOP) whose automatic currency lookup failed, with the user selecting a
// manual currency in the UI, still aborted with "Import aborted: 1 row
// reference a ticker that isn't a recognised asset ... not confirmed for
// import, or its asset could not be created."
//
// Root cause (see src/lib/importConfirmSelection.ts for the full writeup):
// the "New Tickers" checkbox and the manual-currency <select> were two
// independent pieces of client state. Selecting a currency never confirmed
// the ticker, so a user who only interacted with the currency dropdown
// never actually got their ticker into the `confirmedTickers` list the
// client sends — the server then correctly refused to create an
// unconfirmed asset, and the all-or-nothing gate aborted the whole import.
//
// Unlike tests/import/manual-asset-metadata.spec.ts (a pure decision-logic
// test) and tests/import/import-confirm-selection.spec.ts (a pure
// state-transition test), THIS file exercises the complete real pipeline —
// a real authenticated HTTP request to the real running Next.js dev server,
// through the real /api/import-transactions route, against the real local
// Supabase — reproducing the actual integration gap between "confirmed
// ticker -> manual metadata -> asset creation -> refreshed asset
// resolution/assetsMap -> unresolved-ticker gate -> transaction creation"
// that no pure-function test could have caught.
//
// Requires the local dev stack AND the local Next.js dev server running
// (scripts/dev/dev-start.sh). Creates a temporary portfolio and a
// uniquely-named fake ticker per run (never colliding with real DEV data),
// and deletes everything it creates in afterAll. Never touches PROD.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localServiceClient } from './helpers/localSupabaseAuth';
import { assertAppServerReachable, buildAuthenticatedCookieHeader, APP_ORIGIN } from './helpers/liveAppSession';
import { withCurrencySelected } from '../../src/lib/importConfirmSelection';

const OWNER_EMAIL = 'jonathankeay@outlook.com';
const OWNER_USER_ID = 'b6902c68-69ce-4af7-af55-99322b5d1e38';

const svc = localServiceClient();

let cookie = '';
let tempPortfolioId = '';
const TEMP_PORTFOLIO_NAME = `ZZ IMPORT TEST ${randomUUID().slice(0, 6).toUpperCase()}`;

function csvFor(ticker: string, portfolioName: string) {
  const header = 'portfolio,ticker,transaction_type,date_time,quantity,price,fee,fxrate,cash_value,notes';
  const row = [portfolioName, ticker, 'buy', '2026-09-13T10:00:00', '10', '100', '0', '', '', 'regression test row'].join(',');
  return `${header}\n${row}\n`;
}

async function callImportApi(
  stage: 'preview' | 'confirm',
  csv: string,
  confirmedTickers?: string[],
  manualTickerMetadata?: Record<string, { currency: string; name?: string }>
) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'regression.csv');
  if (confirmedTickers) form.append('confirmedTickers', JSON.stringify(confirmedTickers));
  if (manualTickerMetadata) form.append('manualTickerMetadata', JSON.stringify(manualTickerMetadata));

  const res = await fetch(`${APP_ORIGIN}/api/import-transactions?stage=${stage}`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function deleteAssetAndTransactions(ticker: string) {
  const { data: asset } = await svc.from('assets').select('id').eq('ticker', ticker).maybeSingle();
  if (asset?.id) {
    await svc.from('transactions').delete().eq('asset_id', asset.id);
    await svc.from('asset_aliases').delete().eq('asset_id', asset.id);
    await svc.from('assets').delete().eq('id', asset.id);
  }
}

beforeAll(async () => {
  await assertAppServerReachable();
  cookie = await buildAuthenticatedCookieHeader(OWNER_EMAIL);

  const { data: portfolio, error } = await svc
    .from('portfolios')
    .insert({ name: TEMP_PORTFOLIO_NAME, base_currency: 'USD', user_id: OWNER_USER_ID })
    .select('id')
    .single();
  if (error) throw error;
  tempPortfolioId = portfolio.id;
});

afterAll(async () => {
  if (tempPortfolioId) {
    await svc.from('transactions').delete().eq('portfolio_id', tempPortfolioId);
    await svc.from('portfolios').delete().eq('id', tempPortfolioId);
  }
});

describe('SHOP-style manual-currency confirm flow', () => {
  it(
    'reproduces the exact observed bug: currency supplied but ticker never confirmed aborts the whole import',
    async () => {
      const ticker = `ZZSHOPBUG${randomUUID().slice(0, 6).toUpperCase()}`;
      const csv = csvFor(ticker, TEMP_PORTFOLIO_NAME);

      // Preview: genuinely new fake ticker, automatic lookup guaranteed to
      // find nothing real for it.
      const preview = await callImportApi('preview', csv);
      expect(preview.status).toBe(200);
      const entry = preview.body.newTickers.find((t: any) => t.ticker === ticker);
      expect(entry?.needsManualCurrency).toBe(true);

      // This is exactly what the unfixed client could send: manual currency
      // metadata present, but confirmedTickers empty because the checkbox
      // was never ticked (only the currency <select> was touched).
      const confirm = await callImportApi('confirm', csv, [], { [ticker]: { currency: 'USD' } });

      expect(confirm.status).toBe(400);
      expect(confirm.body.message).toContain('Import aborted');
      expect(confirm.body.message).toContain('not a recognised asset');
      expect(confirm.body.unresolvedTickerRows).toHaveLength(1);
      expect(confirm.body.unresolvedTickerRows[0].ticker).toBe(ticker);
      expect(confirm.body.unresolvedTickerRows[0].reason).toContain('not confirmed for import, or its asset could not be created');

      const { data: asset } = await svc.from('assets').select('id').eq('ticker', ticker).maybeSingle();
      expect(asset).toBeNull();

      await deleteAssetAndTransactions(ticker);
    },
    30000
  );

  it(
    'the fix: selecting a currency (via the real production withCurrencySelected helper) confirms the ticker and the import completes',
    async () => {
      const ticker = `ZZSHOPFIX${randomUUID().slice(0, 6).toUpperCase()}`;
      const csv = csvFor(ticker, TEMP_PORTFOLIO_NAME);

      const preview = await callImportApi('preview', csv);
      expect(preview.status).toBe(200);
      const entry = preview.body.newTickers.find((t: any) => t.ticker === ticker);
      expect(entry?.needsManualCurrency).toBe(true);

      // Simulate the browser: the user never ticks the checkbox directly —
      // they only interact with the currency <select>. Drive this through
      // the SAME production function src/app/import/page.tsx now calls from
      // that <select>'s onChange, exactly as the real UI does.
      let confirmedTickers: Record<string, boolean> = {};
      confirmedTickers = withCurrencySelected(confirmedTickers, ticker, 'USD');
      expect(confirmedTickers[ticker]).toBe(true);

      const confirmedList = Object.keys(confirmedTickers).filter((t) => confirmedTickers[t]);
      const confirm = await callImportApi('confirm', csv, confirmedList, { [ticker]: { currency: 'USD' } });

      expect(confirm.status).toBe(200);
      expect(confirm.body.message).toContain('Imported 1 transaction');

      const { data: asset } = await svc.from('assets').select('id, ticker, currency').eq('ticker', ticker).maybeSingle();
      expect(asset).not.toBeNull();
      expect(asset?.currency).toBe('USD');

      const { data: txns } = await svc.from('transactions').select('id, asset_id, portfolio_id').eq('portfolio_id', tempPortfolioId);
      expect(txns).toHaveLength(1);
      expect(txns?.[0].asset_id).toBe(asset?.id);

      await deleteAssetAndTransactions(ticker);
    },
    30000
  );
});
