// tests/integration/assetEditDomain.spec.ts
//
// DEV-ONLY integration coverage for the new "Corporate Domain" field on
// the Asset Edit page (src/app/assets/edit/page.tsx) and its PATCH
// /api/assets/edit handler — the manual fallback half of the 2026-09-14
// Logo.dev/company-domain feature (automatic enrichment is the other half;
// see tests/integration/newAssetDomainEnrichment.spec.ts). Exercises the
// real route over HTTP with a real authenticated session, against a
// temporary asset row in the local dev Supabase — never PROD, never the
// real SHOP row.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localServiceClient } from './helpers/localSupabaseAuth';
import { assertAppServerReachable, buildAuthenticatedCookieHeader, APP_ORIGIN } from './helpers/liveAppSession';

const OWNER_EMAIL = 'jonathankeay@outlook.com';

const svc = localServiceClient();
let cookie = '';
const createdAssetIds: string[] = [];

async function createTempAsset(ticker: string, overrides: { domain?: string | null; logo_url?: string | null } = {}) {
  const { data, error } = await svc
    .from('assets')
    .insert({
      ticker,
      name: `${ticker} edit-test fixture`,
      currency: 'USD',
      status: 'active',
      price_multiplier: 1,
      domain: overrides.domain ?? null,
      logo_url: overrides.logo_url ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdAssetIds.push(data.id);
  return data.id as string;
}

async function patchAsset(payload: Record<string, unknown>) {
  const res = await fetch(`${APP_ORIGIN}/api/assets/edit`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function basePayload(id: string, domain: string | null) {
  return {
    id,
    name: 'Fixture Name',
    resolved_ticker: null,
    status: 'active',
    delisted_at: null,
    price_multiplier: 1,
    domain,
  };
}

beforeAll(async () => {
  await assertAppServerReachable();
  cookie = await buildAuthenticatedCookieHeader(OWNER_EMAIL);
});

afterEach(async () => {
  while (createdAssetIds.length) {
    const id = createdAssetIds.pop()!;
    await svc.from('assets').delete().eq('id', id);
  }
});

describe('PATCH /api/assets/edit — Corporate Domain field', () => {
  it('shopify.com example from the brief: saving a bare domain sets both domain and logo_url consistently', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker);

    const { status, body } = await patchAsset(basePayload(id, 'shopify.com'));

    expect(status).toBe(200);
    expect(body.asset.domain).toBe('shopify.com');
    expect(body.asset.logo_url).toBe('domain:shopify.com');
  });

  it('normalises a full pasted URL (https://www.shopify.com/) to the bare domain form, same as automatic discovery', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker);

    const { status, body } = await patchAsset(basePayload(id, 'https://www.shopify.com/'));

    expect(status).toBe(200);
    expect(body.asset.domain).toBe('shopify.com');
    expect(body.asset.logo_url).toBe('domain:shopify.com');
  });

  it('preserves an existing manual: logo override unchanged, even though the domain field was saved — the highest-priority explicit user choice', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker, { logo_url: 'manual:domain:old-override.example' });

    const { status, body } = await patchAsset(basePayload(id, 'shopify.com'));

    expect(status).toBe(200);
    // domain is always updated to reflect what was typed...
    expect(body.asset.domain).toBe('shopify.com');
    // ...but the pre-existing manual override is left completely alone.
    expect(body.asset.logo_url).toBe('manual:domain:old-override.example');
  });

  it('DOES overwrite a non-manual logo_url (an existing domain: marker) when a new domain is saved', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker, { domain: 'old.example', logo_url: 'domain:old.example' });

    const { status, body } = await patchAsset(basePayload(id, 'shopify.com'));

    expect(status).toBe(200);
    expect(body.asset.domain).toBe('shopify.com');
    expect(body.asset.logo_url).toBe('domain:shopify.com');
  });

  it('rejects an unusable domain with 400 and writes nothing', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker, { domain: 'existing.example', logo_url: 'domain:existing.example' });

    const { status, body } = await patchAsset(basePayload(id, 'not a domain ***'));

    expect(status).toBe(400);
    expect(body.error).toContain('valid domain');

    const { data: row } = await svc.from('assets').select('domain, logo_url').eq('id', id).single();
    expect(row?.domain).toBe('existing.example');
    expect(row?.logo_url).toBe('domain:existing.example');
  });

  it('clearing the field (empty string) clears domain but leaves an existing logo_url untouched', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker, { domain: 'existing.example', logo_url: 'domain:existing.example' });

    const { status, body } = await patchAsset(basePayload(id, ''));

    expect(status).toBe(200);
    expect(body.asset.domain).toBeNull();
    expect(body.asset.logo_url).toBe('domain:existing.example');
  });

  it('clearing the field never destroys a manual: override either', async () => {
    const ticker = `ZZEDITDOM${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createTempAsset(ticker, { domain: 'existing.example', logo_url: 'manual:domain:keep-me.example' });

    const { status, body } = await patchAsset(basePayload(id, ''));

    expect(status).toBe(200);
    expect(body.asset.domain).toBeNull();
    expect(body.asset.logo_url).toBe('manual:domain:keep-me.example');
  });
});
