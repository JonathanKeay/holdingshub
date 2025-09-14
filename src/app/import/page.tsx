'use client';

import { useState, useRef } from 'react';
import {
  POSITIVE_BADGE,
  NEGATIVE_BADGE,
  POSITIVE_TEXT,
  NEGATIVE_TEXT,
  THEME_BLUE_TEXT,
  THEME_BLUE_BADGE,
  THEME_BLUE_DISABLED,
  THEME_BLUE_ACTIVE,
  THEME_BLUE_CHECKED,
  THEME_BLUE_DISABLED_BG,
} from '../../lib/uiColors';

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedTickers, setConfirmedTickers] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);

  type PreviewResponse = {
    message: string;
    validCount: number;
    invalidCount: number;
    newTickers: { ticker: string; name?: string }[];
    errors?: { row: number; issues: { message?: string; path?: (string|number)[] }[] }[];
  };

  const handlePreview = async () => {
    if (!file || isSubmitting) return;
    setIsSubmitting(true);
    setStatus('Previewing...');
    try {
      const form = new FormData();
      form.append('file', file);

      const res = await fetch('/api/import-transactions?stage=preview', { method: 'POST', body: form });

      // Robust JSON parsing: some server errors can return empty / non-JSON bodies.
      const text = await res.text().catch(() => '');
      let result: any = null;
      try {
        result = text ? JSON.parse(text) : null;
      } catch {
        result = { message: 'Invalid JSON response from server', raw: text };
      }

      if (!res.ok) {
        setPreview(null);
        const errMsg = result?.message ?? `HTTP ${res.status}`;
        const debug = result?.debug ? `\n${JSON.stringify(result.debug)}` : '';
        setStatus(`Preview failed: ${errMsg}${debug}`);
        return;
      }

      setPreview(result);
      setStatus(result?.message ?? 'Preview complete');
    } catch (err: any) {
      setPreview(null);
      setStatus(`Preview error: ${String(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  async function handleConfirm() {
    if (!file || isSubmitting) return;
    setIsSubmitting(true);
    setStatus('Importing...');
    try {
      const form = new FormData();
      form.append('file', file);
      // include confirmed tickers as JSON as your UI already does
      form.append('confirmedTickers', JSON.stringify(Object.keys(confirmedTickers).filter(t => confirmedTickers[t])));

      const resp = await fetch('/api/import-transactions?stage=confirm', { method: 'POST', body: form });
      const body = await resp.json().catch(() => ({ message: 'Invalid JSON response', rawStatus: resp.status }));
      if (!resp.ok) {
        // display the helpful server error + debug
        const errMsg = body?.message ?? 'Import failed';
        const detail = body?.error ? ` — ${body.error}` : '';
        const debug = body?.debug ? `\nDebug: ${JSON.stringify(body.debug)}` : '';
        setStatus(`${errMsg}${detail}${debug}`);
        setIsSubmitting(false);
        return;
      }

      setStatus(body?.message ?? 'Import succeeded');
      // reset UI state as needed
      setPreview(null);
      setFile(null);
      setConfirmedTickers({});
      // ensure native input is cleared so selecting a new (or same) file fires onChange
      if (inputRef?.current) inputRef.current.value = '';
    } catch (err: any) {
      setStatus(`Import error: ${String(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const previewDone = Boolean(preview);
  const hasFile = Boolean(file);

  // button classes driven by ui tokens -> visual states: Normal, Hover, Pressed (post-preview), Disabled
  // Normal (file selected): solid blue pill (THEME_BLUE_BADGE should include bg + text)
  // Hover: slightly darker (use hover:brightness for a universal approach)
  // Pressed (after preview): white background with blue outline and blue text
  // Disabled: pale / desaturated background with light blue text
  const disabledClasses = `${THEME_BLUE_DISABLED} px-4 py-2 rounded cursor-not-allowed`;
  const normalClasses = `${THEME_BLUE_ACTIVE} px-4 py-2 rounded transition-transform active:translate-y-[1px]`;
  const normalHover = 'hover:brightness-95';
  const postPreviewClasses = `bg-white ${THEME_BLUE_CHECKED} border border-[var(--color-themeblue)] px-4 py-2 rounded hover:bg-[var(--color-themeblue-bg)] transition`;

  const previewBtnClass = isSubmitting
    ? disabledClasses
    : !hasFile
    ? disabledClasses
    : previewDone
    ? postPreviewClasses
    : `${normalClasses} ${normalHover}`;

  return (
    <main className="max-w-xl mx-auto p-6">
      <h1 className={`text-2xl font-bold mb-4 ${THEME_BLUE_TEXT}`}>Import Transactions</h1>

      {/* nicer file chooser: hidden input + visible button + full filename display (tooltip) */}
      <div className="mb-4">
        <input
          id="import-file-input"
          ref={inputRef}
          type="file"
          accept=".csv"
          onChange={(e) => {
            const f = e.target.files?.[0] || null;
            setFile(f);
            setPreview(null);
            // keep the DOM input value set so user can re-select same file if they clear it explicitly
          }}
          className="sr-only"
        />

        <label htmlFor="import-file-input" className={`${THEME_BLUE_ACTIVE} inline-flex items-center gap-3 cursor-pointer px-4 py-2 rounded`}>
          <span>Choose File</span>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </label>

        <div className="mt-2 flex items-center gap-3">
          {file ? (
            <>
              {/* show full filename with tooltip; allow wrapping or horizontal scroll */}
              <div
                title={file.name}
                className="text-sm text-gray-700 max-w-full break-words"
                style={{ wordBreak: 'break-all' }}
              >
                {file.name}
              </div>
              <button
                type="button"
                onClick={() => {
                  // clear internal state and reset native file input so a subsequent selection (even same filename) will fire onChange
                  setFile(null);
                  setPreview(null);
                  if (inputRef?.current) {
                    inputRef.current.value = '';
                  }
                }}
                className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1"
                aria-label="Clear selected file"
              >
                Change
              </button>
            </>
          ) : (
            <div className="text-sm text-gray-500">No file selected</div>
          )}
        </div>
      </div>

      <div className="space-x-2">
        <button
          onClick={handlePreview}
          className={previewBtnClass}
          disabled={!file || isSubmitting}
        >
          Preview Import
        </button>

        {preview && preview.validCount > 0 && (
          <button
            onClick={handleConfirm}
            className={`${normalClasses} ${normalHover} disabled:opacity-50`}
            disabled={isSubmitting}
          >
            Confirm & Import
          </button>
        )}
      </div>

      {status && <p className={`mt-4 text-sm ${THEME_BLUE_TEXT}`}>{status}</p>}

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
              <h3 className="font-semibold mb-1">New Tickers: (please tick to confirm addition)</h3>
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

          {preview.errors && preview.errors.length > 0 && (
            <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
              <div className="font-semibold mb-2">Sample validation errors (first {Math.min(10, preview.errors.length)}):</div>
              <ul className="list-inside list-disc space-y-1">
                {preview.errors.slice(0, 10).map((e) => (
                  <li key={e.row}>
                    Row {e.row}: {e.issues.map((iss) => iss.message ?? JSON.stringify(iss)).join('; ')}
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
