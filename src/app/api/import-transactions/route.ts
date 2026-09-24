// app/api/import/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import { resolveRowCashLeg, shouldApplyCashLegGate, resolveUngatedCashValue, CASH_LEG_TRANSACTION_TYPES } from '@/lib/cashLeg';
import { findUnresolvedTickerRows } from '@/lib/unresolvedTickers';
import { indexPortfoliosByName, matchPortfolioByName } from '@/lib/portfolioNameMatch';
import { splitTickersForLookup } from '@/lib/newTickerLookupCap';
import {
  filterTickersNeedingCreation,
  type ManualTickerMetadata,
  type ResolvedNewAssetMeta,
} from '@/lib/manualAssetMetadata';
import { resolveImportTicker, type ImportAsset, type ImportAssetAlias } from '@/lib/assetResolution';
import { resolveImportReferenceData } from '@/lib/importReferenceData';
import { processImportedTransfers, isCashTicker } from '@/lib/transferImportIntegration';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { resolveConfirmTickerMeta } from '@/lib/confirmTickerMetaResolution';
import { enrichNewAssetDomain } from '@/lib/newAssetDomainEnrichment';
import { fetchCompanyWeburlFromFinnhub } from '@/lib/logo';

// Best-effort corporate-domain discovery for a brand-new asset (see the
// insert loop below and src/lib/newAssetDomainEnrichment.ts). Applied
// per-ticker in parallel (via Promise.all) rather than summed, so this is
// the most Confirm & Import is ever slowed by domain discovery, regardless
// of how many new tickers are in one import — never fails it either way.
//
// 1200ms, not PER_LOOKUP_TIMEOUT_MS's 3000ms: measured real Finnhub
// stock/profile2 round trips (2026-09-14, from this LXC) at ~100-230ms
// whether a company profile was found or not — a genuinely unresponsive
// provider is the only realistic way this cap is ever hit, and a financial
// import confirming should not visibly pause for 3s over an optional,
// non-financial enrichment step. 1200ms keeps ~5-10x headroom over observed
// real-world latency while bounding the rare worst case much tighter.
const DOMAIN_DISCOVERY_TIMEOUT_MS = 1200;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Utilities ----------
function safe<T>(v: T): T {
  // Ensure only JSON-serializable data is returned
  return JSON.parse(JSON.stringify(v));
}

// Limit long external calls (Yahoo) to avoid hanging previews
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// resolveRowCashLeg / shouldApplyCashLegGate live in src/lib/cashLeg.ts —
// shared with any other call site that needs the same FX-safe cash-leg
// resolution (see that file for the type-by-type rationale).

// dynamic import of yahoo-finance2 so module load failures don't crash the route
async function fetchTickerMeta(inputTicker: string) {
  const mod = await import('yahoo-finance2').catch(() => null);
  const yahoo = (mod?.default ?? mod) as any | null;

  let ticker = inputTicker;
  let name: string | null = null;
  let currency: string | null = null;
  let price_multiplier = 1;

  if (yahoo) {
    try {
      const q = await yahoo.quoteSummary(ticker, { modules: ['price'] });
      name = q.price?.shortName || null;
      currency = q.price?.currency || null;
      if (currency === 'GBp') {
        currency = 'GBP';
        price_multiplier = 0.01;
      }
    } catch {}

    if ((!name || !currency) && !ticker.endsWith('.L')) {
      try {
        const suffix = `${ticker}.L`;
        const q = await yahoo.quoteSummary(suffix, { modules: ['price'] });
        const sName = q.price?.shortName || null;
        const sCurrency = q.price?.currency || null;
        if (sCurrency === 'GBp') {
          currency = 'GBP';
          price_multiplier = 0.01;
        }
        if (sName && sCurrency) {
          ticker = suffix;
          name = sName;
          currency = currency || sCurrency;
        }
      } catch {}
    }
  }

  return { ticker, name, currency, price_multiplier };
}

// ---------- Canonicalization ----------
const VALID_INPUT_TYPES = [
  'buy', 'sell',
  'div', 'dividend',
  'int', 'interest',
  'dep', 'deposit',
  'with', 'withdrawal', 'wit',
  'fee',
  'otr', 'other',
  'tran', 'transfer', 'transfer_in', 'transfer_out', 'tin', 'tot',
  'spl', 'split',
  'fxm',
] as const;

type CanonicalType = 'BUY' | 'SELL' | 'DIV' | 'INT' | 'DEP' | 'WIT' | 'FEE' | 'OTR' | 'TIN' | 'TOT' | 'SPL' | 'FXM';

function canonicalizeType(raw: string): CanonicalType | 'TRANSFER_GENERIC' {
  const t = (raw || '').toString().trim().toLowerCase();
  if (t === 'buy') return 'BUY';
  if (t === 'sell') return 'SELL';
  if (t === 'div' || t === 'dividend') return 'DIV';
  if (t === 'int' || t === 'interest') return 'INT';
  if (t === 'dep' || t === 'deposit') return 'DEP';
  if (t === 'with' || t === 'withdrawal' || t === 'wit') return 'WIT';
  if (t === 'fee') return 'FEE';
  if (t === 'otr' || t === 'other') return 'OTR';
  if (t === 'tin' || t === 'transfer_in') return 'TIN';
  if (t === 'tot' || t === 'transfer_out') return 'TOT';
  if (t === 'spl' || t === 'split') return 'SPL';
  if (t === 'fxm') return 'FXM';
  if (t === 'tran' || t === 'transfer') return 'TRANSFER_GENERIC';
  return 'OTR';
}

