'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function EditAssetPage() {
  const [ticker, setTicker] = useState('');
  const [asset, setAsset] = useState<any>(null);
  const [resolvedTicker, setResolvedTicker] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [delistedAt, setDelistedAt] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (message === 'Asset updated successfully') {
      const timer = setTimeout(() => {
        setMessage('');
        setTicker('');
        setAsset(null);
        setResolvedTicker('');
        setName('');
        setStatus('');
        setDelistedAt('');
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleSearch = async () => {
    setMessage('Searching...');
    const symbol = ticker.trim().toUpperCase();

    const { data, error } = await supabase
      .from('assets')
      .select('*')
      .eq('ticker', symbol)
      .maybeSingle();

    if (error) {
      console.error('Supabase search error:', { symbol, error });
      setMessage('Error searching for asset');
      setAsset(null);
    } else if (!data) {
      setMessage('Asset not found');
      setAsset(null);
    } else {
      setMessage('');
      setAsset(data);
      setResolvedTicker(data.resolved_ticker ?? '');
      setName(data.name ?? '');
      setStatus(data.status ?? '');
      setDelistedAt(data.delisted_at ?? '');
    }
  };

  const handleUpdate = async () => {
    if (!asset?.id) {
      setMessage('Missing asset ID');
      return;
    }

    const updatePayload = {
      name: name.trim() || null,
      resolved_ticker: resolvedTicker.trim() || null,
      status: status || 'active',
      delisted_at: delistedAt || null,
      last_failed_resolved_ticker: null,
      resolution_attempted_at: null,
    };

    const { data, error } = await supabase
      .from('assets')
      .update(updatePayload)
      .eq('id', asset.id)
      .select();

    if (error) {
      console.error('❌ Supabase update error:', error);
      setMessage('Update failed');
    } else {
      setMessage('Asset updated successfully');
    }
  };

  return (
    <div className="p-4 max-w-xl mx-auto">
      <h1 className="text-xl font-bold mb-4">Edit Asset</h1>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Enter ticker symbol (e.g. HVO)"
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          className="border p-2 w-full"
        />
        <button
          onClick={handleSearch}
          className="mt-2 px-4 py-2 bg-blue-500 text-white rounded"
        >
          Search
        </button>
      </div>

      {asset && (
        <div className="space-y-4">
          <div>
            <label className="block font-medium">Asset Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border p-2 w-full"
            />
          </div>
          <div>
            <strong>Ticker:</strong> {asset.ticker}
          </div>
          <div>
            <label className="block font-medium">Resolved Ticker</label>
            <input
              type="text"
              value={resolvedTicker}
              onChange={(e) => setResolvedTicker(e.target.value)}
              className="border p-2 w-full"
            />
          </div>
          <div>
            <label className="block font-medium">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="border p-2 w-full"
            >
              <option value="">(Select)</option>
              <option value="active">Active</option>
              <option value="delisted">Delisted/Liquidated</option>
              <option value="acquired">Acquired</option>
              <option value="inactive">Inactive</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div>
            <label className="block font-medium">Delisted At</label>
            <input
              type="date"
              value={delistedAt}
              onChange={(e) => setDelistedAt(e.target.value)}
              className="border p-2 w-full"
            />
          </div>
          <button
            onClick={handleUpdate}
            className="px-4 py-2 bg-green-600 text-white rounded"
          >
            Save Changes
          </button>
        </div>
      )}

      {message && (
        <p className={`mt-4 text-sm ${message.includes('success') ? 'text-green-600' : 'text-red-500'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
