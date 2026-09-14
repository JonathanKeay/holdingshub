// src/lib/domain.ts
//
// Pure domain-normalisation logic, shared by:
// - automatic corporate-domain discovery at new-asset creation
//   (src/lib/newAssetDomainEnrichment.ts, wired in from
//   src/app/api/import-transactions/route.ts)
// - manual domain entry in the Asset Edit UI
//   (src/app/assets/edit/page.tsx via PATCH /api/assets/edit)
//
// Both paths must produce the exact same on-disk representation so that
// assets.domain and assets.logo_url ("domain:<host>") never silently
// disagree depending on which path set them — see the 2026-09-14
// Logo.dev/company-domain audit, which found existing assets where they
// already do (e.g. CAKE: domain="thecheesecakefactory.com" but
// logo_url="manual:domain:cheesecakefactory.com").

const MAX_DOMAIN_LENGTH = 253;

// Loose hostname shape check: dot-separated labels of letters/digits/
// hyphens, at least two labels (so a bare word like "localhost" is never
// treated as a real corporate domain here). Not a full RFC 1035 validator —
// good enough to reject obvious garbage without rejecting real-world
// domains.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Normalise a user- or provider-supplied domain/URL into a bare lowercase
 * hostname ("shopify.com"), or return null if the input doesn't look like a
 * usable domain. Accepts a bare hostname or a full URL (with or without a
 * scheme), and strips a leading "www.", any path/query/fragment/port, and
 * a trailing dot.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let hostname: string;
  try {
    // Bare hostnames (no "://") need a scheme before the WHATWG URL parser
    // will treat them as a host rather than a relative path.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }

  hostname = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!hostname || hostname.length > MAX_DOMAIN_LENGTH) return null;
  if (!HOSTNAME_RE.test(hostname)) return null;
  return hostname;
}

/** Build the assets.logo_url marker value the frontend/logo-proxy pipeline expects for a normalised domain (see src/app/page.tsx and /api/logo-proxy). */
export function domainLogoUrl(domain: string): string {
  return `domain:${domain}`;
}

/** True if logo_url is a deliberate manual override that automatic enrichment must never overwrite (see src/lib/logo.ts's existing isManualLogoUrl convention). */
export function isManualLogoOverride(logoUrl: string | null | undefined): boolean {
  return typeof logoUrl === 'string' && /^manual:/i.test(logoUrl.trim());
}
