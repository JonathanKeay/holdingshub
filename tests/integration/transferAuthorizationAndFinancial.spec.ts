// tests/integration/transferAuthorizationAndFinancial.spec.ts
//
// DEV-ONLY integration coverage for the transfer financial-correctness fix
// (see the transfer financial-correctness investigation). Unlike every
// other tests/financial/*.spec.ts file, these tests hit the REAL local
// Supabase stack (RLS, grants, PostgREST) through real
// @supabase/supabase-js clients — the same network-level path the
// dashboard/mobile app and the CSV import route actually use — rather than
// calling pure functions with in-memory fixtures. That distinction matters:
// the underlying arithmetic was already thoroughly unit-tested before this
// fix; what was NEVER tested was whether an authenticated user could
// actually read the data that arithmetic depends on. See
// tests/integration/helpers/localSupabaseAuth.ts for how a real
// authenticated session is simulated without touching the real user's
// password or PROD.
//
// Fixtures: the PLTR/PYPL/POLB.L regression checks use the 3 real `matched`
// transfers already present in DEV (created before this investigation) —
// deliberately not fabricated data, so the test proves the fix against the
// exact data the bug was found against. The ownership/cross-user tests use
// a temporary second auth user plus a handful of temporary portfolios/
// assets/transactions, all created in beforeAll and deleted in afterAll —
// nothing here is left behind, and nothing here touches PROD.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPortfoliosWithHoldingsAndCash, getAllHoldingsAndCashSummary } from '../../src/lib/queries';
import { processImportedTransfers, type InsertedTxnForTransfer } from '../../src/lib/transferImportIntegration';
import { localUserClient, localServiceClient } from './helpers/localSupabaseAuth';

const OWNER_USER_ID = 'b6902c68-69ce-4af7-af55-99322b5d1e38';
const OWNER_EMAIL = 'jonathankeay@outlook.com';
const DEST_PORTFOLIO_ID = 'd260fd41-f885-47a2-836d-ebc94654d85c'; // IBKR ISA STK — holds the 3 real matched transfers' IN legs

const PLTR_TICKER = 'PLTR';
const PYPL_TICKER = 'PYPL';
const POLB_TICKER = 'POLB.L';

const svc = localServiceClient();
const owner = localUserClient(OWNER_USER_ID, OWNER_EMAIL);

let REAL_MATCHED_TRANSFER_IDS: string[] = [];
let REAL_RESOLVED_BY_TICKER: Record<string, { nativeCost: number; nativeCcy: string; baseCost: number | null; baseCcy: string | null }> = {};

let tempUserId = '';
let tempOwnerPortfolioId = '';
let tempOwnerPortfolio2Id = '';
let tempUserPortfolioId = '';
let tempAssetIds: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' };

async function insertTxn(row: {
  portfolio_id: string;
  asset_id: string;
  type: string;
  quantity: number;
  date: string;
  price?: number;
}): Promise<InsertedTxnForTransfer> {
  const { data, error } = await svc
    .from('transactions')
    .insert({ portfolio_id: row.portfolio_id, asset_id: row.asset_id, type: row.type, quantity: row.quantity, date: row.date, price: row.price ?? 0 })
    .select('id, portfolio_id, asset_id, type, quantity, date')
    .single();
  if (error) throw error;
  return data as InsertedTxnForTransfer;
}

