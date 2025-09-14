'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { processBalanceAction } from './actions';
import { usePathname } from 'next/navigation';
import { startTransition } from 'react';


type Ccy = 'GBP' | 'USD' | 'EUR';
type Portfolio = { id: string; name: string; base_currency?: Ccy | null };

const initial = { ok: false } as any;
const STORAGE_KEY = 'cash-balance-form-v1';

// Debounce helper
function useDebouncedEffect(effect: () => void, deps: any[], delay: number) {
  React.useEffect(() => {
    const handler = setTimeout(effect, delay);
    return () => clearTimeout(handler);
    // eslint-disable-next-line
  }, [...deps, delay]);
}

export default function CashBalanceToolClient({ portfolios }: { portfolios: Portfolio[] }) {
  const [localState, setState] = React.useState(initial);
  const [state, formAction] = useActionState(processBalanceAction, initial);
  const pathname = usePathname();

  // Keep portfolio ID and name stable separately
  const [selectedPortfolioId, setSelectedPortfolioId] = React.useState('');

  const [form, setForm] = React.useState({
    as_of: '',
    target: '',
    ccy: 'GBP' as Ccy,
    mode: 'pre' as 'pre' | 'post',
    note: '',
  });

  /* // --- ADD THIS DEBUG LOG HERE ---
  const derivedPortfolioName =
    (typeof state?.portfolio_name === 'string' && state.portfolio_name.length > 0)
      ? state.portfolio_name
      : (portfolios.find((p) => p.id === selectedPortfolioId)?.name || ''); 

  console.log('selectedPortfolioId:', selectedPortfolioId);
  console.log('state.portfolio_id:', state?.portfolio_id);
  console.log('state.portfolio_name:', state?.portfolio_name);
  console.log('portfolios:', portfolios, 'selectedPortfolioId:', selectedPortfolioId);
  console.log('derivedPortfolioName:', derivedPortfolioName);
  console.log('CashBalanceToolClient mounted'); */

  // Load from localStorage
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setForm({
          as_of: parsed.as_of || '',
          target: parsed.target || '',
          ccy: parsed.ccy || 'GBP',
          mode: parsed.mode || 'pre',
          note: parsed.note || '',
        });
        if (parsed.portfolio_id) {
          setSelectedPortfolioId(parsed.portfolio_id);
          const foundName = portfolios.find((p) => p.id === parsed.portfolio_id)?.name || '';
        }
      }
    } catch {}
  }, [portfolios]);

  // Save to localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          portfolio_id: selectedPortfolioId,
          ...form,
        })
      );
    } catch {}
  }, [form, selectedPortfolioId]);

  // Sync from server action result
  React.useEffect(() => {
    if (!state || (state.phase !== 'preview' && state.phase !== 'done')) return;

    // Only update if backend returns a non-empty portfolio_id
    if (typeof state.portfolio_id === 'string' && state.portfolio_id.length > 0) {
      setSelectedPortfolioId(state.portfolio_id);
    }

    // Update other form fields
    setForm((prev) => ({
      ...prev,
      as_of: state.asOf ?? prev.as_of,
      target: state.target != null ? String(state.target) : prev.target,
      ccy: (state.ccy as Ccy) ?? prev.ccy,
      mode: typeof state.mode === 'string' ? (state.mode as 'pre' | 'post') : prev.mode,
    }));
  }, [state?.phase, state?.portfolio_id, state?.portfolio_name]);


  const resetForm = () => {
    setSelectedPortfolioId('');
    setForm({ as_of: '', target: '', ccy: 'GBP', mode: 'pre', note: '' });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  };
  // Reset form and selected portfolio on mount
  React.useEffect(() => {
    setSelectedPortfolioId('');
    setForm({ as_of: '', target: '', ccy: 'GBP', mode: 'pre', note: '' });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, [pathname]);

  React.useEffect(() => {
    const handler = () => resetForm();
    window.addEventListener('reset-cash-balance-form', handler);
    return () => window.removeEventListener('reset-cash-balance-form', handler);
  }, []);

  // Automatically re-preview when form changes in preview mode
  useDebouncedEffect(() => {
    if (state?.phase === 'preview') {
      const formData = new FormData();
      formData.set('portfolio_id', selectedPortfolioId);
      formData.set('as_of', form.as_of);
      formData.set('target', form.target);
      formData.set('ccy', form.ccy);
      formData.set('mode', form.mode);
      formData.set('note', form.note);

      // ✅ safe to call here
      startTransition(() => {
        formAction(formData);
      });
    }
  }, [form, selectedPortfolioId], 400); // 400ms debounce

  // Find the base currency of the selected portfolio
  const portfolioBaseCurrency = React.useMemo(() => {
    const foundPortfolio = portfolios.find((p) => p.id === selectedPortfolioId);
    return foundPortfolio?.base_currency ?? 'GBP';
  }, [portfolios, selectedPortfolioId]);

  return (
    <main className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Cash Balance Adjustment</h1>
        <button type="button" onClick={resetForm} className="text-sm text-gray-600 underline">
          Reset form
        </button>
      </div>

      {state?.phase === 'done' && (
        <div className="p-3 rounded bg-green-50 border border-green-200">{state.message}</div>
      )}
      {state?.phase === 'error' && (
        <div className="p-3 rounded bg-red-50 border border-red-200">{state.message}</div>
      )}

      {/* <div style={{fontSize: 12, color: '#888'}}>DEBUG: state.phase = {String(state?.phase)}</div> */}

      <form id="cash-balance-form" action={formAction} className="space-y-3 border p-4 rounded">
        <input type="hidden" name="portfolio_id" value={selectedPortfolioId} />
        <input type="hidden" name="as_of" value={form.as_of} />
        <input type="hidden" name="target" value={form.target} />
        <input type="hidden" name="ccy" value={form.ccy} />
        <input type="hidden" name="mode" value={form.mode} />
        <input type="hidden" name="note" value={form.note} />

        <label className="block">
          <span className="text-sm">Portfolio</span>
          <select
            suppressHydrationWarning
            required
            className="w-full border p-2 rounded"
            value={selectedPortfolioId}
            onChange={(e) => setSelectedPortfolioId(e.target.value)}
          >
            <option value="">— select —</option>
            {portfolios.map((p) => {
              console.log('option', p.id, p.name, selectedPortfolioId === p.id);
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              );
            })}
          </select>
        </label>

        <label className="block">
          <span className="text-sm">As of date</span>
          <input
            type="date"
            required
            className="w-full border p-2 rounded"
            value={form.as_of}
            onChange={(e) => setForm((s) => ({ ...s, as_of: e.target.value }))}
          />
        </label>

        <label className="block">
          <span className="text-sm">Known cash balance</span>
          <input
            type="text"
            required
            placeholder="e.g. 38578.64"
            className="w-full border p-2 rounded"
            value={form.target}
            onChange={(e) => setForm((s) => ({ ...s, target: e.target.value }))}
          />
        </label>

        <div className="block">
          <span className="text-sm">Currency</span>
          <div className="p-2">{portfolioBaseCurrency}</div>
        </div>

        <div className="flex gap-3 items-center">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={form.mode === 'pre'}
              onChange={() => setForm((s) => ({ ...s, mode: 'pre' }))}
            />
            <span>Pre-trade (exclude same-day)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={form.mode === 'post'}
              onChange={() => setForm((s) => ({ ...s, mode: 'post' }))}
            />
            <span>Post-trade (include same-day)</span>
          </label>
        </div>

        <label className="block">
          <span className="text-sm">Notes (optional)</span>
          <input
            type="text"
            placeholder="e.g. Month-end reconciliation"
            className="w-full border p-2 rounded"
            value={form.note}
            onChange={(e) => setForm((s) => ({ ...s, note: e.target.value }))}
          />
        </label>

        {state?.phase !== 'preview' && (
          <div className="flex gap-2">
            <button type="submit" name="intent" value="preview" className="px-4 py-2 rounded border">
              Preview
            </button>
          </div>
)}
      </form>

      {/* Same-day transactions appear here */}
      {state?.phase === 'preview' && (
        <section className="border rounded p-4 space-y-6 mt-4">
          {/* Same-day transactions, if any */}
          {state.sameDaySummary?.length > 0 && (
            <div>
              <h3 className="font-medium mb-1 text-xs">Same-day transactions</h3>
              <table className="w-full text-xs mb-4">
                <thead>
                  <tr>
                    <th className="text-left px-2 py-1">Date</th>
                    <th className="text-left px-2 py-1">Type</th>
                    <th className="text-left px-2 py-1">Ticker</th>
                    <th className="text-right px-2 py-1">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {state.sameDaySummary.map((row: any, idx: number) => (
                    <tr key={idx} className="odd:bg-white even:bg-gray-50">
                      <td className="px-2 py-1">
                        {row.date || row.txn_date || row.trade_date
                          ? new Date(row.date || row.txn_date || row.trade_date).toLocaleDateString('en-GB')
                          : '-'}
                      </td>
                      <td className="px-2 py-1">{row.type}</td>
                      <td className="px-2 py-1">{row.ticker || '-'}</td>
                      <td className="px-2 py-1 text-right">
                        {new Intl.NumberFormat('en-GB', {
                          style: 'currency',
                          currency: state.ccy
                        }).format(row.day_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Balances summary */}
          <div>
            <h3 className="font-medium mb-2 text-xs">
              Balances (as at {state.asOf ? new Date(state.asOf).toLocaleDateString('en-GB') : '-'})
            </h3>
            <div className="flex gap-4">
              <div className="flex-1 bg-gray-100 rounded p-3 text-center">
                <div className="text-lg font-bold">
                  {typeof state.current === 'number'
                    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.ccy }).format(state.current)
                    : '—'}
                </div>
                <div className="text-xs text-gray-600 mt-1">System Balance</div>
              </div>
              <div className="flex-1 bg-gray-100 rounded p-3 text-center">
                <div className="text-lg font-bold">
                  {typeof state.target === 'number'
                    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.ccy }).format(state.target)
                    : (typeof state.target === 'string' && state.target ? state.target : '—')}
                </div>
                <div className="text-xs text-gray-600 mt-1">Target Balance</div>
              </div>
              <div className="flex-1 bg-gray-100 rounded p-3 text-center">
                <div className={
                  "text-lg font-bold " +
                  (typeof state.diff === 'number'
                    ? state.diff < 0
                      ? "text-red-600"
                      : state.diff > 0
                        ? "text-blue-600"
                        : ""
                    : "")
                }>
                  {typeof state.diff === 'number'
                    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.ccy }).format(state.diff)
                    : '—'}
                </div>
                <div className="text-xs text-gray-600 mt-1">Difference</div>
              </div>
            </div>
          </div>

          {/* Balancing Transaction Preview */}
          <div>
            <h3 className="font-medium mb-1 text-xs mt-4">Balancing Transaction Preview</h3>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1">Date</th>
                  <th className="text-left px-2 py-1">Type</th>
                  <th className="text-left px-2 py-1">Ticker</th>
                  <th className="text-right px-2 py-1">Amount</th>
                  <th className="text-left px-2 py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr className="odd:bg-white even:bg-gray-50">
                  <td className="px-2 py-1">{state.asOf ? new Date(state.asOf).toLocaleDateString('en-GB') : '-'}</td>
                  <td className="px-2 py-1">BAL</td>
                  <td className="px-2 py-1">{state.ccy ? `CASH.${state.ccy}` : '-'}</td>
                  <td className="px-2 py-1 text-right">
                    {typeof state.diff === 'number'
                      ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.ccy }).format(state.diff)
                      : '—'}
                  </td>
                  <td className="px-2 py-1">{form.note || '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Confirm button at top right */}
          <div className="flex justify-end mt-4">
            <button
              type="submit"
              form="cash-balance-form"
              name="intent"
              value="confirm"
              className="px-4 py-2 rounded bg-emerald-600 text-white"
            >
              Confirm &amp; Insert BAL
            </button>
          </div>
        </section>
)}
    </main>
  );
}
