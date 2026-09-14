// tests/import/new-asset-domain-enrichment.spec.ts
//
// Pure-logic tests for resolveNewAssetDomain (src/lib/newAssetDomainEnrichment.ts)
// — the discovery half of the 2026-09-14 automatic corporate-domain
// enrichment feature. `lookup` here is a spy standing in for the real
// fetchCompanyWeburlFromFinnhub (src/lib/logo.ts), exactly the same
// dependency-injection pattern tests/import/confirm-ticker-meta-resolution
// .spec.ts already uses for fetchTickerMeta — so "was the lookup called",
// "what did it return", and "does a failure ever escape" are all plain
// assertions, not something inferred from a real network call.
//
// The DB-write half (enrichNewAssetDomain's update, including the
// never-overwrite-a-manual-override guarantee) is covered separately in
// tests/integration/newAssetDomainEnrichment.spec.ts against the real
// local dev Supabase, since that behaviour depends on a real `.is(...)`
// filter round-trip that a mock client can't meaningfully stand in for.

import { describe, it, expect, vi } from 'vitest';
import { resolveNewAssetDomain } from '../../src/lib/newAssetDomainEnrichment';

describe('resolveNewAssetDomain — successful discovery', () => {
  it('normalises a full weburl (the SHOP regression case) into a bare domain', async () => {
    const lookup = vi.fn(async (_t: string) => 'https://www.shopify.com/');

    const result = await resolveNewAssetDomain('SHOP', lookup);

    expect(lookup).toHaveBeenCalledWith('SHOP');
    expect(result).toBe('shopify.com');
  });

  it('normalises a bare hostname the same way', async () => {
    const lookup = vi.fn(async (_t: string) => 'shopify.com');
    expect(await resolveNewAssetDomain('SHOP', lookup)).toBe('shopify.com');
  });
});

describe('resolveNewAssetDomain — discovery failure is always non-fatal', () => {
  it('returns null when the lookup finds nothing (no weburl)', async () => {
    const lookup = vi.fn(async (_t: string) => null);
    expect(await resolveNewAssetDomain('ZZFAKE', lookup)).toBeNull();
  });

  it('returns null, never throws, when the lookup itself throws (e.g. network error)', async () => {
    const lookup = vi.fn(async (_t: string) => {
      throw new Error('Finnhub is down');
    });
    await expect(resolveNewAssetDomain('ZZFAKE', lookup)).resolves.toBeNull();
  });

  it('returns null, never throws, when the lookup rejects', async () => {
    const lookup = vi.fn((_t: string) => Promise.reject(new Error('timeout')));
    await expect(resolveNewAssetDomain('ZZFAKE', lookup)).resolves.toBeNull();
  });

  it('returns null when the lookup returns an unparseable value', async () => {
    const lookup = vi.fn(async (_t: string) => 'not a url at all ***');
    expect(await resolveNewAssetDomain('ZZFAKE', lookup)).toBeNull();
  });
});
