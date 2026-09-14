// tests/lib/domain.spec.ts
//
// Pure-logic tests for src/lib/domain.ts — the shared normalisation used by
// both automatic new-asset domain enrichment
// (src/lib/newAssetDomainEnrichment.ts) and the manual "Corporate Domain"
// field on the Asset Edit page (PATCH /api/assets/edit). See the
// 2026-09-14 Logo.dev/company-domain audit and follow-up implementation.

import { describe, it, expect } from 'vitest';
import { normalizeDomain, domainLogoUrl, isManualLogoOverride } from '../../src/lib/domain';

describe('normalizeDomain', () => {
  it('accepts a bare hostname unchanged (lowercased)', () => {
    expect(normalizeDomain('Shopify.com')).toBe('shopify.com');
  });

  it('strips scheme, leading www., path, query and trailing slash from a full URL — the SHOP regression case', () => {
    expect(normalizeDomain('https://www.shopify.com/')).toBe('shopify.com');
  });

  it('strips a bare www.-prefixed hostname with no scheme', () => {
    expect(normalizeDomain('www.shopify.com')).toBe('shopify.com');
  });

  it('handles http (not just https), a path, and a query string', () => {
    expect(normalizeDomain('http://shopify.com/about?ref=x')).toBe('shopify.com');
  });

  it('handles a trailing dot (FQDN form)', () => {
    expect(normalizeDomain('shopify.com.')).toBe('shopify.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDomain('  shopify.com  ')).toBe('shopify.com');
  });

  it('preserves a real subdomain that is not "www"', () => {
    expect(normalizeDomain('https://investors.shopify.com')).toBe('investors.shopify.com');
  });

  it('returns null for null, undefined, and empty/whitespace-only input', () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
  });

  it('returns null for a single-label, non-domain-shaped string', () => {
    expect(normalizeDomain('notadomain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
  });

  it('returns null for garbage that cannot be parsed as a URL/host at all', () => {
    expect(normalizeDomain('   ://not a url   ')).toBeNull();
    expect(normalizeDomain('***')).toBeNull();
  });
});

describe('domainLogoUrl', () => {
  it('builds the domain: marker src/app/page.tsx and /api/logo-proxy expect', () => {
    expect(domainLogoUrl('shopify.com')).toBe('domain:shopify.com');
  });
});

describe('isManualLogoOverride', () => {
  it('recognises a manual: prefix (case-insensitively), matching the CAKE-style existing convention', () => {
    expect(isManualLogoOverride('manual:domain:cheesecakefactory.com')).toBe(true);
    expect(isManualLogoOverride('MANUAL:https://example.com/logo.png')).toBe(true);
  });

  it('is false for a plain domain marker, null, or empty', () => {
    expect(isManualLogoOverride('domain:shopify.com')).toBe(false);
    expect(isManualLogoOverride(null)).toBe(false);
    expect(isManualLogoOverride(undefined)).toBe(false);
    expect(isManualLogoOverride('')).toBe(false);
  });
});
