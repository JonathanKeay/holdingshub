// tests/integration/newAssetDomainEnrichment.spec.ts
//
// DEV-ONLY integration coverage for the 2026-09-14 automatic corporate-
// domain enrichment feature (src/lib/newAssetDomainEnrichment.ts), the
// fix for the SHOP DEV regression: a genuinely new asset previously got no
// domain/logo at all unless someone manually edited it in Supabase — see
// the read-only Logo.dev/company-domain audit this implements.
//
// Two describe blocks:
//  - enrichNewAssetDomain against a real temporary asset row in the local
//    dev Supabase (proves the DB write, and — the requirement this audit
//    called out specifically — that an existing manual: override is never
//    overwritten by automatic enrichment).
//  - a full end-to-end run of the real /api/import-transactions confirm
//    stage with a genuinely new fake ticker, proving a real Finnhub
//    "no company profile found" result (Finnhub cannot know a random fake
//    ticker) still lets the import complete successfully — the import
//    must never be blocked or slowed meaningfully by domain discovery.
//
// Deliberately does NOT touch the real SHOP asset row — per the
// implementation brief, SHOP must stay unfixed by this work; the
// mechanism SHOP would go through is proven here against temporary,
// uniquely-named fixtures instead, and cleaned up in afterAll/afterEach.
//
// Requires the local dev stack AND the local Next.js dev server
// (scripts/dev/dev-start.sh) running. Never touches PROD.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localServiceClient } from './helpers/localSupabaseAuth';
import { assertAppServerReachable, buildAuthenticatedCookieHeader, APP_ORIGIN } from './helpers/liveAppSession';
import { enrichNewAssetDomain } from '../../src/lib/newAssetDomainEnrichment';

const OWNER_EMAIL = 'jonathankeay@outlook.com';
const OWNER_USER_ID = 'b6902c68-69ce-4af7-af55-99322b5d1e38';

const svc = localServiceClient();
const createdAssetIds: string[] = [];