beforeAll(async () => {
  // ---- Real-data fixtures (read-only) ----
  const { data: transfers, error: tErr } = await svc
    .from('transfers')
    .select('id, asset_id, native_cost, native_ccy, base_cost, base_ccy')
    .eq('status', 'matched');
  if (tErr) throw tErr;
  REAL_MATCHED_TRANSFER_IDS = (transfers ?? []).map((t: any) => t.id);

  const assetIds = (transfers ?? []).map((t: any) => t.asset_id);
  const { data: assetRows, error: aErr } = await svc.from('assets').select('id, ticker').in('id', assetIds);
  if (aErr) throw aErr;
  const tickerByAssetId = new Map((assetRows ?? []).map((a: any) => [a.id, a.ticker]));

  for (const t of transfers ?? []) {
    const ticker = tickerByAssetId.get((t as any).asset_id) as string;
    REAL_RESOLVED_BY_TICKER[ticker] = {
      nativeCost: Number((t as any).native_cost),
      nativeCcy: (t as any).native_ccy,
      baseCost: (t as any).base_cost == null ? null : Number((t as any).base_cost),
      baseCcy: (t as any).base_ccy,
    };
  }
  expect(REAL_RESOLVED_BY_TICKER[PLTR_TICKER], 'expected the real matched PLTR transfer to exist in DEV').toBeTruthy();
  expect(REAL_RESOLVED_BY_TICKER[PYPL_TICKER], 'expected the real matched PYPL transfer to exist in DEV').toBeTruthy();
  expect(REAL_RESOLVED_BY_TICKER[POLB_TICKER], 'expected the real matched POLB.L transfer to exist in DEV').toBeTruthy();

  // ---- Temporary second user + fully isolated temp fixtures ----
  const { data: created, error: createErr } = await svc.auth.admin.createUser({
    email: `transfer-audit-temp-${Date.now()}@example.invalid`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (createErr || !created?.user) throw new Error(`failed to create temp DEV-only test user: ${createErr?.message}`);
  tempUserId = created.user.id;

  const mkPortfolio = async (userId: string, name: string) => {
    const { data, error } = await svc.from('portfolios').insert({ name, base_currency: 'GBP', user_id: userId }).select('id').single();
    if (error) throw error;
    return (data as any).id as string;
  };
  tempOwnerPortfolioId = await mkPortfolio(OWNER_USER_ID, 'ZZ AUDIT temp (owner A)');
  tempOwnerPortfolio2Id = await mkPortfolio(OWNER_USER_ID, 'ZZ AUDIT temp (owner B)');
  tempUserPortfolioId = await mkPortfolio(tempUserId, 'ZZ AUDIT temp (other user)');

  const mkAsset = async (ticker: string) => {
    const { data, error } = await svc.from('assets').insert({ ticker, name: `Transfer audit temp asset ${ticker}`, currency: 'GBP', status: 'active' }).select('id').single();
    if (error) throw error;
    return (data as any).id as string;
  };
  tempAssetIds = {
    A: await mkAsset('ZZAUDIT1'),
    B: await mkAsset('ZZAUDIT2'),
    C: await mkAsset('ZZAUDIT3'),
    D: await mkAsset('ZZAUDIT4'),
  };
});

afterAll(async () => {
  const portfolioIds = [tempOwnerPortfolioId, tempOwnerPortfolio2Id, tempUserPortfolioId].filter(Boolean);
  if (portfolioIds.length) {
    const { data: txns } = await svc.from('transactions').select('id').in('portfolio_id', portfolioIds);
    const txnIds = (txns ?? []).map((t: any) => t.id);
    if (txnIds.length) {
      const list = txnIds.join(',');
      await svc.from('transfers').delete().or(`out_transaction_id.in.(${list}),in_transaction_id.in.(${list})`);
      await svc.from('transactions').delete().in('id', txnIds);
    }
    await svc.from('portfolios').delete().in('id', portfolioIds);
  }
  const assetIds = Object.values(tempAssetIds).filter(Boolean);
  if (assetIds.length) {
    await svc.from('assets').delete().in('id', assetIds);
  }
  if (tempUserId) {
    await svc.auth.admin.deleteUser(tempUserId);
  }
});

// ---------------------------------------------------------------------
// 1. Authenticated transfer visibility (RLS)
// ---------------------------------------------------------------------
describe('1. authenticated transfer visibility', () => {
  it('the owning user can read their own real matched transfers', async () => {
    const { data, error } = await owner.from('transfers').select('id, status').in('id', REAL_MATCHED_TRANSFER_IDS);
    expect(error).toBeNull();
    expect((data ?? []).map((r: any) => r.id).sort()).toEqual([...REAL_MATCHED_TRANSFER_IDS].sort());
  });

  it('an unrelated authenticated user cannot read the owner\'s transfers', async () => {
    const stranger = localUserClient(tempUserId);
    const { data, error } = await stranger.from('transfers').select('id, status').in('id', REAL_MATCHED_TRANSFER_IDS);
    expect(error).toBeNull(); // RLS filters rows silently for SELECT — empty result, not an error
    expect(data ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 2. Real dashboard query path resolves transferred cost
// ---------------------------------------------------------------------
describe('2. real dashboard query path (getPortfoliosWithHoldingsAndCash / getAllHoldingsAndCashSummary) resolves transferred cost', () => {
  // PLTR and PYPL were both later fully sold down to zero shares and
  // reopened with fresh, unrelated purchases in this portfolio (confirmed
  // against real DEV data: PLTR closed completely on 2025-06-27 before
  // reopening; PYPL closed completely on 2026-07-17). applyTransactionToHolding
  // resets total_cost/avg_price to exactly zero whenever a holding fully
  // closes — by design, so a reopened position starts a clean cost basis —
  // which means TODAY's total_cost for these two tickers no longer reflects
  // the TIN-time cost at all, resolved or legacy. What DOES survive a full
  // close is the cumulative realised_cost/realised_value the closing SELL
  // banked, which is exactly where the resolved-vs-legacy difference shows
  // up for these two. POLB.L, by contrast, was never reduced after its TIN
  // (still holds all 48,337 shares), so its total_cost IS still a direct,
  // present-day read of the resolved-vs-legacy difference.
  it('per-portfolio: PLTR and PYPL cumulative realised P&L reflects the resolved transferred cost, not the legacy figure', async () => {
    const resolved = await getPortfoliosWithHoldingsAndCash(owner);
    const legacy = await getPortfoliosWithHoldingsAndCash(withTransfersOverride(owner, 'genuinely-empty'));
    const resolvedDest = resolved.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!;
    const legacyDest = legacy.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!;

    for (const ticker of [PLTR_TICKER, PYPL_TICKER]) {
      const resolvedHolding = resolvedDest.holdings.find((h) => h.ticker === ticker);
      const legacyHolding = legacyDest.holdings.find((h) => h.ticker === ticker);
      expect(resolvedHolding, `${ticker} holding missing (resolved run)`).toBeTruthy();
      expect(legacyHolding, `${ticker} holding missing (legacy run)`).toBeTruthy();

      const costDelta = (resolvedHolding!.realised_cost ?? 0) - (legacyHolding!.realised_cost ?? 0);
      // A higher resolved native cost than the legacy figure (PYPL:
      // 17,505.20 resolved vs 9,840.20 legacy) means MORE cost is banked
      // into realised_cost once those shares are sold — costDelta > 0. A
      // lower resolved cost (PLTR: 39,359.47 resolved vs 77,092.30 legacy)
      // means LESS cost is banked — costDelta < 0.
      const expectedSign = REAL_RESOLVED_BY_TICKER[ticker].nativeCost > (ticker === PLTR_TICKER ? 77092.3 : 9840.2) ? 1 : -1;
      expect(Math.sign(costDelta), `${ticker}: resolved=${resolvedHolding!.realised_cost}, legacy=${legacyHolding!.realised_cost}`).toBe(expectedSign);
      expect(Math.abs(costDelta)).toBeGreaterThan(1000); // both real cases differ by tens of thousands — never a rounding-noise-sized gap
    }
  });

  it('per-portfolio: POLB.L preserves the deliberate £0 HoldingsHub cost basis (still open — total_cost is a direct present-day read)', async () => {
    const perPortfolio = await getPortfoliosWithHoldingsAndCash(owner);
    const dest = perPortfolio.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID);
    const polb = dest!.holdings.find((h) => h.ticker === POLB_TICKER);
    expect(polb).toBeTruthy();
    expect(polb!.total_cost).toBe(0);
    expect(polb!.avg_price).toBe(0);
  });

  it('Global blended total_cost agrees with the per-portfolio view for PLTR/PYPL/POLB.L (every OTHER portfolio holding these tickers is fully closed today, so blending adds no extra open cost)', async () => {
    const perPortfolio = await getPortfoliosWithHoldingsAndCash(owner);
    const dest = perPortfolio.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!;
    const global = await getAllHoldingsAndCashSummary(owner);
    for (const ticker of [PLTR_TICKER, PYPL_TICKER, POLB_TICKER]) {
      const perPortfolioHolding = dest.holdings.find((h) => h.ticker === ticker);
      const globalHolding = global.holdings.find((h) => h.ticker === ticker);
      expect(globalHolding, `${ticker} holding missing globally`).toBeTruthy();
      expect(globalHolding!.total_cost).toBeCloseTo(perPortfolioHolding!.total_cost, 6);
    }
    const polbGlobal = global.holdings.find((h) => h.ticker === POLB_TICKER);
    expect(polbGlobal!.total_cost).toBe(0);
  });

  it('Global blended view independently resolves the same transferred cost for PLTR/PYPL (not just inherited from the per-portfolio view)', async () => {
    // Global blends in genuinely unrelated 2021 PLTR/PYPL activity from
    // OTHER portfolios too, so its cumulative realised_cost is not expected
    // to equal the single-portfolio figure — but it must independently show
    // the same resolved-vs-legacy DIRECTION, proving getAllHoldingsAndCashSummary
    // resolves the transfer on its own, not merely because
    // getPortfoliosWithHoldingsAndCash happened to.
    const resolvedGlobal = await getAllHoldingsAndCashSummary(owner);
    const legacyGlobal = await getAllHoldingsAndCashSummary(withTransfersOverride(owner, 'genuinely-empty'));

    for (const ticker of [PLTR_TICKER, PYPL_TICKER]) {
      const resolvedHolding = resolvedGlobal.holdings.find((h) => h.ticker === ticker)!;
      const legacyHolding = legacyGlobal.holdings.find((h) => h.ticker === ticker)!;
      const costDelta = (resolvedHolding.realised_cost ?? 0) - (legacyHolding.realised_cost ?? 0);
      const expectedSign = REAL_RESOLVED_BY_TICKER[ticker].nativeCost > (ticker === PLTR_TICKER ? 77092.3 : 9840.2) ? 1 : -1;
      expect(Math.sign(costDelta)).toBe(expectedSign);
      expect(Math.abs(costDelta)).toBeGreaterThan(1000);
    }
  });

  it('POLB.L base_cost_reliable is corrected: true in BOTH per-portfolio and Global views (previously true/false)', async () => {
    const perPortfolio = await getPortfoliosWithHoldingsAndCash(owner);
    const dest = perPortfolio.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID);
    const polbPerPortfolio = dest!.holdings.find((h) => h.ticker === POLB_TICKER);
    expect(polbPerPortfolio!.base_cost_reliable).toBe(true);

    const global = await getAllHoldingsAndCashSummary(owner);
    const polbGlobal = global.holdings.find((h) => h.ticker === POLB_TICKER);
    expect(polbGlobal!.base_cost_reliable).toBe(true);
  });
});

// ---------------------------------------------------------------------
// 3. Unmatched TIN/TOT remains safe
// ---------------------------------------------------------------------
describe('3. an unmatched (pending) transfer does not break replay and correctly still uses legacy cost for that row only', () => {
  it('a pending_out transfer with no match falls back to ordinary proportional TOT cost, and unrelated real holdings are unaffected', async () => {
    // Baseline, captured BEFORE the temp pending transfer exists.
    const before = await getPortfoliosWithHoldingsAndCash(owner);
    const pltrBefore = before.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!.holdings.find((h) => h.ticker === PLTR_TICKER)!;
    const polbBefore = before.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!.holdings.find((h) => h.ticker === POLB_TICKER)!;

    const buy = await insertTxn({ portfolio_id: tempOwnerPortfolioId, asset_id: tempAssetIds.C, type: 'BUY', quantity: 200, date: '2025-04-01', price: 5 });
    const tot = await insertTxn({ portfolio_id: tempOwnerPortfolioId, asset_id: tempAssetIds.C, type: 'TOT', quantity: 80, date: '2025-04-02' });

    // Create the pending_out transfer via the real import-integration path
    // (service-role, exactly as the CSV import route would).
    const res = await processImportedTransfers(svc, [tot], { [tempAssetIds.C]: 'ZZAUDIT3' }, OWNER_USER_ID);
    expect(res.errors).toEqual([]);
    expect(res.created.length).toBe(1);
    expect(res.created[0].status).toBe('pending_out');

    const perPortfolio = await getPortfoliosWithHoldingsAndCash(owner);
    const tempPortfolio = perPortfolio.find((p) => p.portfolio.id === tempOwnerPortfolioId);
    const holding = tempPortfolio!.holdings.find((h) => h.ticker === 'ZZAUDIT3');
    expect(holding).toBeTruthy();
    // 200 sh @ £5 = £1000; TOT removes 80/200 = 40% => £400 removed, legacy math (unchanged by the fix, since only matched/external_* are resolved).
    expect(holding!.total_shares).toBeCloseTo(120, 6);
    expect(holding!.total_cost).toBeCloseTo(600, 2);

    // Unrelated real holdings in the SAME call are byte-for-byte unaffected
    // by the presence of a pending, unmatched transfer elsewhere — compared
    // against the pre-existing baseline rather than a hand-derived number,
    // since PLTR's own history is complex (see Group 2's comment).
    const dest = perPortfolio.find((p) => p.portfolio.id === DEST_PORTFOLIO_ID)!;
    const pltrAfter = dest.holdings.find((h) => h.ticker === PLTR_TICKER)!;
    const polbAfter = dest.holdings.find((h) => h.ticker === POLB_TICKER)!;
    expect(pltrAfter.total_cost).toBeCloseTo(pltrBefore.total_cost, 6);
    expect(pltrAfter.realised_cost ?? 0).toBeCloseTo(pltrBefore.realised_cost ?? 0, 6);
    expect(polbAfter.total_cost).toBe(polbBefore.total_cost);
  });
});

// ---------------------------------------------------------------------
// 4. Transfer-matching ownership scoping
// ---------------------------------------------------------------------
describe('4. transfer-matching candidate discovery is scoped to the importing user\'s own portfolios', () => {
  it('a structurally-matching pending transfer belonging to ANOTHER user is never suggested (direction: owner first, other user imports second)', async () => {
    const ownerTot = await insertTxn({ portfolio_id: tempOwnerPortfolioId, asset_id: tempAssetIds.A, type: 'TOT', quantity: 30, date: '2025-02-01' });
    const ownerResult = await processImportedTransfers(svc, [ownerTot], { [tempAssetIds.A]: 'ZZAUDIT1' }, OWNER_USER_ID);
    expect(ownerResult.errors).toEqual([]);
    expect(ownerResult.created[0].status).toBe('pending_out');

    const otherTin = await insertTxn({ portfolio_id: tempUserPortfolioId, asset_id: tempAssetIds.A, type: 'TIN', quantity: 30, date: '2025-02-01' });
    const otherResult = await processImportedTransfers(svc, [otherTin], { [tempAssetIds.A]: 'ZZAUDIT1' }, tempUserId);
    expect(otherResult.errors).toEqual([]);

    // The owner's pending_out structurally matches perfectly (same asset,
    // same quantity, same date, different portfolio) — under the pre-fix
    // logic this would appear as a high-confidence suggestion. It must not.
    const allSuggestions = Object.values(otherResult.suggestions).flat();
    expect(allSuggestions).toEqual([]);
  });

  it('a structurally-matching pending transfer belonging to ANOTHER user is never suggested (direction: other user first, owner imports second)', async () => {
    const otherTot = await insertTxn({ portfolio_id: tempUserPortfolioId, asset_id: tempAssetIds.B, type: 'TOT', quantity: 45, date: '2025-02-15' });
    const otherResult = await processImportedTransfers(svc, [otherTot], { [tempAssetIds.B]: 'ZZAUDIT2' }, tempUserId);
    expect(otherResult.errors).toEqual([]);
    expect(otherResult.created[0].status).toBe('pending_out');

    const ownerTin = await insertTxn({ portfolio_id: tempOwnerPortfolioId, asset_id: tempAssetIds.B, type: 'TIN', quantity: 45, date: '2025-02-15' });
    const ownerResult = await processImportedTransfers(svc, [ownerTin], { [tempAssetIds.B]: 'ZZAUDIT2' }, OWNER_USER_ID);
    expect(ownerResult.errors).toEqual([]);

    const allSuggestions = Object.values(ownerResult.suggestions).flat();
    expect(allSuggestions).toEqual([]);
  });

  it('positive control: a structurally-matching pending transfer belonging to the SAME user (different portfolio) IS still suggested', async () => {
    const ownerTot = await insertTxn({ portfolio_id: tempOwnerPortfolioId, asset_id: tempAssetIds.D, type: 'TOT', quantity: 15, date: '2025-03-01' });
    const outResult = await processImportedTransfers(svc, [ownerTot], { [tempAssetIds.D]: 'ZZAUDIT4' }, OWNER_USER_ID);
    expect(outResult.errors).toEqual([]);

    const ownerTin = await insertTxn({ portfolio_id: tempOwnerPortfolio2Id, asset_id: tempAssetIds.D, type: 'TIN', quantity: 15, date: '2025-03-01' });
    const inResult = await processImportedTransfers(svc, [ownerTin], { [tempAssetIds.D]: 'ZZAUDIT4' }, OWNER_USER_ID);
    expect(inResult.errors).toEqual([]);

    const suggestionEntries = Object.values(inResult.suggestions).flat();
    expect(suggestionEntries.length).toBe(1);
    expect(suggestionEntries[0].transactionId).toBe(ownerTot.id);
    expect(suggestionEntries[0].confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------
// 5. A failed/unauthorised transfers read is never silently treated as "no transfers"
// ---------------------------------------------------------------------
function withTransfersOverride(base: any, mode: 'permission-denied' | 'genuinely-empty') {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => {
          if (table === 'transfers') {
            return {
              select: () => ({
                in: async () =>
                  mode === 'permission-denied'
                    ? { data: null, error: { message: 'permission denied for table transfers', code: '42501' } }
                    : { data: [], error: null },
              }),
            };
          }
          return target.from(table);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('5. transfers read failure is never silently treated as "no transfers exist"', () => {
  it('a genuine permission-denied error throws rather than silently computing with an empty transfer set', async () => {
    const broken = withTransfersOverride(owner, 'permission-denied');
    await expect(getPortfoliosWithHoldingsAndCash(broken)).rejects.toThrow(/transfers/i);
    await expect(getAllHoldingsAndCashSummary(broken)).rejects.toThrow(/transfers/i);
  });

  it('reproduces the PRE-FIX numbers for comparison: with the real error swapped for a bare empty result (no error), legacy cost is used — this is what every real user silently got before this fix', async () => {
    const emptyNoError = withTransfersOverride(owner, 'genuinely-empty');
    const legacyResult = await getPortfoliosWithHoldingsAndCash(emptyNoError);
    const resolvedResult = await getPortfoliosWithHoldingsAndCash(owner);
    const legacyDest = legacyResult.find((p: any) => p.portfolio.id === DEST_PORTFOLIO_ID)!;
    const resolvedDest = resolvedResult.find((p: any) => p.portfolio.id === DEST_PORTFOLIO_ID)!;

    // POLB.L is still open (never reduced after its TIN), so total_cost is a
    // direct, present-day comparison: exactly today's £0 vs £1,547.78.
    const polbLegacy = legacyDest.holdings.find((h: any) => h.ticker === POLB_TICKER)!;
    const polbResolved = resolvedDest.holdings.find((h: any) => h.ticker === POLB_TICKER)!;
    expect(polbResolved.total_cost).toBe(0);
    expect(polbLegacy.total_cost).toBeCloseTo(1547.78, 1);

    // PLTR/PYPL were both later fully closed and reopened (see Group 2's
    // comment) — the resolved-vs-legacy difference shows up in cumulative
    // realised_cost, not present-day total_cost.
    for (const ticker of [PLTR_TICKER, PYPL_TICKER]) {
      const legacyHolding = legacyDest.holdings.find((h: any) => h.ticker === ticker)!;
      const resolvedHolding = resolvedDest.holdings.find((h: any) => h.ticker === ticker)!;
      expect(Math.abs((resolvedHolding.realised_cost ?? 0) - (legacyHolding.realised_cost ?? 0))).toBeGreaterThan(1000);
    }
  });
});
