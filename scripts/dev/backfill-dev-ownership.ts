// DEV-ONLY: backfill portfolio/settings ownership for the local HoldingsHub
// dev environment. This is NOT a Supabase migration and is never picked up
// by `supabase migration up` / `db push` / `db reset` — it lives outside
// supabase/migrations/ specifically so it can never be mistaken for, or
// accidentally applied as, a generic structural migration.
//
// It runs between the "structure" and "finalize" migrations in
// supabase/migrations/ (which add the user_id columns and, respectively,
// make them NOT NULL / re-key settings' primary key). Those two migration
// files contain no environment-specific values at all — this script is the
// only place a DEV-specific value is ever used, and even here it is never
// hardcoded: the target user's id is looked up by email at run time.
//
// SAFETY GUARDS (all must pass, or the script aborts and changes nothing):
//   1. ENVIRONMENT must be exactly 'development' (matches the existing
//      .env.local convention: "set to 'production' only in prod to allow
//      service-role scripts").
//   2. The Supabase URL must not look like a hosted Supabase project
//      (must not contain '.supabase.co') — a purely technical check that
//      does not depend on any env var being set correctly.
//   3. Exactly one auth user must exist for the target email — zero or
//      more than one aborts rather than guessing.
//
// Idempotent: only touches rows where user_id IS NULL, so re-running it
// after it has already succeeded is a safe no-op.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/dev/backfill-dev-ownership.ts

import { createClient } from '@supabase/supabase-js';

const TARGET_EMAIL = 'jonathankeay@outlook.com';

function fail(message: string): never {
  console.error(`ABORTED: ${message}`);
  process.exit(1);
}

async function main() {
  if (process.env.ENVIRONMENT !== 'development') {
    fail(
      `ENVIRONMENT is '${process.env.ENVIRONMENT ?? '(unset)'}', not 'development'. ` +
        `This script must never run against anything but a local DEV environment.`
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    fail('Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  if (url.includes('.supabase.co')) {
    fail(
      `Supabase URL '${url}' looks like a hosted project, not a local one. ` +
        `Refusing to run — this script is DEV-only.`
    );
  }

  const admin = createClient(url, serviceKey);

  // Resolve the target user by email — never a hardcoded UUID. Paginate
  // defensively even though a local dev project only ever has a handful of
  // users.
  const matches: { id: string; email: string | undefined }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers failed: ${error.message}`);
    for (const u of data.users) {
      if ((u.email ?? '').toLowerCase() === TARGET_EMAIL.toLowerCase()) matches.push({ id: u.id, email: u.email });
    }
    if (data.users.length < 200) break;
  }

  if (matches.length === 0) fail(`No auth user found for ${TARGET_EMAIL} — nothing to backfill.`);
  if (matches.length > 1) fail(`${matches.length} auth users found for ${TARGET_EMAIL} — refusing to guess which one owns existing data.`);

  const userId = matches[0].id;
  console.log(`Resolved ${TARGET_EMAIL} -> ${userId} (looked up by email, not hardcoded).`);

  const portfoliosRes = await admin
    .from('portfolios')
    .update({ user_id: userId })
    .is('user_id', null)
    .select('id');
  if (portfoliosRes.error) fail(`portfolios backfill failed: ${portfoliosRes.error.message}`);
  console.log(`portfolios: backfilled ${portfoliosRes.data?.length ?? 0} row(s) that had no user_id.`);

  const settingsRes = await admin
    .from('settings')
    .update({ user_id: userId })
    .is('user_id', null)
    .select();
  if (settingsRes.error) fail(`settings backfill failed: ${settingsRes.error.message}`);
  console.log(`settings: backfilled ${settingsRes.data?.length ?? 0} row(s) that had no user_id.`);

  const { count: remainingPortfolios } = await admin
    .from('portfolios')
    .select('id', { count: 'exact', head: true })
    .is('user_id', null);
  const { count: remainingSettings } = await admin
    .from('settings')
    .select('*', { count: 'exact', head: true })
    .is('user_id', null);

  console.log(`Remaining NULL user_id — portfolios: ${remainingPortfolios ?? 0}, settings: ${remainingSettings ?? 0}.`);
  if ((remainingPortfolios ?? 0) > 0 || (remainingSettings ?? 0) > 0) {
    fail('Some rows still have no user_id after backfill — investigate before running the finalize migrations.');
  }

  console.log('Done. Safe to apply the *_finalize migrations now.');
}

main().catch((err) => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
