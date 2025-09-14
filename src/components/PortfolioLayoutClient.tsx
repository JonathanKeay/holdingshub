'use client';

import * as React from 'react';
import { THEME_BLUE_TEXT, THEME_BLUE_DISABLED_BG } from '@/lib/uiColors';

type Portfolio = { id: string; name: string };

const ORDER_KEY = 'portfolio-order-v1';
const HIDDEN_KEY = 'portfolio-hidden-v1';

// --- Button styles (mirroring your Import page look) ---
const BTN_BASE =
  'inline-flex items-center rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const BTN_SM = 'text-xs px-3 py-1.5';
const BTN_MD = 'text-sm px-3.5 py-2';

// Primary = solid theme blue
const BTN_PRIMARY =
  'bg-themeblue text-white border border-themeblue-hover hover:bg-themeblue-hover shadow-sm focus-visible:ring-themeblue';

// Ghost = outlined with theme blue text
const BTN_GHOST =
  `${THEME_BLUE_TEXT} border border-themeblue-hover hover:bg-Thoverlight-tint focus-visible:ring-themeblue`;

// --- Cloud sync helpers (safe no-ops if API isn't wired yet) ---
async function fetchCloud(): Promise<{ order: string[]; hidden: string[] } | null> {
  try {
    const res = await fetch('/api/portfolio-prefs', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      order: Array.isArray(data?.order) ? data.order : [],
      hidden: Array.isArray(data?.hidden) ? data.hidden : [],
    };
  } catch {
    return null;
  }
}