// C17: user-facing reason for an SPL row whose ratio (CSV quantity) is <= 0.
const SPL_RATIO_REASON = 'Invalid split ratio: SPL quantity must be greater than 0.';

// ---------- CSV row schema ----------
const transactionSchema = z.object({
  portfolio: z.string().min(1)
    .refine((v) => (v || '').toString().trim().length >= 3, { message: 'portfolio must be at least 3 non-space characters' })
    .refine((v) => (v || '').toString().trim().length <= 100, { message: 'portfolio is too long' })
    .transform((v) => v.toString().trim()),
  ticker: z.string().min(1),
  transaction_type: z.string()
    .transform((val) => val.trim().toLowerCase())
    .refine((val) => VALID_INPUT_TYPES.includes(val as any), { message: 'Invalid transaction_type' }),
  date_time: z.string().transform((val, ctx) => {
    const dt = DateTime.fromISO(val, { zone: 'Europe/London' });
    if (!dt.isValid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid date_time: ${val}` });
      return z.NEVER;
    }
    return dt.toISODate(); // store YYYY-MM-DD
  }),
  quantity: z.coerce.number(),
  price: z.coerce.number(),
  fee: z.union([z.coerce.number(), z.literal('')]).transform((val) => (val === '' ? 0 : val)),
  // C15: blank means "not supplied" (null); an explicit 0 stays 0. The blank
  // check must come first: z.coerce.number() accepts '' and returns 0.
  fxrate: z.union([z.literal('').transform(() => null), z.coerce.number()]),
  // prefer cash_value header only (no fallback to settle_value)
  cash_value: z.union([z.literal('').transform(() => null), z.coerce.number()]),
  notes: z.string().optional(),
});

// ---------- Normalizers ----------
function normalizeTicker(input: string): string {
  return input?.toString().trim().replace(/^['"]+|['"]+$/g, '').toUpperCase();
}

function stripHidden(v: string) {
  return v.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').replace(/\u00A0/g, ' ');
}

function normalizeNameForLookup(v?: string) {
  if (!v) return '';
  return stripHidden(v)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------- Route handler ----------
export async function POST(req: NextRequest) {
  try {
    // This route writes with the service-role key, which bypasses RLS
    // entirely — so it must both require a session AND explicitly scope
    // every portfolio lookup below to that session's own user_id itself
    // (not rely on RLS to do it, since RLS has no effect on this client).
    const sessionClient = await getSupabaseServerClient();
    const {
      data: { session },
    } = await sessionClient.auth.getSession();
    if (!session) {
      return NextResponse.json(safe({ message: 'unauthorized' }), { status: 401 });
    }

    // Build Supabase server client with env guards
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(safe({ message: 'Server misconfigured: missing SUPABASE env vars' }), { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { searchParams } = new URL(req.url);
    const stage = searchParams.get('stage') ?? 'preview';

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(safe({ message: 'No file uploaded' }), { status: 400 });
    }

    const csvText = await file.text();

    // Parse CSV
    let records: any[] = [];
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      return NextResponse.json(safe({ message: 'Failed to parse CSV' }), { status: 400 });
    }

    // Header lookup helper (case/space-insensitive)
    function getField(row: Record<string, any>, name: string) {
      const key = Object.keys(row).find(k => (k || '').toString().trim().toLowerCase() === name);
      return key ? row[key] : undefined;
    }

    // Sanitize numeric input (strip currency symbols, commas, NBSP)
    function cleanNumberString(v: any) {
      if (v == null) return v;
      return v.toString().trim().replace(/[\u00A0\s,£$€¥]/g, '') || '';
    }

    // Fetch portfolios (uses base_currency), assets (include status if you want to block inactive),
    // and asset_aliases (broker/source symbol -> canonical asset, e.g.
    // "CAKE.US" -> the existing "CAKE" asset — see
    // supabase/migrations/20260914160000_create_asset_aliases.sql and
    // src/lib/assetResolution.ts for the resolution order this feeds).
    // Portfolios are explicitly scoped to the caller's own user_id — this
    // client is service-role and bypasses RLS, so without this filter a
    // CSV's portfolio-name matching below would search every user's
    // portfolios, letting one user's import land in another user's
    // portfolio by name-guessing. `assets` and `asset_aliases` are shared
    // reference data and are deliberately NOT scoped by user.
    const [portfoliosResult, assetsResult, assetAliasesResult] = await Promise.all([
      supabase.from('portfolios').select('id, name, base_currency, import_name').eq('user_id', session.user.id),
      // include resolved_ticker so we can match CSVs against both ticker and resolved_ticker
      supabase.from('assets').select('id, ticker, currency, status, resolved_ticker'),
      supabase.from('asset_aliases').select('alias, asset_id'),
    ]);

    // Fail closed: a failed reference-data fetch must NEVER be silently
    // downgraded to an empty result — see src/lib/importReferenceData.ts
    // for why (the CAKE.US intermittent-preview investigation). Abort the
    // whole request rather than partially proceeding with a default empty
    // array for whichever query failed.
    // portfolios' generic is deliberately left as `any` here, matching its
    // prior implicit typing: this file's existing portfoliosById fallback
    // (`|| { currency: null }`, below) already assumes a loosely-typed
    // portfolio shape in a couple of places, and tightening it is a
    // separate, unrelated type-safety cleanup — not part of this fix.
    const referenceData = resolveImportReferenceData<any, ImportAsset, ImportAssetAlias>(
      portfoliosResult,
      assetsResult,
      assetAliasesResult
    );
    if (!referenceData.ok) {
      console.error('Import reference-data fetch failed:', {
        portfoliosError: portfoliosResult.error ?? null,
        assetsError: assetsResult.error ?? null,
        assetAliasesError: assetAliasesResult.error ?? null,
      });
      return NextResponse.json(
        safe({ message: 'Failed to load reference data for import. Please retry.' }),
        { status: 500 }
      );
    }
    const { portfolios, assets, aliases } = referenceData;

    // C18: the user's own portfolios, keyed by trimmed, lower-cased effective
    // import name (import_name when set, else the display name).
    const portfoliosByName = indexPortfoliosByName<{ id: string; name: string | null; import_name?: string | null }>(portfolios ?? []);
    const availablePortfolios = (portfolios ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      normalized: normalizeNameForLookup(p.name),
    }));

    const cleaned: Array<{ raw: any; portfolio_id: string; asset_id: string | null; rowNum: number }> = [];
    const errors: any[] = [];
    // C16: 'GBP' cash placeholder rows are ignored, not rejected. Recorded
    // only so the confirm-stage success response can report them.
    const ignoredRows: { row: number; reason: string }[] = [];
    // C17: SPL rows with a ratio <= 0 (also in `errors`). Any at confirm
    // aborts the whole import before anything is written.
    const invalidSplitRows: { row: number; ticker: string; reason: string }[] = [];
    const seenNewTickers = new Set<string>();

    // Validate + normalize input rows
    try {
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2;

        const tickerRaw = getField(row, 'ticker') ?? getField(row, 'symbol') ?? '';
        const ticker = normalizeTicker(tickerRaw);
        if (ticker === 'GBP') { // ignore cash placeholder rows if they exist
          ignoredRows.push({ row: rowNum, reason: "'GBP' cash placeholder row; ignored, not imported." });
          continue;
        }

        // Normalization: read cash_value header only (remove fallback to settle_value)
        const normalized = {
          portfolio: (getField(row, 'portfolio') ?? '').toString().trim(),
          ticker,
          transaction_type: (getField(row, 'transaction_type') ?? getField(row, 'type') ?? '').toString(),
          date_time: getField(row, 'date_time') ?? getField(row, 'date') ?? '',
          quantity: cleanNumberString(getField(row, 'quantity') ?? ''),
          price: cleanNumberString(getField(row, 'price') ?? ''),
          fee: cleanNumberString(getField(row, 'fee') ?? ''),
          fxrate: cleanNumberString(getField(row, 'fxrate') ?? ''),
          // only accept explicit cash_value header now
          cash_value: cleanNumberString(getField(row, 'cash_value') ?? ''),
          notes: getField(row, 'notes') ?? '',
        };

        const result = transactionSchema.safeParse(normalized);
        if (!result.success) {
          errors.push({ row: rowNum, issues: result.error.issues });
          continue;
        }

        const parsed = result.data;

        // C18: exact match on the portfolio's one effective import name,
        // ignoring only surrounding whitespace and letter case. No
        // substring/prefix/similar-name fallback. See
        // src/lib/portfolioNameMatch.ts.
        const nameMatch = matchPortfolioByName(parsed.portfolio, portfoliosByName);
        if (nameMatch.status === 'none') {
          errors.push({ row: rowNum, issues: [{ message: `No matching portfolio for '${normalized.portfolio}'` }] });
          continue;
        }
        if (nameMatch.status === 'ambiguous') {
          errors.push({ row: rowNum, issues: [{ message: `Portfolio name '${normalized.portfolio}' matches more than one of your portfolios; rename them so each name is unique` }] });
          continue;
        }
        const portfolioMatch = nameMatch.portfolio;

        // C17: an SPL ratio (the CSV quantity) must be > 0. Reported as an
        // invalid row at preview; at confirm it refuses the whole import
        // before any write, because importing later rows without the split
        // would misstate the holding.
        if (canonicalizeType(parsed.transaction_type) === 'SPL' && !(Number(parsed.quantity) > 0)) {
          errors.push({ row: rowNum, issues: [{ message: SPL_RATIO_REASON }] });
          invalidSplitRows.push({ row: rowNum, ticker, reason: SPL_RATIO_REASON });
          continue;
        }

        // Resolution order: exact ticker/resolved_ticker match (incl. the
        // .L toggle tolerance), then an explicit asset_aliases entry, then
        // "potentially new". See src/lib/assetResolution.ts.
        const matchedAsset = resolveImportTicker(ticker, assets ?? [], aliases);
        if (!matchedAsset) {
          // mark new tickers for lookup/insert; don't reject rows based on DB asset.status
          seenNewTickers.add(ticker);
        }

        cleaned.push({
          raw: parsed,
          portfolio_id: portfolioMatch.id as string,
          asset_id: matchedAsset?.id ?? null,
          rowNum,
        });
      }
    } catch (err: any) {
      console.error('Cleaning loop error:', err);
      return NextResponse.json(safe({ message: 'Server error during import', error: String(err) }), { status: 500 });
    }

    // -------- Preview stage --------
    if (stage === 'preview') {
      const MAX_LOOKUPS = 20;
      const PER_LOOKUP_TIMEOUT_MS = 3000;

      const { toLookup: tickersToLookup, omitted: omittedNewTickers } = splitTickersForLookup(
        Array.from(seenNewTickers),
        MAX_LOOKUPS
      );
      const newTickers = await Promise.all(
        tickersToLookup.map(async (t) => {
          try {
            const meta = await withTimeout(fetchTickerMeta(t), PER_LOOKUP_TIMEOUT_MS);
            return {
              ticker: meta.ticker,
              name: meta.name,
              currency: meta.currency,
              price_multiplier: meta.price_multiplier,
              // Automatic lookup didn't return a currency — this ticker is
              // genuinely new and needs manual currency entry before it can
              // be confirmed. See src/lib/manualAssetMetadata.ts.
              needsManualCurrency: !meta.currency,
            };
          } catch {
            return { ticker: t, name: null, currency: null, price_multiplier: 1, needsManualCurrency: true };
          }
        })
      );

      return NextResponse.json(safe({
        message: 'Preview complete',
        validCount: cleaned.length,
        invalidCount: errors.length,
        newTickers,
        // Symbols beyond MAX_LOOKUPS — no Yahoo lookup performed for these.
        // Surfaced so a 21st+ new ticker is never a silent surprise; see the
        // UI's retry-workflow explanation for what the user does with this.
        omittedNewTickers,
        errors,
        availablePortfolios,
      }));
    }

    // -------- Confirm stage (insert) --------
    // C17: refuse the whole import if any SPL ratio is invalid. This runs
    // before new-asset creation and every other write in this request.
    if (invalidSplitRows.length > 0) {
      const rowList = invalidSplitRows.map((r) => r.row).join(', ');
      return NextResponse.json(
        safe({
          message:
            `Import aborted — nothing was imported. Invalid split ratio on ` +
            `row${invalidSplitRows.length > 1 ? 's' : ''} ${rowList}: SPL quantity must be greater than 0. ` +
            `Fix the file and import it again.`,
          invalidSplitRows,
          availablePortfolios,
        }),
        { status: 400 }
      );
    }

    const confirmedTickersRaw = formData.get('confirmedTickers');
    const confirmedTickers = Array.isArray(confirmedTickersRaw)
      ? (confirmedTickersRaw as string[])
      : typeof confirmedTickersRaw === 'string'
        ? JSON.parse(confirmedTickersRaw || '[]')
        : [];

    // Manual metadata fallback (currency, optionally name), keyed by the
    // same normalized ticker string the client confirmed — only ever
    // consulted below for a ticker whose fresh automatic lookup doesn't
    // return a currency. See src/lib/manualAssetMetadata.ts.
    const manualMetadataRaw = formData.get('manualTickerMetadata');
    let manualTickerMetadata: Record<string, ManualTickerMetadata> = {};
    if (typeof manualMetadataRaw === 'string' && manualMetadataRaw.trim()) {
      try {
        const parsed = JSON.parse(manualMetadataRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          manualTickerMetadata = parsed;
        }
      } catch {
        return NextResponse.json(safe({ message: 'Invalid manualTickerMetadata JSON' }), { status: 400 });
      }
    }

    // De-duplicated, and excludes any ticker that already exists as an
    // asset by the time this confirm request runs (e.g. created by another
    // import, or another confirm of this same import, between preview and
    // now) — this is what stops a duplicate asset row being created for the
    // same ticker.
    const normalizedConfirmed = filterTickersNeedingCreation(
      (confirmedTickers ?? []).map(normalizeTicker).filter((t) => t && t !== 'GBP'),
      assets ?? []
    );

    // Ensure we have metadata for new assets and currency is present.
    // Automatic lookup is always attempted first and always preferred when
    // it returns a currency — manual metadata is only ever used as a
    // fallback. If a VALID manual currency is already present for a ticker
    // (only possible once preview has already told the user automatic
    // lookup found nothing), the automatic lookup is skipped for that
    // ticker: its result could never be used over an already-valid manual
    // currency. See src/lib/confirmTickerMetaResolution.ts.
    const resolvedMetas: ResolvedNewAssetMeta[] = await Promise.all(
      normalizedConfirmed.map((t) => resolveConfirmTickerMeta(t, manualTickerMetadata[t], fetchTickerMeta))
    );

    const missing = resolvedMetas.filter(
      (m): m is Extract<ResolvedNewAssetMeta, { status: 'missing' }> => m.status === 'missing'
    );
    if (missing.length > 0) {
      return NextResponse.json(
        safe({
          message: 'Missing currency for new tickers',
          missingCurrency: missing.map((m) => m.ticker),
          missingCurrencyDetails: missing.map((m) => ({ ticker: m.ticker, reason: m.reason })),
        }),
        { status: 400 }
      );
    }
    const tickerMetas = resolvedMetas.filter(
      (m): m is Extract<ResolvedNewAssetMeta, { status: 'ok' }> => m.status === 'ok'
    );

    // Insert brand new assets
    await Promise.all(
      tickerMetas.map(async (meta) => {
        if (meta.ticker === 'GBP') return null;
        const { data: insertedAsset, error } = await supabase
          .from('assets')
          .insert({
            ticker: meta.ticker,
            name: meta.name,
            currency: meta.currency,
            price_multiplier: meta.price_multiplier,
          })
          .select('id')
          .single();
        if (error) {
          console.error('Asset insert error:', meta.ticker, error);
          return null;
        }

        // Best-effort corporate-domain enrichment (see
        // src/lib/newAssetDomainEnrichment.ts) — removes the previously-
        // manual "go into Supabase and set the domain" step for a
        // genuinely new asset. Capped at DOMAIN_DISCOVERY_TIMEOUT_MS and
        // wrapped so a failure here can NEVER fail this insert or the
        // overall import: the asset above is already committed.
        if (insertedAsset?.id) {
          await withTimeout(
            enrichNewAssetDomain(supabase, insertedAsset.id, meta.ticker, fetchCompanyWeburlFromFinnhub),
            DOMAIN_DISCOVERY_TIMEOUT_MS
          ).catch((err) => {
            console.warn(`Domain enrichment skipped for ${meta.ticker}:`, err instanceof Error ? err.message : err);
          });
        }
        return null;
      })
    );

    // Refresh assets map
    const { data: updatedAssets } = await supabase.from('assets').select('id, ticker, currency, resolved_ticker');
    const assetsMap: Record<string, { id: string | null; currency: string | null }> = {};
    for (const a of (updatedAssets ?? [])) {
      const tk = (a.ticker ?? '').toString().toUpperCase();
      const rt = (a.resolved_ticker ?? '').toString().toUpperCase();
      const baseNoL = tk.replace(/\.L$/, '');

      // map canonical forms so later checks succeed for minor variations
      assetsMap[tk] = { id: a.id, currency: a.currency };
      assetsMap[baseNoL] = assetsMap[baseNoL] || { id: a.id, currency: a.currency };
      assetsMap[`${baseNoL}.L`] = assetsMap[`${baseNoL}.L`] || { id: a.id, currency: a.currency };
      if (rt) {
        assetsMap[rt] = assetsMap[rt] || { id: a.id, currency: a.currency };
        const rNoL = rt.replace(/\.L$/, '');
        assetsMap[rNoL] = assetsMap[rNoL] || { id: a.id, currency: a.currency };
      }
    }
    // Also index by alias, so a row whose raw ticker is an alias (e.g.
    // "CAKE.US") resolves here exactly like its canonical ticker does — the
    // same `aliases` list fetched at the top of this request (aliases are
    // never created by this route, so it's still accurate here). Without
    // this, a row would resolve correctly during cleaning (via
    // resolveImportTicker) but then fail to find itself in assetsMap below,
    // since assetsMap is otherwise keyed only by real ticker/resolved_ticker
    // strings.
    const updatedAssetsById = new Map((updatedAssets ?? []).map((a) => [a.id, a]));
    for (const al of aliases) {
      const aliasKey = (al.alias ?? '').toString().toUpperCase();
      const target = updatedAssetsById.get(al.asset_id);
      if (!aliasKey || !target || assetsMap[aliasKey]) continue;
      assetsMap[aliasKey] = { id: target.id, currency: target.currency };
    }
    // Map portfolios by id with base_currency exposed as `currency`
    const portfoliosById = Object.fromEntries(
      (portfolios ?? []).map((p) => [p.id, { name: (p as any).name, currency: (p as any).base_currency ?? null }])
    );

    // All-or-nothing ticker-resolution gate: after asset confirmation/creation
    // above, every transaction row must reference a ticker that now resolves
    // to a real asset. If any row doesn't, abort before inserting anything —
    // no FX-cache fetch, no transaction rows built, no insert. Asset rows
    // created in the step above are NOT rolled back by this check (scoped
    // deliberately to transaction-import atomicity only).
    const unresolvedTickerRows = findUnresolvedTickerRows(
      cleaned.map((r) => ({
        rowNum: r.rowNum,
        ticker: normalizeTicker(r.raw.ticker),
        date: r.raw.date_time,
        portfolioId: r.portfolio_id,
      })),
      (ticker) => !!(assetsMap[ticker] || assetsMap[`${ticker}.L`]),
      (portfolioId) => portfoliosById[portfolioId]?.name ?? portfolioId
    );

    if (unresolvedTickerRows.length > 0) {
      return NextResponse.json(
        safe({
          message:
            `Import aborted: ${unresolvedTickerRows.length} row${unresolvedTickerRows.length > 1 ? 's' : ''} ` +
            `reference a ticker that is not a recognised asset. Confirm or fix these tickers and re-import the same file.`,
          unresolvedTickerRows,
          availablePortfolios,
        }),
        { status: 400 }
      );
    }

    // Bulk-fetch the local FX cache for every distinct trade date in this
    // import, once, up front (not per-row). This is the ONLY FX lookup this
    // route performs for the cash-leg fallback fix below — no external FX
    // calls are made, matching the local-fx_rates-cache-or-nothing rule.
    const distinctDates = Array.from(new Set(cleaned.map((r) => r.raw.date_time).filter(Boolean)));
    const fxQuotesByDate: Record<string, Record<string, number>> = {};
    if (distinctDates.length > 0) {
      const { data: fxRows } = await supabase
        .from('fx_rates')
        .select('date, quotes')
        .in('date', distinctDates);
      for (const row of fxRows ?? []) {
        if (row?.date) fxQuotesByDate[row.date] = row.quotes as Record<string, number>;
      }
    }

    // Build final transaction rows. A plain loop (not filter().map()) so a
    // BUY/SELL row that fails the cash-leg fallback check can be skipped and
    // reported, rather than silently inserted with a fabricated conversion.
    const finalRows: any[] = [];
    const skippedCashLeg: { row: number; ticker: string; date: string; portfolio: string; reason: string }[] = [];
    // C15: rows skipped because a required cash_value was blank. Counted
    // separately so the summary message never calls them an FX problem.
    let blankCashSkipCount = 0;
    const skipBlankCash = (
      row: { rowNum: number; portfolio_id: string; raw: { date_time: string } },
      ticker: string,
      portfolioMeta: { name?: string },
      type: string
    ) => {
      blankCashSkipCount++;
      skippedCashLeg.push({
        row: row.rowNum,
        ticker,
        date: row.raw.date_time,
        portfolio: portfolioMeta.name ?? row.portfolio_id,
        reason: `cash_value is required for ${type} rows and was blank; the row was not imported.`,
      });
    };

    // A single multi-row INSERT gives every row the SAME created_at (verified
    // directly against this project's local dev Postgres: `now()` is the
    // transaction's start time, identical for every row in one statement).
    // The holdings/transfer-replay ordering (the shared
    // compareTransactionsForReplay in src/lib/transactionOrdering.ts) uses created_at as
    // its second tiebreaker, after date — so without a distinct value per row,
    // several same-date rows in ONE import batch fall through to a
    // type-priority/UUID tiebreak that does not reflect the CSV's own row
    // order, and can place a row intended to come AFTER a same-day TOT before
    // it, corrupting that TOT's frozen cost-parcel capture. Assigning each
    // row its own strictly-increasing created_at (1ms apart, in the same
    // order the CSV rows were read) preserves that intended order without
    // changing any replay/engine code.
    const importBaseTimeMs = Date.now();

    for (const row of cleaned) {
      const base = normalizeTicker(row.raw.ticker);
      if (base === 'GBP' || !(assetsMap[base] || assetsMap[`${base}.L`])) continue;

      const tickerKey = assetsMap[base] ? base : `${base}.L`;

      const raw = row.raw;
      const canonical = canonicalizeType(raw.transaction_type);

      let type: CanonicalType = 'OTR';
      let quantity = Number(raw.quantity ?? 0);
      let price = Number(raw.price ?? 0);
      let fee = Number(raw.fee ?? 0);
      let fxrate = raw.fxrate == null ? null : Number(raw.fxrate);
      // we no longer derive or copy gbp_value
      let settle_value = raw.settle_value == null ? null : Number(raw.settle_value);
      let split_factor: number | null = null;

      if (canonical === 'TRANSFER_GENERIC') {
        if (quantity < 0) {
          type = 'TOT';
          quantity = Math.abs(quantity);
        } else {
          type = 'TIN';
        }
      } else {
        type = canonical;
      }

      if (type === 'SPL') {
        split_factor = Number(raw.quantity);
        // Safeguard only: C17 validation above refuses these before any write.
        if (!split_factor || split_factor <= 0) {
          throw new Error(`Invalid split ratio in CSV for SPL (row with ticker ${base})`);
        }
        quantity = 0;
        price = 0;
        fee = 0;
        settle_value = 0;
        finalRows.push({
          portfolio_id: row.portfolio_id,
          asset_id: assetsMap[tickerKey]?.id,
          type,
          date: raw.date_time,
          created_at: new Date(importBaseTimeMs + finalRows.length).toISOString(),
          quantity,
          price,
          fee,
          cash_value: null,
          cash_ccy: null,
          settle_value,
          settle_ccy: assetsMap[tickerKey]?.currency ?? null,
          // gbp_value removed (legacy)
          cash_fx_to_portfolio: fxrate,
          notes: raw.notes ?? null,
          split_factor,
        });
        continue;
      }

      settle_value = (quantity * price + fee);

      const assetMeta = assetsMap[tickerKey] || { id: null, currency: null };
      const portfolioMeta = portfoliosById[row.portfolio_id] || { currency: null };

      let cash_value: number | null;
      let cash_ccy: string | null;
      let cash_fx_to_portfolio: number | null;

      if (shouldApplyCashLegGate(type, isCashTicker(base))) {
        // The fallback fix: never silently relabel a native settlement
        // amount as portfolio-base cash. See src/lib/cashLeg.ts. Originally
        // BUY/SELL only; extended to DIV/INT/DEP/WIT/FEE/OTR and CASH.*
        // TIN/TOT by the SAP.DE DIV / ETRO DEP investigation — those are
        // genuine cash movements with exactly the same FX risk.
        const explicitCashValue = raw.cash_value == null ? null : Number(raw.cash_value);
        // C15: DIV/INT/DEP/WIT/FEE/OTR carry their own signed cash amount.
        // A blank cash_value must not be replaced by an estimate from
        // quantity*price+fee (it could have the wrong sign), so the row is
        // skipped and reported.
        if (CASH_LEG_TRANSACTION_TYPES.has(type) && explicitCashValue == null) {
          skipBlankCash(row, base, portfolioMeta, type);
          continue;
        }
        // DIV/INT/DEP/WIT/FEE/OTR are genuine cash-impact types: an explicit
        // cash_value's sign (a charge, a refund, or exactly 0) must be
        // trusted as-is, regardless of the asset's settlement currency. BUY
        // /SELL (also gated above) must NOT get this — their cash_value is
        // always a magnitude, direction comes from type/quantity alone.
        const allowSignedExplicitCash = CASH_LEG_TRANSACTION_TYPES.has(type);
        const cashLeg = resolveRowCashLeg(
          assetMeta.currency,
          portfolioMeta.currency,
          Math.abs(settle_value),
          explicitCashValue,
          fxrate,
          fxQuotesByDate[raw.date_time],
          allowSignedExplicitCash,
          // C1: a SELL's fallback cash is net proceeds (gross - fee), not settle_value.
          type === 'SELL' ? Math.abs(quantity * price) - fee : null
        );

        if (cashLeg.status === 'blocked') {
          skippedCashLeg.push({
            row: row.rowNum,
            ticker: base,
            date: raw.date_time,
            portfolio: portfolioMeta.name ?? row.portfolio_id,
            reason: cashLeg.reason,
          });
          continue;
        }

        cash_value = cashLeg.cash_value;
        cash_ccy = cashLeg.cash_ccy;
        cash_fx_to_portfolio = cashLeg.cash_fx_to_portfolio;
      } else {
        // Rows not gated above: TIN/TOT for an ordinary (non-cash-ticker)
        // security, and FXM.
        //
        // TIN/TOT here is an in-kind transfer whose cash_value/cash_ccy are
        // never consulted by any downstream calculation — cost is booked
        // from settle_value instead (see queries.ts's
        // applyTransactionToHolding and transferCostBasis.ts). Deliberately
        // NOT run through the cash-leg FX gate above: doing so would
        // silently drop a legitimate transfer (units and settle-side cost
        // included) whenever no FX info exists for an amount nothing ever
        // reads. Its cash_value is stored as supplied, blank as null (C15).
        //
        // FXM's cash_value IS the final, signed, portfolio-base-currency
        // amount already — resolveUngatedCashValue passes it through
        // unchanged (no Math.abs, no FX conversion, no blocking). See
        // src/lib/cashLeg.ts's CASH_LEG_TRANSACTION_TYPES comment for why
        // FXM must never go through the gated branch above instead.
        const cashFromCsv = raw.cash_value == null ? null : Number(raw.cash_value);
        if (type === 'FXM') {
          // C15: FXM's cash_value is required (see above); never estimate it.
          if (cashFromCsv == null) {
            skipBlankCash(row, base, portfolioMeta, type);
            continue;
          }
          cash_value = resolveUngatedCashValue(cashFromCsv, quantity, price, fee);
        } else {
          // C15: a security transfer moves no cash. Store cash_value exactly as
          // supplied; a blank stays null rather than an estimate.
          cash_value = cashFromCsv;
        }
        cash_ccy = portfolioMeta.currency ?? null;
        cash_fx_to_portfolio = fxrate;
      }

      finalRows.push({
        portfolio_id: row.portfolio_id,
        asset_id: assetMeta.id,
        type,
        date: raw.date_time,
        created_at: new Date(importBaseTimeMs + finalRows.length).toISOString(),
        quantity,
        price,
        fee,
        cash_value,
        cash_ccy,
        settle_value,
        settle_ccy: assetMeta.currency ?? null,
        // gbp_value omitted; set to null if column is NOT nullable:
        // gbp_value: null,
        cash_fx_to_portfolio,
        notes: raw.notes ?? null,
        split_factor,
      });
    }

    if (finalRows.length === 0) {
      return NextResponse.json(
        safe({ message: 'No transactions to insert', errors, skippedCashLeg, availablePortfolios }),
        { status: 400 }
      );
    }

    // Insert transactions. .select() is required here (beyond the pre-existing
    // insert) so we get back the generated ids for any TOT/TIN rows — needed
    // to create their pending transfer records below. This does not change
    // the atomicity of this statement: it is still one INSERT of the whole
    // batch, all-or-nothing, exactly as before.
    let insertedRows: any[] = [];
    try {
      const { data: insertData, error: insertError } = await supabase
        .from('transactions')
        .insert(finalRows)
        .select('id, portfolio_id, asset_id, type, quantity, date, notes');
      if (insertError) {
        console.error('Import INSERT error:', insertError, { finalRowsCount: finalRows.length, sampleRows: finalRows.slice(0, 3) });
        return NextResponse.json(
          safe({
            message: 'Insert failed',
            error: insertError.message ?? insertError,
            debug: { finalRowsCount: finalRows.length, sampleRows: finalRows.slice(0, 3) },
          }),
          { status: 500 }
        );
      }
      insertedRows = insertData ?? [];
    } catch (err: any) {
      console.error('Import exception:', err, { finalRowsCount: finalRows.length, sampleRows: finalRows.slice(0, 3) });
      return NextResponse.json(
        safe({
          message: 'Insert exception',
          error: String(err),
          debug: { finalRowsCount: finalRows.length, sampleRows: finalRows.slice(0, 3) },
        }),
        { status: 500 }
      );
    }

    // Transfer persistence integration (Phase 2): for any security TOT/TIN
    // rows in this import, create their pending_out/pending_in transfer
    // record and surface any candidate matches. This is a SEPARATE write
    // from the transactions insert above, which has already succeeded and
    // committed — a failure here is reported, never used to roll back or
    // otherwise touch the transaction rows, which remain exactly as
    // imported. A TOT/TIN with no transfer record simply behaves exactly as
    // it always has (today's unchanged legacy behaviour) — untracked, not
    // broken. Live holdings replay and Definition B are not touched by this
    // call; it only ever reads transaction history (to replay a source
    // holding for parcel capture) and writes to the `transfers` table.
    let transferResult: Awaited<ReturnType<typeof processImportedTransfers>> = { created: [], suggestions: {}, errors: [] };
    const assetTickerById: Record<string, string> = {};
    for (const a of (updatedAssets ?? [])) {
      if (a?.id) assetTickerById[a.id] = (a.ticker ?? '').toString();
    }
    try {
      transferResult = await processImportedTransfers(supabase, insertedRows, assetTickerById, session.user.id);
    } catch (err: any) {
      console.error('Transfer persistence integration error (transactions already committed):', err);
      transferResult = { created: [], suggestions: {}, errors: [{ transactionId: 'unknown', error: String(err) }] };
    }

    const conversionSkipCount = skippedCashLeg.length - blankCashSkipCount;
    const skippedParts = [
      conversionSkipCount > 0
        ? `${conversionSkipCount} row${conversionSkipCount > 1 ? 's' : ''} skipped — no reliable currency conversion`
        : null,
      blankCashSkipCount > 0
        ? `${blankCashSkipCount} row${blankCashSkipCount > 1 ? 's' : ''} skipped — required cash_value was blank`
        : null,
    ].filter(Boolean);
    const skippedNote = skippedParts.length > 0 ? ` ${skippedParts.join('; ')} (see skippedCashLeg).` : '';
    // C16: rows dropped by validation or portfolio matching are reported with
    // the same reason text the preview shows. Reporting only; which rows
    // import is unchanged.
    const rejectedRows = errors.map((e) => ({
      row: e.row as number,
      reason: (e.issues ?? []).map((iss: any) => iss?.message ?? JSON.stringify(iss)).join('; '),
    }));
    const rejectedNote = rejectedRows.length > 0
      ? ` ${rejectedRows.length} row${rejectedRows.length > 1 ? 's' : ''} rejected — failed validation or portfolio matching (see rejectedRows).`
      : '';
    const ignoredNote = ignoredRows.length > 0
      ? ` ${ignoredRows.length} 'GBP' placeholder row${ignoredRows.length > 1 ? 's' : ''} ignored (see ignoredRows).`
      : '';
    const suggestionCount = Object.values(transferResult.suggestions).reduce((n, s) => n + s.length, 0);
    const transferNote = transferResult.created.length > 0
      ? ` ${transferResult.created.length} pending transfer record${transferResult.created.length > 1 ? 's' : ''} recorded` +
        (suggestionCount > 0 ? ` (${suggestionCount} candidate match${suggestionCount > 1 ? 'es' : ''} found — not linked automatically).` : '.')
      : '';
    const transferErrorNote = transferResult.errors.length > 0
      ? ` ${transferResult.errors.length} transfer record${transferResult.errors.length > 1 ? 's' : ''} could not be created — affected rows remain imported but untracked as transfers (see transferResult.errors).`
      : '';

    return NextResponse.json(safe({
      message: `Imported ${finalRows.length} transaction${finalRows.length > 1 ? 's' : ''}.${rejectedNote}${ignoredNote}${skippedNote}${transferNote}${transferErrorNote}`,
      skippedCashLeg,
      rejectedRows,
      ignoredRows,
      transferResult,
    }));
  } catch (err: any) {
    console.error('Import API unhandled error:', err);
    return NextResponse.json(
      safe({
        message: 'Server error during import',
        error: String(err),
        stack: String(err?.stack || '').split('\n').slice(0, 10),
      }),
      { status: 500 }
    );
  }
}
