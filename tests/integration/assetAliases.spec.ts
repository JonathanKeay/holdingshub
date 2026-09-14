// tests/integration/assetAliases.spec.ts
//
// DEV-ONLY integration coverage for the asset_aliases table added in
// supabase/migrations/20260914160000_create_asset_aliases.sql (importer
// stabilisation, item 2 — canonical asset alias resolution). Like
// transferAuthorizationAndFinancial.spec.ts, this hits the REAL local
// Supabase stack (RLS, grants, PostgREST) rather than an in-memory mock —
// the two things that matter here (can an authenticated user corrupt a
// shared alias mapping through normal use, and does the database actually
// stop one alias from mapping to two assets) are guarantees the database
// itself provides, not something a pure-function test can prove.
//
// Fixtures: two temporary throwaway assets (clearly-fake tickers, never
// matching anything in real DEV data) are created in beforeAll and deleted
// — along with every alias row this file creates — in afterAll. Nothing
// here is left behind, and nothing here touches PROD.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localUserClient, localServiceClient } from './helpers/localSupabaseAuth';

const OWNER_USER_ID = 'b6902c68-69ce-4af7-af55-99322b5d1e38';
const OWNER_EMAIL = 'jonathankeay@outlook.com';

const svc = localServiceClient();
const owner = localUserClient(OWNER_USER_ID, OWNER_EMAIL);

const TICKER_A = `ZZTESTALIASA${randomUUID().slice(0, 6).toUpperCase()}`;
const TICKER_B = `ZZTESTALIASB${randomUUID().slice(0, 6).toUpperCase()}`;

let assetAId = '';
let assetBId = '';
const createdAliasIds: string[] = [];

beforeAll(async () => {
  const { data: a, error: aErr } = await svc
    .from('assets')
    .insert({ ticker: TICKER_A, name: 'Test Asset A', currency: 'USD' })
    .select('id')
    .single();
  if (aErr) throw aErr;
  assetAId = a.id;

  const { data: b, error: bErr } = await svc
    .from('assets')
    .insert({ ticker: TICKER_B, name: 'Test Asset B', currency: 'USD' })
    .select('id')
    .single();
  if (bErr) throw bErr;
  assetBId = b.id;
});

afterAll(async () => {
  if (createdAliasIds.length > 0) {
    await svc.from('asset_aliases').delete().in('id', createdAliasIds);
  }
  // Any alias still pointing at these test assets (e.g. one that failed to
  // record its id due to a test failure) is caught by ON DELETE CASCADE on
  // asset_aliases.asset_id when the assets themselves are deleted.
  await svc.from('assets').delete().in('id', [assetAId, assetBId].filter(Boolean));
});

describe('asset_aliases — shared reference data, security model', () => {
  it('an authenticated user can read alias rows', async () => {
    const alias = `ZZREADTEST${randomUUID().slice(0, 6).toUpperCase()}`;
    const { data: inserted, error: insErr } = await svc
      .from('asset_aliases')
      .insert({ alias, asset_id: assetAId })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    createdAliasIds.push(inserted!.id);

    const { data, error } = await owner.from('asset_aliases').select('id, alias').eq('alias', alias);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].alias).toBe(alias);
  });

  it('an authenticated user cannot write directly to asset_aliases (no INSERT grant)', async () => {
    const alias = `ZZWRITETEST${randomUUID().slice(0, 6).toUpperCase()}`;
    const { error } = await owner.from('asset_aliases').insert({ alias, asset_id: assetAId });
    expect(error).not.toBeNull();
    // Cleanup only if it somehow succeeded (it must not).
    if (!error) {
      const { data } = await svc.from('asset_aliases').select('id').eq('alias', alias).maybeSingle();
      if (data?.id) createdAliasIds.push(data.id);
    }
  });

  it('an authenticated user cannot delete an existing alias directly (no DELETE grant)', async () => {
    const alias = `ZZDELTEST${randomUUID().slice(0, 6).toUpperCase()}`;
    const { data: inserted, error: insErr } = await svc
      .from('asset_aliases')
      .insert({ alias, asset_id: assetAId })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    createdAliasIds.push(inserted!.id);

    const { error } = await owner.from('asset_aliases').delete({ count: 'exact' }).eq('id', inserted!.id);
    // authenticated has no grant on this table at all (not even filtered by
    // RLS) — Postgres denies the statement outright, same shape as the
    // INSERT denial above.
    expect(error).not.toBeNull();

    const { data: stillThere } = await svc.from('asset_aliases').select('id').eq('id', inserted!.id).maybeSingle();
    expect(stillThere?.id).toBe(inserted!.id);
  });
});

describe('asset_aliases — uniqueness (one alias cannot map to two assets)', () => {
  it('the same alias string cannot be inserted for a second, different asset', async () => {
    const alias = `ZZDUPTEST${randomUUID().slice(0, 6).toUpperCase()}`;
    const { data: first, error: firstErr } = await svc
      .from('asset_aliases')
      .insert({ alias, asset_id: assetAId })
      .select('id')
      .single();
    expect(firstErr).toBeNull();
    createdAliasIds.push(first!.id);

    const { error: secondErr } = await svc.from('asset_aliases').insert({ alias, asset_id: assetBId });
    expect(secondErr).not.toBeNull();
    expect((secondErr as { code?: string } | null)?.code).toBe('23505'); // unique_violation
  });

  it('multiple different aliases may safely map to the same asset', async () => {
    const aliasX = `ZZMULTIX${randomUUID().slice(0, 6).toUpperCase()}`;
    const aliasY = `ZZMULTIY${randomUUID().slice(0, 6).toUpperCase()}`;

    const { data: x, error: xErr } = await svc.from('asset_aliases').insert({ alias: aliasX, asset_id: assetAId }).select('id').single();
    expect(xErr).toBeNull();
    createdAliasIds.push(x!.id);

    const { data: y, error: yErr } = await svc.from('asset_aliases').insert({ alias: aliasY, asset_id: assetAId }).select('id').single();
    expect(yErr).toBeNull();
    createdAliasIds.push(y!.id);

    const { data } = await svc.from('asset_aliases').select('alias').eq('asset_id', assetAId).in('alias', [aliasX, aliasY]);
    expect((data ?? []).map((r) => r.alias).sort()).toEqual([aliasX, aliasY].sort());
  });

  it('rejects a non-uppercase alias (storage must already be normalized)', async () => {
    const alias = `zzlowertest${randomUUID().slice(0, 6)}`;
    const { error } = await svc.from('asset_aliases').insert({ alias, asset_id: assetAId });
    expect(error).not.toBeNull();
  });
});