async function saveCloud(payload: { order: string[]; hidden: string[] }) {
  try {
    await fetch('/api/portfolio-prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore—offline or API not present
  }
}

export default function PortfolioLayoutClient({ portfolios }: { portfolios: Portfolio[] }) {
  const [order, setOrder] = React.useState<string[]>([]);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [filter, setFilter] = React.useState<'all' | 'visible' | 'hidden'>('all');
  const [ready, setReady] = React.useState(false);

  // --- helpers ---
  const naturalIds = React.useMemo(() => portfolios.map((p) => p.id), [portfolios]);

  const mergeWithNatural = React.useCallback(
    (ids: string[] | undefined) =>
      (Array.isArray(ids) && ids.length
        ? ids.filter((id) => naturalIds.includes(id)).concat(naturalIds.filter((id) => !ids.includes(id)))
        : naturalIds),
    [naturalIds]
  );

  const readPrefs = React.useCallback(() => {
    try {
      const savedOrder = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      const savedHidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');

      setOrder(mergeWithNatural(savedOrder));
      setHidden(new Set(Array.isArray(savedHidden) ? savedHidden : []));
    } catch {
      setOrder(naturalIds);
      setHidden(new Set());
    }
  }, [mergeWithNatural, naturalIds]);

  const writeOrder = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      setOrder((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: string[]) => string[])(prev) : next;
        try {
          localStorage.setItem(ORDER_KEY, JSON.stringify(resolved));
        } catch {}
        return resolved;
      });
    },
    []
  );

  const writeHidden = React.useCallback((next: Set<string>) => {
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(next)));
    } catch {}
  }, []);

  // initial load from local + refresh on portfolio list changes
  React.useEffect(() => {
    readPrefs();
  }, [readPrefs]);

  // one-time: try cloud, then sync local/state if available
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portfolio-prefs', { cache: 'no-store' });
        if (!res.ok) throw new Error('fetch failed');
        const cloud = await res.json();
        if (cancelled) return;
        const natural = portfolios.map((p) => p.id);
        const mergedOrder = (cloud.order ?? [])
          .filter((id: string) => natural.includes(id))
          .concat(natural.filter((id) => !(cloud.order ?? []).includes(id)));
        const mergedHidden = Array.isArray(cloud.hidden) ? cloud.hidden : [];
        setOrder(mergedOrder);
        setHidden(new Set(mergedHidden));
        localStorage.setItem(ORDER_KEY, JSON.stringify(mergedOrder));
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(mergedHidden));
        setReady(true);
      } catch {
        // fallback to local
        const savedOrder = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
        const savedHidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
        const natural = portfolios.map((p) => p.id);
        const mergedOrder =
          Array.isArray(savedOrder) && savedOrder.length
            ? savedOrder.filter((id: string) => natural.includes(id))
                .concat(natural.filter((id) => !savedOrder.includes(id)))
            : natural;
        setOrder(mergedOrder);
        setHidden(new Set(Array.isArray(savedHidden) ? savedHidden : []));
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [portfolios]);

  // keep in sync when returning to the page or when another tab updates it
  React.useEffect(() => {
    const onFocus = () => readPrefs();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') readPrefs();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === ORDER_KEY || e.key === HIDDEN_KEY || e.key === null) readPrefs();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, [readPrefs]);

  // Autosave to cloud when order/hidden change (debounced, after initial load)
  const prevJsonRef = React.useRef<string>('');
  const debounceRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!ready) return;
    const payload = { order, hidden: Array.from(hidden) };
    const json = JSON.stringify(payload);
    if (prevJsonRef.current === json) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        await fetch('/api/portfolio-prefs', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: json,
        });
        prevJsonRef.current = json;
      } catch {
        // ignore network errors; will retry on next change
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [order, hidden, ready]);

  // --- actions ---
  function move(id: string, dir: -1 | 1) {
    writeOrder((curr) => {
      const i = curr.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= curr.length) return curr;
      const next = curr.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function toggleHidden(id: string) {
    const isCurrentlyHidden = hidden.has(id);
    const next = new Set(hidden);
    if (isCurrentlyHidden) {
      // unhide: keep current position
      next.delete(id);
      writeHidden(next);
    } else {
      // hide: move to bottom and persist
      next.add(id);
      writeHidden(next);
      writeOrder((curr) => {
        const idx = curr.indexOf(id);
        if (idx < 0) return curr;
        const out = curr.slice();
        out.splice(idx, 1);
        out.push(id);
        return out;
      });
    }
  }

  function reset() {
    writeOrder(naturalIds);
    writeHidden(new Set());
  }

  const rows = order
    .map((id) => portfolios.find((p) => p.id === id)!)
    .filter((p) => {
      if (filter === 'visible') return !hidden.has(p.id);
      if (filter === 'hidden') return hidden.has(p.id);
      return true;
    });

  return (
    <div className="space-y-4">
      {/* Controls (autosave, no Save button) */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-sm">
            View:{' '}
            <select
              className="border rounded px-2 py-1 text-sm"
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
            >
              <option value="all">All</option>
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <button
            className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_MD}`}
            onClick={reset}
            title="Restore natural order & unhide all"
          >
            Reset
          </button>
        </div>
      </div>

      {/* List */}
      <div className="space-y-2">
        {rows.map((p) => {
          const isHidden = hidden.has(p.id);
          const index = order.indexOf(p.id);
          return (
            <div
              key={p.id}
              className={`flex items-center justify-between border rounded px-3 py-2 ${isHidden ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-6 text-center text-gray-400">{index + 1}</div>
                <div className="font-medium">{p.name}</div>
                {isHidden && <span className="ml-2 text-xs text-gray-500">(hidden)</span>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  className={`${BTN_BASE} ${BTN_GHOST} ${BTN_SM}`}
                  onClick={() => move(p.id, -1)}
                  aria-label="Move up"
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  className={`${BTN_BASE} ${BTN_GHOST} ${BTN_SM}`}
                  onClick={() => move(p.id, 1)}
                  aria-label="Move down"
                  title="Move down"
                >
                  ▼
                </button>
                <button
                  className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_SM} w-20 justify-center`}
                  onClick={() => toggleHidden(p.id)}
                >
                  {isHidden ? 'Unhide' : 'Hide'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={`${THEME_BLUE_DISABLED_BG} rounded px-3 py-2 text-xs text-gray-600`}>
        Changes are saved automatically on this device and also synced to your account if available.
      </div>
    </div>
  );
}
