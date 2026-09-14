'use client';

import { useState, useEffect } from 'react';
// Cookie-aware client for the read-only search below (assets SELECT is open
// to any authenticated user). The actual write goes through
// /api/assets/edit instead of a direct table write — `assets` is shared
// reference data and ordinary authenticated users no longer have direct
// INSERT/UPDATE/DELETE grants on it; see that route for why.
import { supabaseBrowser as supabase } from '@/lib/supabase/browser';

type AssetRow = {
  id: string;
  ticker: string;
  resolved_ticker: string | null;
  name: string | null;
  status: string | null;
  delisted_at: string | null;
  price_multiplier: number | null;
  domain: string | null;
};

type AliasRow = {
  id: string;
  alias: string;
};

export default function EditAssetPage() {
  const [ticker, setTicker] = useState('');
  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [resolvedTicker, setResolvedTicker] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [delistedAt, setDelistedAt] = useState('');
  const [priceMultiplier, setPriceMultiplier] = useState('');
  // Corporate domain — used by the existing Logo.dev proxy (see
  // /api/logo-proxy) to fetch the company logo. Deliberately editing this
  // instead of the raw logo_url column: the server normalises whatever's
  // typed here (a bare domain or a full URL) and keeps assets.logo_url in
  // sync automatically. See /api/assets/edit's PATCH handler.
  const [domain, setDomain] = useState('');
  const [message, setMessage] = useState('');
  // Import aliases for the asset currently loaded (e.g. eToro's "CAKE.US"
  // resolving to canonical "CAKE") — see /api/asset-aliases and
  // src/lib/assetResolution.ts.
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [newAlias, setNewAlias] = useState('');
  const [aliasMessage, setAliasMessage] = useState('');

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
        setPriceMultiplier('');
        setDomain('');
        setAliases([]);
        setNewAlias('');
        setAliasMessage('');
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadAliases = async (assetId: string) => {
    const { data, error } = await supabase
      .from('asset_aliases')
      .select('id, alias')
      .eq('asset_id', assetId)
      .order('alias');
    if (error) {
      console.error('Supabase alias load error:', error);
      return;
    }
    setAliases((data ?? []) as AliasRow[]);
  };

  const handleSearch = async () => {
    setMessage('Searching...');
    setAliasMessage('');
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
      setAliases([]);
    } else if (!data) {
      setMessage('Asset not found');
      setAsset(null);
      setAliases([]);
    } else {
      setMessage('');
      setAsset(data as AssetRow);
      setResolvedTicker(data.resolved_ticker ?? '');
      setName(data.name ?? '');
      setStatus(data.status ?? '');
      setDelistedAt(data.delisted_at ?? '');
      setPriceMultiplier(String(data.price_multiplier ?? ''));
      setDomain(data.domain ?? '');
      await loadAliases(data.id);
    }
  };

  const handleAddAlias = async () => {
    if (!asset?.id || !newAlias.trim()) return;
    setAliasMessage('Adding...');
    try {
      const res = await fetch('/api/asset-aliases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset_id: asset.id, alias: newAlias }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAliasMessage(body?.error ?? 'Failed to add alias');
        return;
      }
      setNewAlias('');
      setAliasMessage('');
      await loadAliases(asset.id);
    } catch (err) {
      console.error('Add alias error:', err);
      setAliasMessage('Failed to add alias');
    }
  };

  const handleRemoveAlias = async (id: string) => {
    if (!asset?.id) return;
    setAliasMessage('Removing...');
    try {
      const res = await fetch('/api/asset-aliases', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAliasMessage(body?.error ?? 'Failed to remove alias');
        return;
      }
      setAliasMessage('');
      await loadAliases(asset.id);
    } catch (err) {
      console.error('Remove alias error:', err);
      setAliasMessage('Failed to remove alias');
    }
  };

  const handleUpdate = async () => {
    if (!asset?.id) {
      setMessage('Missing asset ID');
      return;
    }

    const priceMultiplierNum = priceMultiplier.trim() === '' ? null : Number(priceMultiplier);
    if (priceMultiplierNum !== null && !Number.isFinite(priceMultiplierNum)) {
      setMessage('Invalid price multiplier');
      return;
    }

    const updatePayload = {
      id: asset.id,
      name: name.trim() || null,
      resolved_ticker: resolvedTicker.trim() || null,
      status: status || 'active',
      delisted_at: delistedAt || null,
      price_multiplier: priceMultiplierNum,
      domain: domain.trim() || null,
    };

    try {
      const res = await fetch('/api/assets/edit', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('Asset update error:', body);
        setMessage(typeof body?.error === 'string' ? body.error : 'Update failed');
        return;
      }
      setMessage('Asset updated successfully');
    } catch (err) {
      console.error('Asset update error:', err);
      setMessage('Update failed');
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
          className="mt-2 px-4 py-2 bg-themeblue text-white rounded hover:bg-themeblue-hover"
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
            <label className="block font-medium mb-1">
              Import Aliases <span className="font-normal text-sm text-foreground/60">(other symbols that mean this asset, e.g. a broker&apos;s &quot;CAKE.US&quot; for this ticker)</span>
            </label>
            {aliases.length > 0 && (
              <ul className="mb-2 space-y-1">
                {aliases.map((a) => (
                  <li key={a.id} className="flex items-center justify-between border p-2 rounded">
                    <span>{a.alias}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAlias(a.id)}
                      className="text-sm text-tred hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. CAKE.US"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                className="border p-2 flex-1"
              />
              <button
                type="button"
                onClick={handleAddAlias}
                className="px-4 py-2 bg-themeblue text-white rounded hover:bg-themeblue-hover"
              >
                Add
              </button>
            </div>
            {aliasMessage && <p className="mt-1 text-sm text-tred">{aliasMessage}</p>}
          </div>
          <div>
            <label className="block font-medium">Corporate Domain</label>
            <input
              type="text"
              placeholder="e.g. shopify.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="border p-2 w-full"
            />
            <p className="mt-1 text-sm text-foreground/60">
              Used to fetch the company logo. You can paste a full address (e.g. https://www.shopify.com/) — it will be normalised automatically. Leave blank to clear it.
            </p>
          </div>
          <div>
            <label className="block font-medium">Price Multiplier</label>
            <input
              type="number"
              inputMode="decimal"
              step="0.0001"
              placeholder="1 (or 0.01 for GBp→GBP)"
              value={priceMultiplier}
              onChange={(e) => setPriceMultiplier(e.target.value)}
              className="border p-2 w-full"
            />
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
            className="px-4 py-2 bg-tgreen text-white rounded hover:bg-tgreen-hover"
          >
            Save Changes
          </button>
        </div>
      )}

      {message && (
        <p className={`mt-4 text-sm ${message.includes('success') ? 'text-tgreen' : 'text-tred'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
