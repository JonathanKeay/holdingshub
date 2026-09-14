// tests/integration/helpers/liveAppSession.ts
//
// DEV-ONLY test helper for integration tests that need to hit the REAL
// running Next.js dev server's HTTP route handlers (not just Supabase
// directly) with a real authenticated, browser-equivalent session.
//
// Why this exists (and localSupabaseAuth.ts's minted bearer token isn't
// enough here): routes like /api/import-transactions authenticate via
// getSupabaseServerClient() (src/lib/supabase-server.ts), which reads its
// session from @supabase/ssr COOKIES (src/lib/supabase/server.ts), not an
// Authorization header. A bearer-token client talking directly to
// PostgREST/GoTrue never exercises that cookie path at all.
//
// This establishes a REAL GoTrue session — via the service-role admin
// generateLink() + a real verifyOtp() call against the local auth
// container, never touching the real user's password or sending any email
// (generateLink never sends one) — and captures the exact cookies
// @supabase/ssr's own storage code writes for that session, using the same
// get/set/remove cookie adapter shape src/lib/supabase/server.ts uses. The
// resulting Cookie header is then indistinguishable, from the app's
// perspective, from a real logged-in browser's session cookie.
//
// Requires BOTH the local Supabase stack AND the local Next.js dev server
// (scripts/dev/dev-start.sh) to be running. Refuses to run against
// anything that isn't the local dev stack.

import path from 'node:path';
import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function assertLocalUrl(url: string) {
  if (!/172\.16\.20\.223|127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(`liveAppSession: refusing to run — URL does not look like the local dev stack (${url}).`);
  }
}

export const APP_ORIGIN = process.env.LIVE_APP_ORIGIN || 'http://127.0.0.1:3000';

export async function assertAppServerReachable(): Promise<void> {
  try {
    await fetch(APP_ORIGIN, { method: 'GET' });
  } catch (err) {
    throw new Error(
      `liveAppSession: the local Next.js dev server is not reachable at ${APP_ORIGIN}. ` +
        `Start it first (scripts/dev/dev-start.sh) before running this test. Original error: ${String(err)}`
    );
  }
}

export async function buildAuthenticatedCookieHeader(email: string): Promise<string> {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceUrl = process.env.SUPABASE_URL || publicUrl;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  assertLocalUrl(publicUrl);
  assertLocalUrl(serviceUrl);

  const svc = createClient(serviceUrl, svcKey);
  const jar = new Map<string, string>();

  const authClient = createServerClient(publicUrl, anonKey, {
    cookies: {
      get: (name: string) => jar.get(name),
      set: (name: string, value: string) => { jar.set(name, value); },
      remove: (name: string) => { jar.delete(name); },
    },
  });

  const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkErr) throw linkErr;
  const hashedToken = (linkData as any)?.properties?.hashed_token;
  if (!hashedToken) throw new Error('liveAppSession: generateLink did not return a hashed_token');

  const { error: verifyErr } = await authClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashedToken,
  });
  if (verifyErr) throw verifyErr;

  // The SIGNED_IN onAuthStateChange callback that writes cookies fires
  // asynchronously; give it a moment to run before reading the jar.
  await new Promise((r) => setTimeout(r, 300));

  if (jar.size === 0) {
    throw new Error('liveAppSession: no cookies captured after sign-in — cannot build an authenticated session');
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}
