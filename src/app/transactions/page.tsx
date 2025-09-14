'use client';

import { useEffect, useState } from 'react';
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
  gbp_value: number;
  notes: string;
  ticker: string;
  portfolio_name: string;
  currency: string;
  split_factor?: number | null; // used for SPL only
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

  const [tickers, setTickers] = useState<{ id: string; ticker: string }[]>([]);

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
        .select('id, ticker')
        .order('ticker', { ascending: true });
      if (!error && data) setTickers(data);
    }
    fetchTickers();
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
        id, date, type, quantity, price, fee, gbp_value, notes, split_factor,
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
      gbp_value: Number(t.gbp_value ?? 0),
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
        gbp_value: tx.gbp_value,
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

  return (
    <section className="p-4 max-w-6xl mx-auto">
      <div className="sticky top-0 z-20 bg-white pb-2">
        <h2 className="text-xl font-semibold mb-4">
          {portfolioFilter ? 'Transactions for Portfolio' : 'All Transactions'}
        </h2>

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
              <th className="p-2 text-right">GBP Value</th>
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
                  {tx.type === 'SPL' ? '—' : formatCurrency(tx.fee, 'GBP')}
                </td>

                <td className="p-2 text-right">
                  {formatCurrency(tx.gbp_value, 'GBP')}
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
                    <label className="block text-sm">Fee</label>
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
                    <label className="block text-sm">GBP Value</label>
                    <input
                      type="number"
                      value={editValues.gbp_value ?? ''}
                      onChange={(e) =>
                        setEditValues({
                          ...editValues,
                          gbp_value: e.target.value === '' ? undefined : parseFloat(e.target.value),
                        })
                      }
                      className="border px-2 py-1 w-full rounded"
                    />
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
