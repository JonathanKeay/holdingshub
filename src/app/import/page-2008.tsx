'use client';

import { useState } from 'react';

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedTickers, setConfirmedTickers] = useState<Record<string, boolean>>({});
  const [intent, setIntent] = useState<'preview' | 'import' | null>(null);

  type PreviewResponse = {
    message: string;
    validCount: number;
    invalidCount: number;
    newTickers: { ticker: string; name?: string }[];
  };

  const handlePreview = async () => {
    if (!file) return;

    setStatus('Parsing and validating CSV...');
    setPreview(null);
    setConfirmedTickers({});

    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/import-transactions?stage=preview', {
      method: 'POST',
      body: formData,
    });

    const result = await res.json();

    if (res.ok) {
      setPreview(result);
      setConfirmedTickers(
        result.newTickers.reduce((acc: Record<string, boolean>, t: { ticker: string }) => {
          acc[t.ticker] = true;
          return acc;
        }, {})
      );
      setStatus(null);
    } else {
      setStatus(result.message || 'Error during preview');
    }
  };

  const handleConfirm = async () => {
    if (!file) return;
    setIsSubmitting(true);
    setStatus('Importing confirmed transactions...');

    const confirmed = Object.entries(confirmedTickers)
      .filter(([_, v]) => v)
      .map(([k]) => k);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('confirmedTickers', JSON.stringify(confirmed));

    const res = await fetch('/api/import-transactions?stage=confirm', {
      method: 'POST',
      body: formData,
    });

    const result = await res.json();
    setIsSubmitting(false);

    if (res.ok) {
      setPreview(null);
      setStatus(result.message || 'Import complete');
      setFile(null);
    } else {
      setStatus(result.message || 'Import failed');
    }
  };

  return (
    <main className="max-w-xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Import Transactions</h1>

      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        className="mb-4"
      />

      <div className="space-x-2">
        <button
          type="button"
          onClick={handlePreview}
          className="px-4 py-2 rounded bg-themeblue text-white hover:bg-themeblue-hover"
        >
          Preview
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="px-4 py-2 rounded bg-tgreen text-white hover:bg-tgreen-hover"
          disabled={isSubmitting}
        >
          Confirm & Import
        </button>
      </div>

      {status && <p className="mt-4 text-sm text-gray-600">{status}</p>}

      {preview && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-2">Preview Summary</h2>
          <ul className="list-disc list-inside text-sm space-y-1">
            <li>✅ Valid transactions: {preview.validCount}</li>
            <li>🚫 Invalid rows: {preview.invalidCount}</li>
            <li>📢 New tickers to confirm: {preview.newTickers.length}</li>
          </ul>

          {preview.newTickers.length > 0 && (
            <div className="mt-4">
              <h3 className="font-semibold mb-1">New Tickers:</h3>
              <ul className="list-none pl-2">
                {preview.newTickers.map(({ ticker, name }) => (
                  <li key={ticker} className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={confirmedTickers[ticker] || false}
                      onChange={(e) =>
                        setConfirmedTickers((prev) => ({
                          ...prev,
                          [ticker]: e.target.checked,
                        }))
                      }
                    />
                    <label>{ticker} {name && <span className="text-sm text-gray-500">({name})</span>}</label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
