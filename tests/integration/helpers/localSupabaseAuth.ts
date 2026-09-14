// tests/integration/helpers/localSupabaseAuth.ts
//
// DEV-ONLY test helper. Mints a locally-signed access token for an arbitrary
// user id so integration tests can exercise the real RLS/grant boundary
// through a real @supabase/supabase-js client — the same network-level
// mechanism getSupabaseServerClient() (src/lib/supabase-server.ts, via
// @supabase/ssr) uses in the real app: an anon-key client with an
// `Authorization: Bearer <access token>` header. PostgREST/RLS cannot tell
// the difference between this and a token GoTrue issued through a real
// login — the signature, `sub`, and `role` claims are what matter, and this
// stack uses a single shared HS256 secret for both.
//
// Deliberately does NOT touch the real user's password or send any auth
// email — it never interacts with GoTrue's login flow at all, so it cannot
// affect anyone's real credentials. The signing secret is read directly out
// of the local `supabase_auth_holdingshub` container's own environment at
// test-run time (never hard-coded, never logged, never asserted on) — this
// only works against the LOCAL dev stack; there is no equivalent access to
// the hosted/production project's signing secret from here.

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Resolved against the process cwd (repo root) rather than import.meta.url —
// both vitest and tsx run from the repo root for this project, and this
// avoids ESM/CJS __dirname differences across the two runners.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function assertLocalUrl(url: string) {
  if (!/172\.16\.20\.223|127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(
      `localSupabaseAuth: refusing to run — NEXT_PUBLIC_SUPABASE_URL does not look like the local dev stack (${url}). ` +
        `These tests mint tokens using a secret read from the local auth container and must never run against a remote project.`
    );
  }
}

let cachedSecret: string | null = null;
function getLocalJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const out = execSync(
    `docker inspect supabase_auth_holdingshub --format '{{range .Config.Env}}{{println .}}{{end}}'`,
    { encoding: 'utf8' }
  );
  const line = out.split('\n').find((l) => l.startsWith('GOTRUE_JWT_SECRET='));
  if (!line) {
    throw new Error(
      'localSupabaseAuth: GOTRUE_JWT_SECRET not found on supabase_auth_holdingshub — is the local Supabase stack running?'
    );
  }
  cachedSecret = line.slice('GOTRUE_JWT_SECRET='.length);
  return cachedSecret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function mintLocalAccessToken(userId: string, opts?: { email?: string; expiresInSeconds?: number }): string {
  const secret = getLocalJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'http://127.0.0.1:54321/auth/v1',
    iat: now,
    exp: now + (opts?.expiresInSeconds ?? 3600),
  };
  if (opts?.email) payload.email = opts.email;

  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

/** A client that talks to the local dev API exactly as the real dashboard's authenticated request-scoped client does, for the given user id. */
export function localUserClient(userId: string, email?: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  assertLocalUrl(url);
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const token = mintLocalAccessToken(userId, { email });
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client with NO Authorization override at all beyond the anon key itself — mirrors an unauthenticated visitor. */
export function localAnonClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  assertLocalUrl(url);
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Service-role client — bypasses RLS entirely. Test fixture setup/teardown ONLY, never for assertions about what an authenticated user can see. */
export function localServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  assertLocalUrl(url);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
