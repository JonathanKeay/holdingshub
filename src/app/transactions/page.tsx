'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/formatCurrency';
import { IconEdit, IconTrash } from '@/components/icons';

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
  type: string; // e.g. BUY, SELL, TIN, TOT, DIV, INT, DEP, WIT, FEE, SPL, OTR
  quantity: number;
  price: number;
  fee: number;
  cash_value: number | null;
  cash_ccy: string | null;
  notes: string;
  ticker: string;
  portfolio_name: string;
  currency: string;
  split_factor?: number | null; // used for SPL only
};

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

export default function TransactionsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const portfolioFilter = searchParams.get('portfolio');

  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [sortColumn, setSortColumn] = useState<'date' | 'ticker' | 'type' | null>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [editingTx, setEditingTx] = useState<TransactionRow | null>(null);
  const [editValues, setEditValues] = useState<Partial<TransactionRow>>({});

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
        id, date, type, quantity, price, fee, cash_value, cash_ccy, notes, split_factor,
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

  // Editing modal selected asset (updates when ticker selection changes)
  const editingAsset = useMemo(
    () => tickers.find((t) => t.ticker === (editValues.ticker ?? editingTx?.ticker)) || null,
    [tickers, editValues.ticker, editingTx?.ticker]
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
    if (u === 'BUY' || u === 'TIN') return 'text-green-600';
    if (u === 'SELL' || u === 'TOT' || u === 'FEE') return 'text-red-600';
    return 'text-gray-700';
  }

  async function handleSaveEdit() {
    if (!editingTx) return;

    const tType = (editValues.type ?? editingTx.type ?? '').toString().toUpperCase();
    const payload: any = { ...editValues, type: tType };

    // Always look up asset_id by ticker
    const tickerToUse = editValues.ticker ?? editingTx.ticker;
    if (tickerToUse) {
      const { data: asset, error: assetError } = await supabase
        .from('assets')
        .select('id')
        .eq('ticker', tickerToUse)
        .single();
      if (assetError || !asset) {
        alert('Ticker not found in assets table.');
        return;
      }
      payload.asset_id = asset.id;
    }

    // Remove ticker from payload before update
    delete payload.ticker;

    if (tType === 'SPL') {
      payload.split_factor = editValues.split_factor ?? editingTx.split_factor ?? null;
      // Clean out numeric fields for SPL (no cash flow)
      payload.quantity = 0;
      payload.price = 0;
      payload.fee = 0;
      payload.gbp_value = 0;
    } else {
      // Non-SPL: ensure split_factor is null to avoid confusion
      payload.split_factor = null;
      // Normalize numeric fields
      if (payload.quantity != null) payload.quantity = Number(payload.quantity);
      if (payload.price != null) payload.price = Number(payload.price);
      if (payload.fee != null) payload.fee = Number(payload.fee);
      if (payload.gbp_value != null) payload.gbp_value = Number(payload.gbp_value);
    }

    const { error } = await supabase.from('transactions').update(payload).eq('id', editingTx.id).select();

    if (!error) {
      setTransactions((prev) =>
        prev.map((t) => (t.id === editingTx.id ? { ...t, ...payload, ticker: editValues.ticker ?? t.ticker } : t))
      );
      setEditingTx(null);
      setEditValues({});
    } else {
      console.error('Error updating transaction:', error);
    }
  }

  function handleEdit(id: string) {
    const tx = transactions.find((t) => t.id === id);
    if (tx) {
      setEditingTx(tx);
      setEditValues({
        ticker: tx.ticker, // <-- add this line
        quantity: tx.quantity,
        price: tx.price,
        fee: tx.fee,
        notes: tx.notes,
        type: tx.type,
        split_factor: tx.split_factor ?? undefined,
        cash_value: tx.cash_value ?? undefined,
      });
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return;
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id);
    if (error) {
      alert('Delete failed: ' + error.message);
    } else {
      fetchTransactions(); // <-- update here
    }
  };

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

    // Helper to compute cash_value in portfolio base currency using cached FX (if available)
    async function computeCashLeg(
      assetCcy: string,
      portfolioId: string,
      tradeDate: string,
      settleAbs: number
    ): Promise<{ cash_value: number | null; cash_ccy: string | null; cash_fx_to_portfolio: number | null }> {
      const pf = portfolios.find(p => p.id === portfolioId);
      const base = (pf?.base_currency || 'GBP').toUpperCase();
      const asset = (assetCcy || 'GBP').toUpperCase();

      if (!settleAbs || settleAbs <= 0) {
        return { cash_value: null, cash_ccy: null, cash_fx_to_portfolio: null };
      }

      if (asset === base) {
        const val = Math.abs(settleAbs);
        return { cash_value: val, cash_ccy: base, cash_fx_to_portfolio: 1 };
      }

      // Try cached FX for the trade date from fx_rates (quotes are like { GBPUSD: 1.29 })
      const { data: fxRow } = await supabase
        .from('fx_rates')
        .select('quotes')
        .eq('date', tradeDate)
        .single();

      const quotes = fxRow?.quotes as Record<string, number> | undefined;
      if (!quotes) return { cash_value: null, cash_ccy: null, cash_fx_to_portfolio: null };

      // Build X->GBP and GBP->Y, then X->Y
      const gbpToAsset = quotes['GBP' + asset];
      const gbpToBase = quotes['GBP' + base];

      let rate: number | null = null;
      if (asset === 'GBP' && typeof gbpToBase === 'number') {
        rate = gbpToBase; // GBP->Base
      } else if (base === 'GBP' && typeof gbpToAsset === 'number') {
        rate = 1 / gbpToAsset; // Asset->GBP
      } else if (typeof gbpToAsset === 'number' && typeof gbpToBase === 'number') {
        rate = (1 / gbpToAsset) * gbpToBase; // Asset->GBP->Base
      }

      if (rate == null || !isFinite(rate) || rate <= 0) {
        return { cash_value: null, cash_ccy: null, cash_fx_to_portfolio: null };
      }

      const cashVal = Math.abs(settleAbs * rate);
      return { cash_value: cashVal, cash_ccy: base, cash_fx_to_portfolio: cashVal / Math.abs(settleAbs) };
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
      // Cash leg: allow explicit value like importer, else fallback to qty*price+fee; cc y = portfolio base
      cash_value: newTx.cash_value != null && newTx.cash_value !== undefined && newTx.cash_value !== ('' as any)
        ? Number(newTx.cash_value)
        : (qty * price + fee),
      cash_ccy: (selectedPortfolio?.base_currency || 'GBP'),
      cash_fx_to_portfolio: newTx.fxrate != null ? Number(newTx.fxrate) : null,
      // Set settle leg in asset currency and include fee to reflect total cost/proceeds in asset ccy
      settle_value: Math.abs(settle),
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
      <div className="sticky top-0 z-20 bg-white pb-2">
        <h2 className="text-xl font-semibold mb-4">
          {portfolioFilter ? 'Transactions for Portfolio' : 'All Transactions'}
        </h2>

        {/* Add BUY/SELL inline form */}
        <div className="mb-3">
          <button
            type="button"
            className="rounded bg-black text-white px-3 py-1 text-sm"
            onClick={() => setShowAdd(s => !s)}
          >
            {showAdd ? 'Cancel' : 'Add BUY/SELL'}
          </button>
          {showAdd && (
            <div className="mt-3 border rounded p-3 bg-gray-50">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="block text-gray-600">Portfolio</span>
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
                  <span className="block text-gray-600">Ticker</span>
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
                  <span className="block text-gray-600">Type</span>
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
                  <span className="block text-gray-600">Date</span>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 text-sm"
                    value={newTx.date}
                    onChange={(e) => setNewTx(v => ({ ...v, date: e.target.value }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-gray-600">Quantity</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.quantity}
                    onChange={(e) => setNewTx(v => ({ ...v, quantity: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-gray-600">Price</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.price}
                    onChange={(e) => setNewTx(v => ({ ...v, price: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-gray-600">Fee ({selectedAsset?.currency || '—'})</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-24 text-right"
                    value={newTx.fee}
                    onChange={(e) => setNewTx(v => ({ ...v, fee: Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-gray-600">Cash Value ({selectedPortfolio?.base_currency || 'GBP'})</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-32 text-right"
                    value={newTx.cash_value ?? ''}
                    onChange={(e) => setNewTx(v => ({ ...v, cash_value: e.target.value === '' ? null : Number(e.target.value) }))}
                  />
                </label>

                <label className="text-sm">
                  <span className="block text-gray-600">FX Rate (cash_fx_to_portfolio)</span>
                  <input
                    type="number"
                    step="any"
                    className="border rounded px-2 py-1 text-sm w-28 text-right"
                    value={newTx.fxrate ?? ''}
                    onChange={(e) => setNewTx(v => ({ ...v, fxrate: e.target.value === '' ? null : Number(e.target.value) }))}
                  />
                </label>

                <label className="flex-1 text-sm min-w-[200px]">
                  <span className="block text-gray-600">Notes</span>
                  <input
                    type="text"
                    className="border rounded px-2 py-1 text-sm w-full"
                    value={newTx.notes}
                    onChange={(e) => setNewTx(v => ({ ...v, notes: e.target.value }))}
                  />
                </label>

                <button
                  type="button"
                  className="rounded bg-blue-600 text-white px-3 py-1 text-sm h-8"
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
            className="text-red-500 hover:text-red-700 text-lg px-1"
            title="Clear all filters"
          >
            ❌
          </button>
        </div>
      </div>

      <div className="overflow-x-auto max-h-[80vh] overflow-y-scroll">
        <p className="mb-2 text-sm text-gray-600">
          Showing {filteredTransactions.length} transaction{filteredTransactions.length === 1 ? '' : 's'}
          {portfolioFilter ? ` for this portfolio` : ''}
        </p>
        <table className="w-full text-sm border">
          <thead className="bg-gray-100 text-left sticky top-0 z-10">
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
              <th className="p-2">Edit</th>
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
                      onClick={() => handleEdit(tx.id)}
                      className="text-blue-500 hover:text-blue-700"
                      title="Edit"
                    >
                      <IconEdit className="inline w-6 h-6" />
                    </button>
                    <button
                      onClick={() => handleDelete(tx.id)}
                      className="text-red-500 hover:text-red-700"
                      title="Delete"
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

      {editingTx && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Edit Transaction</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm">Ticker</label>
                <select
                  value={editValues.ticker ?? editingTx.ticker ?? ''}
                  onChange={(e) =>
                    setEditValues({ ...editValues, ticker: e.target.value })
                  }
                  className="border px-2 py-1 w-full rounded font-mono"
                >
                  <option value="">-- Select Ticker --</option>
                  {tickers.map((t) => (
                    <option key={t.id} value={t.ticker}>
                      {t.ticker}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm">Type</label>
                <select
                  value={editValues.type && editValues.type !== '' ? editValues.type : editingTx.type ?? ''}
                  onChange={(e) => {
                    const val = e.target.value.toUpperCase();
                    setEditValues({ ...editValues, type: val === '' ? undefined : val });
                  }}
                  className="border px-2 py-1 w-full rounded"
                >
                  <option value="">-- Select Type --</option>
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                  <option value="TIN">Transfer In</option>
                  <option value="TOT">Transfer Out</option>
                  <option value="DIV">Dividend</option>
                  <option value="INT">Interest</option>
                  <option value="DEP">Deposit</option>
                  <option value="WIT">Withdrawal</option>
                  <option value="FEE">Fee</option>
                  <option value="SPL">Split</option>
                  <option value="OTR">Other</option>
                  <option value="BAL">Balance Adjust</option> {/* <-- Add this line */}
                </select>
              </div>

              {/* If SPL, show only Split Factor. Otherwise show qty/price/fee */}
              {(editValues.type ?? editingTx.type).toUpperCase() === 'SPL' ? (
                <div>
                  <label className="block text-sm">Split Factor</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={editValues.split_factor ?? ''}
                    onChange={(e) =>
                      setEditValues({
                        ...editValues,
                        split_factor: e.target.value === '' ? undefined : parseFloat(e.target.value),
                      })
                    }
                    className="border px-2 py-1 w-full rounded"
                    placeholder="e.g. 2 for 1 = 2, reverse 1 for 5 = 0.2"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    2-for-1 ⇒ 2.0 &nbsp;•&nbsp; 1-for-5 (reverse) ⇒ 0.2
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm">Quantity</label>
                    <input
                      type="number"
                      value={editValues.quantity ?? ''}
                      onChange={(e) =>
                        setEditValues({
                          ...editValues,
                          quantity: e.target.value === '' ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="border px-2 py-1 w-full rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-sm">Price</label>
                    <input
                      type="number"
                      value={editValues.price ?? ''}
                      onChange={(e) =>
                        setEditValues({
                          ...editValues,
                          price: e.target.value === '' ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="border px-2 py-1 w-full rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-sm">Fee ({editingAsset?.currency || editingTx?.currency || ''})</label>
                    <input
                      type="number"
                      value={editValues.fee ?? ''}
                      onChange={(e) =>
                        setEditValues({
                          ...editValues,
                          fee: e.target.value === '' ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="border px-2 py-1 w-full rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-sm">Cash Value</label>
                    <input
                      type="number"
                      value={editValues.cash_value ?? ''}
                      onChange={(e) =>
                        setEditValues({
                          ...editValues,
                          cash_value: e.target.value === '' ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="border px-2 py-1 w-full rounded"
                    />
                    <p className="text-xs text-gray-500 mt-1">Currency: set in row via cash_ccy field (optional)</p>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm">Notes</label>
                <input
                  type="text"
                  value={editValues.notes ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, notes: e.target.value })}
                  className="border px-2 py-1 w-full rounded"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setEditingTx(null)}
                className="px-4 py-2 rounded bg-gray-200 text-black hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 rounded bg-themeblue text-white hover:bg-themeblue-hover ml-2"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
