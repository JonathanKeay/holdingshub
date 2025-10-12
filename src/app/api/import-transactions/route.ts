// app/api/import/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';

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
] as const;

type CanonicalType = 'BUY' | 'SELL' | 'DIV' | 'INT' | 'DEP' | 'WIT' | 'FEE' | 'OTR' | 'TIN' | 'TOT' | 'SPL';

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
  if (t === 'tran' || t === 'transfer') return 'TRANSFER_GENERIC';
  return 'OTR';
}

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
  fxrate: z.union([z.coerce.number(), z.literal('')]).transform((val) => (val === '' ? null : val)),
  // prefer cash_value header only (no fallback to settle_value)
  cash_value: z.union([z.coerce.number(), z.literal('')]).transform((val) => (val === '' ? null : val)),
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

function alnumNormalize(name: string) {
  return stripHidden(name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function canon12(name: string) {
  return alnumNormalize(name).slice(0, 12);
}

// ---------- Route handler ----------
export async function POST(req: NextRequest) {
  try {
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

    // Fetch portfolios (uses base_currency) and assets (include status if you want to block inactive)
    const [{ data: portfolios }, { data: assets }] = await Promise.all([
      supabase.from('portfolios').select('id, name, base_currency'),
      // include resolved_ticker so we can match CSVs against both ticker and resolved_ticker
      supabase.from('assets').select('id, ticker, currency, status, resolved_ticker'),
    ]);

    // Build index for preview display and tolerant name lookups
    const portfoliosByNormalized = Object.fromEntries(
      (portfolios ?? []).map((p) => [
        normalizeNameForLookup(p.name),
        {
          id: p.id,
          name: p.name,
          // Preserve original field for type compatibility
          base_currency: (p as any).base_currency ?? null,
          // Also expose as `currency` for downstream convenience
          currency: (p as any).base_currency ?? null,
        },
      ])
    );
    const availablePortfolios = (portfolios ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      normalized: normalizeNameForLookup(p.name),
    }));

    const cleaned: Array<{ raw: any; portfolio_id: string; asset_id: string | null }> = [];
    const errors: any[] = [];
    const seenNewTickers = new Set<string>();

    // Validate + normalize input rows
    try {
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2;

        const tickerRaw = getField(row, 'ticker') ?? getField(row, 'symbol') ?? '';
        const ticker = normalizeTicker(tickerRaw);
        if (ticker === 'GBP') continue; // ignore cash placeholder rows if they exist

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

        // Strong alnum-12 matching first
        const inputAlnum12 = canon12(parsed.portfolio);
        let portfolioMatch =
          (portfolios ?? []).find((p) => canon12(p.name) === inputAlnum12) || null;

        // Fallback: tolerant contains/startsWith match on alnum-normalized
        if (!portfolioMatch) {
          const portfolioAlnum = alnumNormalize(parsed.portfolio);
          portfolioMatch =
            Object.values(portfoliosByNormalized).find((p) => {
              const pn = alnumNormalize(p.name);
              return (
                pn === portfolioAlnum ||
                pn.startsWith(portfolioAlnum) || portfolioAlnum.startsWith(pn) ||
                pn.includes(portfolioAlnum) || portfolioAlnum.includes(pn)
              );
            }) || null;
        }

        // Legacy: match by first 12 alnum chars again (explicit)
        if (!portfolioMatch && parsed.portfolio) {
          const in12 = canon12(parsed.portfolio);
          portfolioMatch =
            Object.values(portfoliosByNormalized).find((p) => canon12(p.name) === in12) || null;
        }

        if (!portfolioMatch) {
          errors.push({ row: rowNum, issues: [{ message: `No matching portfolio for '${normalized.portfolio}'` }] });
          continue;
        }

        // tolerant asset lookup: check ticker, resolved_ticker and .L / no-.L variants
        function findAssetByTicker(tick: string | null) {
          if (!tick) return null;
          const t = tick.toUpperCase();
          const candidates = (assets ?? []);
          const byExact = (a: any, key: string) => ((a[key] ?? '').toString().toUpperCase() === t);

          let a = candidates.find((c: any) => byExact(c, 'ticker') || byExact(c, 'resolved_ticker'));
          if (a) return a;

          // try toggling .L suffix
          if (t.endsWith('.L')) {
            const noL = t.replace(/\.L$/, '');
            a = candidates.find((c: any) => (c.ticker ?? '').toUpperCase() === noL || (c.resolved_ticker ?? '').toUpperCase() === noL);
          } else {
            const withL = `${t}.L`;
            a = candidates.find((c: any) => (c.ticker ?? '').toUpperCase() === withL || (c.resolved_ticker ?? '').toUpperCase() === withL);
          }
          return a ?? null;
        }

        const matchedAsset = findAssetByTicker(ticker);
        if (!matchedAsset) {
          // mark new tickers for lookup/insert; don't reject rows based on DB asset.status
          seenNewTickers.add(ticker);
        }

        cleaned.push({
          raw: parsed,
          portfolio_id: portfolioMatch.id as string,
          asset_id: matchedAsset?.id ?? null,
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

      const tickersToLookup = Array.from(seenNewTickers).slice(0, MAX_LOOKUPS);
      const newTickers = await Promise.all(
        tickersToLookup.map(async (t) => {
          try {
            const meta = await withTimeout(fetchTickerMeta(t), PER_LOOKUP_TIMEOUT_MS);
            return { ticker: meta.ticker, name: meta.name, currency: meta.currency, price_multiplier: meta.price_multiplier };
          } catch {
            return { ticker: t, name: null, currency: null, price_multiplier: 1 };
          }
        })
      );

      return NextResponse.json(safe({
        message: 'Preview complete',
        validCount: cleaned.length,
        invalidCount: errors.length,
        newTickers,
        errors,
        availablePortfolios,
      }));
    }

    // -------- Confirm stage (insert) --------
    const confirmedTickersRaw = formData.get('confirmedTickers');
    const confirmedTickers = Array.isArray(confirmedTickersRaw)
      ? (confirmedTickersRaw as string[])
      : typeof confirmedTickersRaw === 'string'
        ? JSON.parse(confirmedTickersRaw || '[]')
        : [];

    const normalizedConfirmed = (confirmedTickers ?? [])
      .map(normalizeTicker)
      .filter((t) => t && t !== 'GBP');

    // Ensure we have metadata for new assets and currency is present
    const tickerMetas = await Promise.all(normalizedConfirmed.map((t) => fetchTickerMeta(t)));
    const missingCurrency = tickerMetas.filter((m) => !m.currency).map((m) => m.ticker);
    if (missingCurrency.length > 0) {
      return NextResponse.json(safe({ message: 'Missing currency for new tickers', missingCurrency }), { status: 400 });
    }

    // Insert brand new assets
    await Promise.all(
      tickerMetas.map(async (meta) => {
        if (meta.ticker === 'GBP') return null;
        const { error } = await supabase
          .from('assets')
          .insert({
            ticker: meta.ticker,
            name: meta.name,
            currency: meta.currency,
            price_multiplier: meta.price_multiplier,
          });
        if (error) console.error('Asset insert error:', meta.ticker, error);
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
    // Map portfolios by id with base_currency exposed as `currency`
    const portfoliosById = Object.fromEntries(
      (portfolios ?? []).map((p) => [p.id, { name: (p as any).name, currency: (p as any).base_currency ?? null }])
    );

    // Build final transaction rows
    const finalRows = cleaned
      .filter((row) => {
        const base = normalizeTicker(row.raw.ticker);
        return base !== 'GBP' && (assetsMap[base] || assetsMap[`${base}.L`]);
      })
      .map((row) => {
        const base = normalizeTicker(row.raw.ticker);
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
          if (!split_factor || split_factor <= 0) {
            throw new Error(`Invalid split ratio in CSV for SPL (row with ticker ${base})`);
          }
          quantity = 0;
          price = 0;
          fee = 0;
          settle_value = 0;
          return {
            portfolio_id: row.portfolio_id,
            asset_id: assetsMap[tickerKey]?.id,
            type,
            date: raw.date_time,
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
          };
        }

        const cashFromCsv = raw.cash_value == null ? null : Number(raw.cash_value);
        const cash_value = cashFromCsv != null ? cashFromCsv : (quantity * price + fee);
        // recompute settle_value (kept same logic as before)
        settle_value = (quantity * price + fee);

        const assetMeta = assetsMap[tickerKey] || { id: null, currency: null };
        const portfolioMeta = portfoliosById[row.portfolio_id] || { currency: null };

        return {
          portfolio_id: row.portfolio_id,
          asset_id: assetMeta.id,
          type,
          date: raw.date_time,
          quantity,
          price,
          fee,
          cash_value,
          cash_ccy: portfolioMeta.currency ?? null,
          settle_value,
          settle_ccy: assetMeta.currency ?? null,
          // gbp_value omitted; set to null if column is NOT nullable:
          // gbp_value: null,
          cash_fx_to_portfolio: fxrate,
          notes: raw.notes ?? null,
          split_factor,
        };
      });

    if (finalRows.length === 0) {
      return NextResponse.json(safe({ message: 'No transactions to insert', errors, availablePortfolios }), { status: 400 });
    }

    // Insert transactions
    try {
      const { error: insertError } = await supabase.from('transactions').insert(finalRows);
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

    return NextResponse.json(safe({ message: `Imported ${finalRows.length} transaction${finalRows.length > 1 ? 's' : ''}` }));
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