async function createTempAsset(overrides: { ticker: string; domain?: string | null; logo_url?: string | null }) {
  const { data, error } = await svc
    .from('assets')
    .insert({
      ticker: overrides.ticker,
      name: `${overrides.ticker} test fixture`,
      currency: 'USD',
      domain: overrides.domain ?? null,
      logo_url: overrides.logo_url ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdAssetIds.push(data.id);
  return data.id as string;
}

afterEach(async () => {
  while (createdAssetIds.length) {
    const id = createdAssetIds.pop()!;
    await svc.from('assets').delete().eq('id', id);
  }
});

describe('enrichNewAssetDomain — against the real local dev Supabase', () => {
  it('the SHOP mechanism, proven on a temporary fixture: a shopify.com weburl is discovered and persisted as both domain and logo_url', async () => {
    const ticker = `ZZDOMAIN${randomUUID().slice(0, 6).toUpperCase()}`;
    const assetId = await createTempAsset({ ticker });

    const lookup = async (_t: string) => 'https://www.shopify.com/';
    const result = await enrichNewAssetDomain(svc, assetId, ticker, lookup);

    expect(result).toEqual({ status: 'enriched', domain: 'shopify.com' });

    const { data: row } = await svc.from('assets').select('domain, logo_url').eq('id', assetId).single();
    expect(row?.domain).toBe('shopify.com');
    expect(row?.logo_url).toBe('domain:shopify.com');
  });

  it('does NOT overwrite an existing manual: logo override (CAKE-style) even if a domain is discovered', async () => {
    const ticker = `ZZDOMAIN${randomUUID().slice(0, 6).toUpperCase()}`;
    const assetId = await createTempAsset({
      ticker,
      domain: null,
      logo_url: 'manual:domain:custom-override.example',
    });

    const lookup = async (_t: string) => 'https://www.shopify.com/';
    const result = await enrichNewAssetDomain(svc, assetId, ticker, lookup);

    expect(result).toEqual({ status: 'skipped', reason: 'already-set' });

    const { data: row } = await svc.from('assets').select('domain, logo_url').eq('id', assetId).single();
    // Unchanged: the manual override survives, and no domain was written
    // alongside it — the two columns are never left disagreeing by this path.
    expect(row?.logo_url).toBe('manual:domain:custom-override.example');
    expect(row?.domain).toBeNull();
  });

  it('leaves both columns null when discovery finds nothing — the asset stays fully usable without a logo', async () => {
    const ticker = `ZZDOMAIN${randomUUID().slice(0, 6).toUpperCase()}`;
    const assetId = await createTempAsset({ ticker });

    const lookup = async (_t: string) => null;
    const result = await enrichNewAssetDomain(svc, assetId, ticker, lookup);

    expect(result).toEqual({ status: 'skipped', reason: 'no-domain-found' });

    const { data: row } = await svc.from('assets').select('domain, logo_url').eq('id', assetId).single();
    expect(row?.domain).toBeNull();
    expect(row?.logo_url).toBeNull();
  });

  it('a lookup failure never throws out of enrichNewAssetDomain, and leaves the asset untouched', async () => {
    const ticker = `ZZDOMAIN${randomUUID().slice(0, 6).toUpperCase()}`;
    const assetId = await createTempAsset({ ticker });

    const lookup = async (_t: string) => {
      throw new Error('Finnhub is down');
    };

    await expect(enrichNewAssetDomain(svc, assetId, ticker, lookup)).resolves.toEqual({
      status: 'skipped',
      reason: 'no-domain-found',
    });

    const { data: row } = await svc.from('assets').select('domain, logo_url').eq('id', assetId).single();
    expect(row?.domain).toBeNull();
    expect(row?.logo_url).toBeNull();
  });
});

describe('/api/logo-proxy — proves the render path works once domain:shopify.com is set (no mocking)', () => {
  it('returns a real logo image for domain=shopify.com', async () => {
    await assertAppServerReachable();
    const res = await fetch(`${APP_ORIGIN}/api/logo-proxy?domain=shopify.com&format=png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('image');
  }, 15000);
});

describe('Confirm & Import stays safe when real domain discovery finds nothing for a genuinely new ticker', () => {
  let cookie = '';
  let tempPortfolioId = '';
  const TEMP_PORTFOLIO_NAME = `ZZ DOMAIN TEST ${randomUUID().slice(0, 6).toUpperCase()}`;

  function csvFor(ticker: string, portfolioName: string) {
    const header = 'portfolio,ticker,transaction_type,date_time,quantity,price,fee,fxrate,cash_value,notes';
    const row = [portfolioName, ticker, 'buy', '2026-09-13T10:00:00', '10', '100', '0', '', '', 'domain enrichment regression test'].join(',');
    return `${header}\n${row}\n`;
  }

  async function callImportApi(stage: 'preview' | 'confirm', csv: string, confirmedTickers?: string[], manualTickerMetadata?: Record<string, { currency: string }>) {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'domain-test.csv');
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

  it(
    'a real confirm-stage import of a brand-new fake ticker succeeds even though Finnhub genuinely finds no company profile for it',
    async () => {
      const ticker = `ZZDOMAINIMPORT${randomUUID().slice(0, 6).toUpperCase()}`;
      const csv = csvFor(ticker, TEMP_PORTFOLIO_NAME);

      const preview = await callImportApi('preview', csv);
      expect(preview.status).toBe(200);

      const confirm = await callImportApi('confirm', csv, [ticker], { [ticker]: { currency: 'USD' } });
      expect(confirm.status).toBe(200);
      expect(confirm.body.message).toContain('Imported 1 transaction');

      const { data: asset } = await svc.from('assets').select('id, domain, logo_url').eq('ticker', ticker).maybeSingle();
      expect(asset).not.toBeNull();
      // A fake, never-listed ticker: Finnhub genuinely has no profile for
      // it, so enrichment is expected to find nothing — proving that
      // outcome still leaves a fully usable, successfully-imported asset.
      expect(asset?.domain).toBeNull();
      expect(asset?.logo_url).toBeNull();

      await svc.from('transactions').delete().eq('asset_id', asset!.id);
      await svc.from('assets').delete().eq('id', asset!.id);
    },
    30000
  );
});
