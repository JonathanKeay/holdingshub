// Simple in-memory version tracker for price updates.
// The price streamer calls /api/prices/revalidate, which bumps this version.
// The client polls /api/prices/version to know when to refresh the page data.

let lastVersion: string | null = null;

export function bumpPricesVersion(at?: string) {
  lastVersion = at ?? new Date().toISOString();
  return lastVersion;
}

export function getPricesVersion() {
  return lastVersion;
}
