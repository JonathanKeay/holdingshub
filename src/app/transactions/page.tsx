'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
// Cookie-aware client (carries the logged-in session), required now that
// `transactions`/`portfolios` are RLS-protected by portfolio ownership — the
// old bare anon-key client here had no session at all and only worked
// because of the previously wide-open grants.
import { supabaseBrowser as supabase } from '@/lib/supabase/browser';
import { formatCurrency } from '@/lib/formatCurrency';
import { IconEdit, IconTrash } from '@/components/icons';
import { Eye } from 'lucide-react';
import { resolveCashLeg, deriveAssetToBaseRate } from '@/lib/cashLeg';
import { findTransferLink, type TransferRecord } from '@/lib/transactionDeleteSafety';
import {
  deleteTransactionSafely,
  loadDeleteAssessment,
  updateTransactionNotes,
  TRANSFER_LINK_COLUMNS,
} from '@/lib/transactionMutations';
import {
  DeleteTransactionDialog,
  EditNotesDialog,
  TransactionDetailsDialog,
  type DeleteDialogState,
  type TransactionView,
  type TransferLinkState,
} from '@/components/transactions/TransactionDialogs';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

type TransactionRow = {
  id: string;
  date: string;
  created_at: string | null;
  type: string; // e.g. BUY, SELL, TIN, TOT, DIV, INT, DEP, WIT, FEE, SPL, OTR
  quantity: number;
  price: number;
  fee: number;
  cash_value: number | null;
  cash_ccy: string | null;
  cash_fx_to_portfolio: number | null;
  settle_value: number | null;
  settle_ccy: string | null;
  notes: string;
  ticker: string;
  portfolio_name: string;
  currency: string;
  split_factor?: number | null; // used for SPL only
  // Stored values exactly as read (null stays null), for View Details.
  raw: { quantity: number | null; price: number | null; fee: number | null };
};

// Financial fields are immutable after creation/import: a row can only be
// viewed, have its notes edited, or be deleted after a safety check
// (src/lib/transactionDeleteSafety.ts). A wrong transaction is deleted and the
// corrected one added or imported.
function toView(tx: TransactionRow): TransactionView {
  return {
    id: tx.id,
    portfolio_name: tx.portfolio_name,
    ticker: tx.ticker,
    type: tx.type,
    date: tx.date,
    created_at: tx.created_at,
    quantity: tx.raw.quantity,
    price: tx.raw.price,
    fee: tx.raw.fee,
    cash_value: tx.cash_value,
    cash_ccy: tx.cash_ccy,
    settle_value: tx.settle_value,
    settle_ccy: tx.settle_ccy,
    cash_fx_to_portfolio: tx.cash_fx_to_portfolio,
    split_factor: tx.split_factor ?? null,
    notes: tx.notes === '' ? null : tx.notes,
  };
}

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

type PortfolioOption = { id: string; name: string; base_currency?: string };

type NewTx = {
  portfolio_id: string;
  ticker: string;
  type: 'BUY' | 'SELL';
  date: string; // yyyy-mm-dd
  quantity: number;
  price: number;
  fee: number;
  cash_value?: number | null;
  fxrate?: number | null;
  notes?: string;
};

function TransactionsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const portfolioFilter = searchParams.get('portfolio');

  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [sortColumn, setSortColumn] = useState<'date' | 'ticker' | 'type' | null>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  // null = transfer records could not be read (shown as "Unknown").
  const [transfers, setTransfers] = useState<TransferRecord[] | null>([]);
  const [viewTx, setViewTx] = useState<TransactionRow | null>(null);
  const [notesTx, setNotesTx] = useState<TransactionRow | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [deleteTx, setDeleteTx] = useState<TransactionRow | null>(null);
  const [deleteState, setDeleteState] = useState<DeleteDialogState>({ phase: 'checking' });
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [filterDateFrom, setFilterDateFrom] = useState(searchParams.get('dateFrom') || '');
  const [filterDateTo, setFilterDateTo] = useState(searchParams.get('dateTo') || '');
  const [filterTicker, setFilterTicker] = useState(searchParams.get('ticker') || '');
  const [filterType, setFilterType] = useState(searchParams.get('type') || '');

  const [tickers, setTickers] = useState<{ id: string; ticker: string; currency: string }[]>([]);
  const [portfolios, setPortfolios] = useState<PortfolioOption[]>([]);

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [newTx, setNewTx] = useState<NewTx>({
    portfolio_id: '',
    ticker: '',
    type: 'BUY',
    date: todayStr,
    quantity: 0,
    price: 0,
    fee: 0,
    cash_value: null,
    fxrate: null,
    notes: '',
  });

  function updateQueryParams(key: string, value: string) {
    const params = new URLSearchParams(window.location.search);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.replace('?' + params.toString());
  }

  // Debounced URL updates
  useEffect(() => {
    const t = setTimeout(() => updateQueryParams('dateFrom', filterDateFrom), 300);
    return () => clearTimeout(t);
  }, [filterDateFrom]);

  useEffect(() => {
    const t = setTimeout(() => updateQueryParams('dateTo', filterDateTo), 300);
    return () => clearTimeout(t);
  }, [filterDateTo]);

  useEffect(() => {
    const t = setTimeout(() => updateQueryParams('ticker', filterTicker), 300);
    return () => clearTimeout(t);
  }, [filterTicker]);

  useEffect(() => {
    const t = setTimeout(() => updateQueryParams('type', filterType), 300);
    return () => clearTimeout(t);
  }, [filterType]);

  useEffect(() => {
    async function fetchTickers() {
      const { data, error } = await supabase
        .from('assets')
        .select('id, ticker, currency')
        .order('ticker', { ascending: true });
      if (!error && data) setTickers(data as { id: string; ticker: string; currency: string }[]);
    }
    async function fetchPortfolios() {
      const { data, error } = await supabase
        .from('portfolios')
        .select('id, name, base_currency')
        .order('name', { ascending: true });
      if (!error && data) setPortfolios(data as PortfolioOption[]);
    }
    fetchTickers();
    fetchPortfolios();
  }, []);

  function handleSort(column: typeof sortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  // Move this function definition outside of useEffect so it's accessible
  async function fetchTransactions() {
    const query = supabase
      .from('transactions')
      .select(`
        id, date, created_at, type, quantity, price, fee, cash_value, cash_ccy, cash_fx_to_portfolio,
        settle_value, settle_ccy, notes, split_factor,
        assets ( ticker, currency ),
        portfolios ( name )
      `)
      .order('date', { ascending: false });

    if (portfolioFilter) {
      query.eq('portfolio_id', portfolioFilter);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching transactions:', error);
      return;
    }

    const mapped = data.map((t: any) => ({
      id: t.id,
      date: t.date,
      created_at: t.created_at ?? null,
      cash_fx_to_portfolio: numOrNull(t.cash_fx_to_portfolio),
      settle_value: numOrNull(t.settle_value),
      settle_ccy: t.settle_ccy ?? null,
      raw: { quantity: numOrNull(t.quantity), price: numOrNull(t.price), fee: numOrNull(t.fee) },
      type: (t.type ?? '').toString().toUpperCase(),
      quantity: Number(t.quantity ?? 0),
      price: Number(t.price ?? 0),
      fee: Number(t.fee ?? 0),
      cash_value: t.cash_value != null ? Number(t.cash_value) : null,
      cash_ccy: t.cash_ccy ?? null,
      notes: t.notes ?? '',
      ticker: t.assets?.ticker ?? 'N/A',
      currency: t.assets?.currency ?? 'GBP',
      portfolio_name: t.portfolios?.name ?? 'Unassigned',
      split_factor: t.split_factor != null ? Number(t.split_factor) : null,
    })) as TransactionRow[];

    setTransactions(mapped);

    const { data: tr, error: trError } = await supabase.from('transfers').select(TRANSFER_LINK_COLUMNS);
    if (trError) console.error('Error fetching transfers:', trError);
    setTransfers(trError ? null : ((tr ?? []) as TransferRecord[]));
  }

  // In useEffect, just call fetchTransactions()
  useEffect(() => {
    fetchTransactions();
  }, [portfolioFilter]);

  // Selected asset (for dynamic fee currency display in add form)
  const selectedAsset = useMemo(
    () => tickers.find((t) => t.ticker === newTx.ticker) || null,
    [tickers, newTx.ticker]
  );
  // Selected portfolio (for showing base currency label next to cash value)
  const selectedPortfolio = useMemo(
    () => portfolios.find((p) => p.id === newTx.portfolio_id) || null,
    [portfolios, newTx.portfolio_id]
  );

  const filteredTransactions = transactions.filter((tx) => {
    const matchDateFrom = filterDateFrom ? new Date(tx.date) >= new Date(filterDateFrom) : true;
    const matchDateTo = filterDateTo ? new Date(tx.date) <= new Date(filterDateTo) : true;
    const matchTicker = filterTicker ? tx.ticker.toLowerCase().includes(filterTicker.toLowerCase()) : true;
    const typeFilters = filterType
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    const matchType =
      typeFilters.length === 0
        ? true
        : typeFilters.includes(tx.type.toUpperCase());
    return matchDateFrom && matchDateTo && matchTicker && matchType;
  });

  const sortedTransactions = [...filteredTransactions].sort((a, b) => {
    const dir = sortDirection === 'asc' ? 1 : -1;
    switch (sortColumn) {
      case 'date': return dir * (new Date(a.date).getTime() - new Date(b.date).getTime());
      case 'ticker': return dir * a.ticker.localeCompare(b.ticker);
      case 'type': return dir * a.type.localeCompare(b.type);
      default: return 0;
    }
  });

  // Colour mapping for type badge
  function typeColor(t: string) {
    const u = (t || '').toUpperCase();
    if (u === 'BUY' || u === 'TIN') return 'text-tgreen';
    if (u === 'SELL' || u === 'TOT' || u === 'FEE') return 'text-tred';
    return 'text-foreground/70';
  }

  function transferLinkFor(id: string): TransferLinkState {
    if (transfers == null) return 'unknown';
    return findTransferLink(id, transfers);
  }

  function openNotes(tx: TransactionRow) {
    setNotesError(null);
    setNotesTx(tx);
  }

  async function handleSaveNotes(notes: string) {
    if (!notesTx) return;
    setNotesSaving(true);
    setNotesError(null);
    // Only the notes column is sent (updateTransactionNotes).
    const result = await updateTransactionNotes(supabase, notesTx.id, notes);
    setNotesSaving(false);
    if (result.status === 'error') {
      setNotesError(result.message);
      return;
    }
    const saved = result.notes ?? '';
    setTransactions((prev) => prev.map((t) => (t.id === notesTx.id ? { ...t, notes: saved } : t)));
    setNotesTx(null);
    setBanner({ kind: 'success', text: 'Notes saved.' });
  }

  async function openDelete(tx: TransactionRow) {
    setBanner(null);
    setDeleteError(null);
    setDeleting(false);
    setDeleteTx(tx);
    setDeleteState({ phase: 'checking' });
    const ctx = await loadDeleteAssessment(supabase, tx.id);
    setDeleteState(
      ctx.status === 'ok' ? { phase: 'ready', assessment: ctx.assessment } : { phase: 'error', message: ctx.message }
    );
  }

  async function handleConfirmDelete() {
    if (!deleteTx) return;
    setDeleting(true);
    setDeleteError(null);
    // Re-checks safety against fresh data before the hard delete.
    const result = await deleteTransactionSafely(supabase, deleteTx.id);
    setDeleting(false);
    if (result.status === 'blocked') {
      setDeleteState({ phase: 'ready', assessment: result.assessment });
      return;
    }
    if (result.status === 'error') {
      setDeleteError(result.message);
      return;
    }
    const removed = deleteTx;
    setDeleteTx(null);
    await fetchTransactions();
    setBanner({
      kind: 'success',
      text:
        `Deleted ${removed.type} ${removed.ticker} dated ${formatDate(removed.date)} from ${removed.portfolio_name}. ` +
        `Portfolio cash and holdings now reflect this. Add or import the corrected transaction if needed.`,
    });
  }

  async function handleCreate() {
    // Basic validation
    if (!newTx.portfolio_id) return alert('Please select a portfolio');
    if (!newTx.ticker) return alert('Please choose a ticker');
    if (!newTx.quantity || newTx.quantity <= 0) return alert('Quantity must be > 0');
    if (newTx.price < 0) return alert('Price cannot be negative');
    if (newTx.fee < 0) return alert('Fee cannot be negative');

    // Lookup asset_id by ticker
    const { data: asset, error: assetError } = await supabase
      .from('assets')
      .select('id, currency')
      .eq('ticker', newTx.ticker)
      .single();
    if (assetError || !asset) {
      return alert('Ticker not found in assets table');
    }

  // Compute settle_value to mirror importer behavior (qty*price + fee) for both BUY/SELL
  const qty = Number(newTx.quantity);
  const price = Number(newTx.price);
  const fee = Number(newTx.fee || 0);
  const settle = qty * price + fee;
  const settleAbs = Math.abs(settle);

    const assetCcy = asset.currency || 'GBP';
    const baseCcy = selectedPortfolio?.base_currency || 'GBP';
    const explicitCashValue =
      newTx.cash_value != null && newTx.cash_value !== undefined && newTx.cash_value !== ('' as any)
        ? Number(newTx.cash_value)
        : null;
    const explicitFxRate = newTx.fxrate != null ? Number(newTx.fxrate) : null;

    // Only fetch the local FX cache when we might actually need it: a
    // cross-currency transaction with no explicit cash_value or FX rate
    // already supplied. No external FX calls are made here — only the local
    // fx_rates cache for this exact trade date.
    let cachedRateAssetToBase: number | null = null;
    if (assetCcy.toUpperCase() !== baseCcy.toUpperCase() && explicitCashValue == null && explicitFxRate == null) {
      const tradeDate = newTx.date; // yyyy-mm-dd, matches fx_rates.date
      const { data: fxRow } = await supabase
        .from('fx_rates')
        .select('quotes')
        .eq('date', tradeDate)
        .maybeSingle();
      cachedRateAssetToBase = deriveAssetToBaseRate(fxRow?.quotes as Record<string, number> | undefined, assetCcy, baseCcy);
    }

    const cashLeg = resolveCashLeg({
      assetCcy,
      baseCcy,
      settleAbs,
      explicitCashValue,
      explicitFxRate,
      cachedRateAssetToBase,
      // C1: a SELL's fallback cash is net proceeds (gross - fee), not settle_value.
      cashBasisAbs: newTx.type === 'SELL' ? Math.abs(qty * price) - fee : null,
    });

    if (cashLeg.status === 'blocked') {
      return alert(
        `Cannot save this transaction: ${cashLeg.reason}\n\n` +
        `This is a ${assetCcy} security in a ${baseCcy} portfolio. Enter either the actual ` +
        `${baseCcy} cash amount or the FX rate used, then try again.`
      );
    }

    const payload: any = {
      portfolio_id: newTx.portfolio_id,
      asset_id: asset.id,
      type: newTx.type,
      // Store date as ISO string with time (set to noon to avoid TZ surprises)
      date: new Date(newTx.date + 'T12:00:00Z').toISOString(),
      quantity: Number(newTx.quantity),
      price: Number(newTx.price),
      fee: Number(newTx.fee || 0),
      notes: newTx.notes || null,
      cash_value: cashLeg.cash_value,
      cash_ccy: cashLeg.cash_ccy,
      cash_fx_to_portfolio: cashLeg.cash_fx_to_portfolio,
      // Set settle leg in asset currency and include fee to reflect total cost/proceeds in asset ccy
      settle_value: settleAbs,
      settle_ccy: asset.currency || null,
    };

    const { error } = await supabase.from('transactions').insert([payload]);
    if (error) {
      console.error('Create failed:', error);
      return alert('Failed to create transaction: ' + error.message);
    }

    // Reset + refresh list
  setNewTx({ ...newTx, quantity: 0, price: 0, fee: 0, cash_value: null, fxrate: null, notes: '' });
    setShowAdd(false);
    await fetchTransactions();
  }

  return (
    <section className="p-4 max-w-6xl mx-auto">
      <div className="sticky top-0 z-20 bg-background pb-2">
        <h2 className="text-xl font-semibold mb-4">
          {portfolioFilter ? 'Transactions for Portfolio' : 'All Transactions'}
        </h2>

        {banner && (
          <div
            role={banner.kind === 'error' ? 'alert' : 'status'}
            className={`mb-3 rounded border px-3 py-2 text-sm flex items-start justify-between gap-3 ${
              banner.kind === 'success' ? 'border-tgreen text-tgreen' : 'border-tred text-tred'
            }`}
          >
            <span>{banner.text}</span>
            <button onClick={() => setBanner(null)} className="text-foreground/60 hover:text-foreground" aria-label="Dismiss">✕</button>
          </div>
        )}

        {/* Add BUY/SELL inline form */}
        <div className="mb-3">
          <button
            type="button"
            className="rounded bg-themeblue text-white px-3 py-1 text-sm hover:bg-themeblue-hover"
            onClick={() => setShowAdd(s => !s)}
          >
            {showAdd ? 'Cancel' : 'Add BUY/SELL'}
          </button>
          {showAdd && (
            <div className="mt-3 border border-Tdivider rounded p-3 bg-gray-back">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="block text-foreground/70">Portfolio</span>
                  <select
                    className="border rounded px-2 py-1 text-sm min-w-[160px]"
                    value={newTx.portfolio_id}
                    onChange={(e) => setNewTx(v => ({ ...v, portfolio_id: e.target.value }))}
                  >
                    <option value="">Select…</option>
                    {portfolios.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Ticker</span>
                  <input
                    list="tickers-list"
                    className="border rounded px-2 py-1 text-sm min-w-[120px]"
                    value={newTx.ticker}
                    onChange={(e) => setNewTx(v => ({ ...v, ticker: e.target.value.toUpperCase().trim() }))}
                    placeholder="e.g. AAPL or VUSA.L"
                  />
                  <datalist id="tickers-list">
                    {tickers.map(t => (
                      <option key={t.id} value={t.ticker} />
                    ))}
                  </datalist>
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Type</span>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={newTx.type}
                    onChange={(e) => setNewTx(v => ({ ...v, type: (e.target.value as 'BUY'|'SELL') }))}
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Date</span>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 text-sm"
                    value={newTx.date}
                    onChange={(e) => setNewTx(v => ({ ...v, date: e.target.value }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Quantity</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.quantity}
                    onChange={(e) => setNewTx(v => ({ ...v, quantity: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Price</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.price}
                    onChange={(e) => setNewTx(v => ({ ...v, price: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Fee ({selectedAsset?.currency || '—'})</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-24 text-right"
                    value={newTx.fee}
                    onChange={(e) => setNewTx(v => ({ ...v, fee: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">Cash Value ({selectedPortfolio?.base_currency || 'GBP'})</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-32 text-right"
                    value={newTx.cash_value ?? ''}
                    onChange={(e) => setNewTx(v => ({ ...v, cash_value: e.target.value === '' ? null : Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-foreground/70">FX Rate (cash_fx_to_portfolio)</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.fxrate ?? ''}
                    onChange={(e) => setNewTx(v => ({ ...v, fxrate: e.target.value === '' ? null : Number(e.target.value) }))}
                  />
                </label>

                <label className="flex-1 text-sm min-w-[200px]">
                  <span className="block text-foreground/70">Notes</span>
                  <input
                    type="text"
                    className="border rounded px-2 py-1 text-sm w-full"
                    value={newTx.notes}
                    onChange={(e) => setNewTx(v => ({ ...v, notes: e.target.value }))}
                  />
                </label>

                <button
                  type="button"
                  className="rounded bg-themeblue text-white px-3 py-1 text-sm h-8 hover:bg-themeblue-hover"
                  onClick={handleCreate}
                  title="Create transaction"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => {
              setFilterDateFrom(e.target.value);
              updateQueryParams('dateFrom', e.target.value);
            }}
            className="border px-2 py-1 rounded text-sm"
          />
          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => {
              setFilterDateTo(e.target.value);
              updateQueryParams('dateTo', e.target.value);
            }}
            className="border px-2 py-1 rounded text-sm"
          />
          <input
            type="text"
            value={filterTicker}
            onChange={(e) => {
              setFilterTicker(e.target.value);
              updateQueryParams('ticker', e.target.value);
            }}
            className="border px-2 py-1 rounded text-sm"
            placeholder="Filter by Ticker"
          />
          <input
            type="text"
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value);
              updateQueryParams('type', e.target.value);
            }}
            className="border px-2 py-1 rounded text-sm"
            placeholder="Filter by Type (e.g. BUY, SPL)"
          />

          <button
            onClick={() => {
              setFilterDateFrom('');
              setFilterDateTo('');
              setFilterTicker('');
              setFilterType('');
              router.replace('?');
            }}
            className="text-tred hover:text-tred-hover text-lg px-1"
            title="Clear all filters"
          >
            ❌
          </button>
        </div>
      </div>

      <div className="overflow-x-auto max-h-[80vh] overflow-y-scroll">
        <p className="mb-2 text-sm text-foreground/70">
          Showing {filteredTransactions.length} transaction{filteredTransactions.length === 1 ? '' : 's'}
          {portfolioFilter ? ` for this portfolio` : ''}
        </p>
        <table className="w-full text-sm border border-Tdivider">
          <thead className="bg-gray-back text-left sticky top-0 z-10">
            <tr>
              <th onClick={() => setSortColumn('date')} className="p-2 cursor-pointer">
                <span className="inline-flex items-center">
                  <span className="mr-1 text-xs font-bold">
                    {sortColumn === 'date' ? (sortDirection === 'asc' ? '▲' : '▼') : '▲▼'}
                  </span>
                  Date
                </span>
              </th>
              <th className="p-2">Portfolio</th>
              <th onClick={() => setSortColumn('ticker')} className="p-2 cursor-pointer">
                <span className="inline-flex items-center">
                  <span className="mr-1 text-xs font-bold">
                    {sortColumn === 'ticker' ? (sortDirection === 'asc' ? '▲' : '▼') : '▲▼'}
                  </span>
                  Ticker
                </span>
              </th>
              <th onClick={() => setSortColumn('type')} className="p-2 cursor-pointer">
                <span className="inline-flex items-center">
                  <span className="mr-1 text-xs font-bold">
                    {sortColumn === 'type' ? (sortDirection === 'asc' ? '▲' : '▼') : '▲▼'}
                  </span>
                  Type
                </span>
              </th>
              <th className="p-2 text-right">Qty</th>
              <th className="p-2 text-right">Price</th>
              <th className="p-2 text-right">Fee</th>
              <th className="p-2 text-right">Cash Value</th>
              <th className="p-2 min-w-[160px]">Notes</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedTransactions.map((tx) => (
              <tr key={tx.id} className="border-t">
                <td className="p-2">{formatDate(tx.date)}</td>
                <td className="p-2">{tx.portfolio_name}</td>
                <td className="p-2 font-mono">{tx.ticker}</td>
                <td className={`p-2 ${typeColor(tx.type)}`}>{tx.type}</td>

                {/* Qty / Price / Fee cells with SPL awareness */}
                <td className="p-2 text-right">
                  {tx.type === 'SPL'
                    ? (tx.split_factor ? `×${tx.split_factor}` : '×—')
                    : tx.quantity}
                </td>
                <td className="p-2 text-right">
                  {tx.type === 'SPL' ? '—' : formatCurrency(tx.price, tx.currency)}
                </td>
                <td className="p-2 text-right">
                  {tx.type === 'SPL' ? '—' : formatCurrency(tx.fee, tx.currency)}
                </td>

                <td className="p-2 text-right">
                  {tx.cash_value != null ? formatCurrency(tx.cash_value, (tx.cash_ccy || 'GBP')) : '—'}
                </td>
                <td className="p-2 min-w-[160px]">{tx.notes}</td>
                <td className="p-2">
                  <div className="inline-flex justify-end gap-2">
                    <button
                      onClick={() => setViewTx(tx)}
                      className="text-accent hover:text-accent/80"
                      title="View details"
                      aria-label="View details"
                    >
                      <Eye className="inline w-6 h-6" />
                    </button>
                    <button
                      onClick={() => openNotes(tx)}
                      className="text-accent hover:text-accent/80"
                      title="Edit notes"
                      aria-label="Edit notes"
                    >
                      <IconEdit className="inline w-6 h-6" />
                    </button>
                    <button
                      onClick={() => openDelete(tx)}
                      className="text-tred hover:text-tred-hover"
                      title="Delete"
                      aria-label="Delete"
                    >
                      <IconTrash className="inline w-6 h-6" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewTx && (
        <TransactionDetailsDialog tx={toView(viewTx)} transferLink={transferLinkFor(viewTx.id)} onClose={() => setViewTx(null)} />
      )}

      {notesTx && (
        <EditNotesDialog
          tx={toView(notesTx)}
          saving={notesSaving}
          error={notesError}
          onSave={handleSaveNotes}
          onClose={() => setNotesTx(null)}
        />
      )}

      {deleteTx && (
        <DeleteTransactionDialog
          tx={toView(deleteTx)}
          state={deleteState}
          deleting={deleting}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTx(null)}
        />
      )}
    </section>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TransactionsPageInner />
    </Suspense>
  );
}
