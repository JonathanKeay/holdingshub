'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import type { Holding } from '@/lib/queries';
import { formatCurrency } from '@/lib/formatCurrency';
// Mobile badges per spec
// - Red text #c62828 on background #ca9e9e
// - Green badge uses background #2e7d32 with white text
const BADGE_POS = 'inline-block rounded px-1 font-bold text-white bg-[var(--color-tgreen-badge-bg)]';
const BADGE_NEG = 'inline-block rounded px-1 font-bold text-tred bg-[var(--color-tred-badge-bg)]';

type PriceMap = Record<string, { price: number; previous_close?: number; price_multiplier: number }>; 

type SeriesPoint = { date: string; value_gbp: number };

type Props = {
  holdings: Holding[];
  prices: PriceMap;
  fxRates: Record<string, number>; // map from asset currency to GBP rate
  cashGBP?: number; // total cash to include in header total
  initialSeries?: SeriesPoint[];
};

type SortKey =
  | 'alphabetical'
  | 'highestHoldings'
  | 'lowestHoldings'
  | 'highestMarketValue'
  | 'lowestMarketValue'
  | 'highestUnrealised'
  | 'lowestUnrealised'
  | 'highestGain'
  | 'lowestGain';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'alphabetical', label: 'Alphabetical' },
  { key: 'highestHoldings', label: 'Highest Holdings' },
  { key: 'lowestHoldings', label: 'Lowest Holdings' },
  { key: 'highestMarketValue', label: 'Highest Market Value' },
  { key: 'lowestMarketValue', label: 'Lowest Market Value' },
  { key: 'highestUnrealised', label: 'Highest Unrealised Value' },
  { key: 'lowestUnrealised', label: 'Lowest Unrealised Value' },
  { key: 'highestGain', label: 'Highest Gain' },
  { key: 'lowestGain', label: 'Lowest Gain' },
];

export default function MobilePortfolioView({ holdings, prices, fxRates, cashGBP = 0, initialSeries }: Props) {
  const [sortBy, setSortBy] = useState<SortKey>('alphabetical');
  const [range, setRange] = useState<'1D'|'1W'|'1M'|'YTD'|'1Y'|'ALL'>('1D');
  const [showGBPValues, setShowGBPValues] = useState<boolean>(false);
  const [hideTotals, setHideTotals] = useState<boolean>(false);
  const RANGE_KEY = 'mobileRangePrefV1';
  const SORT_KEY = 'mobileSortPrefV1';
  const SHOW_GBP_KEY = 'mobileShowGBPValuesV1';

  const rate = useCallback((ccy?: string) => fxRates[(ccy || 'GBP').toUpperCase()] ?? 1, [fxRates]);
  const mv = useCallback((h: Holding) => {
    const p = prices[h.ticker]?.price ?? 0;
    const m = prices[h.ticker]?.price_multiplier ?? 1;
    return h.total_shares * p * m; // native asset currency
  }, [prices]);
  const unrealised = useCallback((h: Holding) => mv(h) - h.total_cost, [mv]);

  // ---- Range changes for sorting by gain ----
  const [rangeChangesGBP, setRangeChangesGBP] = useState<Record<string, number>>({});
  const [rangeChangesNative, setRangeChangesNative] = useState<Record<string, number>>({});

  const activeRangeChanges = showGBPValues ? rangeChangesGBP : rangeChangesNative;

  const sorted = useMemo(() => {
    const list = [...holdings];
    switch (sortBy) {
      case 'alphabetical':
        return list.sort((a, b) => (a.ticker || '').localeCompare(b.ticker || ''));
      case 'highestHoldings':
        return list.sort((a, b) => b.total_shares - a.total_shares);
      case 'lowestHoldings':
        return list.sort((a, b) => a.total_shares - b.total_shares);
      case 'highestMarketValue':
        return list.sort((a, b) => mv(b) - mv(a));
      case 'lowestMarketValue':
        return list.sort((a, b) => mv(a) - mv(b));
      case 'highestUnrealised':
        return list.sort((a, b) => unrealised(b) - unrealised(a));
      case 'lowestUnrealised':
        return list.sort((a, b) => unrealised(a) - unrealised(b));
      case 'highestGain':
        return list.sort((a, b) => (activeRangeChanges[b.ticker] ?? 0) - (activeRangeChanges[a.ticker] ?? 0));
      case 'lowestGain':
        return list.sort((a, b) => (activeRangeChanges[a.ticker] ?? 0) - (activeRangeChanges[b.ticker] ?? 0));
      default:
        return list;
    }
  }, [holdings, sortBy, mv, unrealised, activeRangeChanges]);

  // Display helper: show whole numbers as integer; otherwise 1 decimal place
  const displayUnits = (shares: number) => {
    const rounded = Math.round(shares);
    if (Math.abs(shares - rounded) < 1e-8) return String(rounded);
    const oneDec = Math.round(shares * 10) / 10;
    const oneDecInt = Math.round(oneDec);
    if (Math.abs(oneDec - oneDecInt) < 1e-8) return String(oneDecInt);
    return oneDec.toFixed(1);
  };

  // ---- Total worth chart (fetch series on range change) ----
  const [series, setSeries] = useState<SeriesPoint[] | null>(initialSeries ?? null);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSeries() {
      setLoadingSeries(true);
      setSeriesError(null);
      try {
        // Always use UK day progression for 1D windowing and series clipping
        const tz = 'Europe/London';
        // Kick off a fast request for range changes so table/badges sort instantly
        const fast = fetch(`/api/portfolio-changes?range=${encodeURIComponent(range)}&tz=${encodeURIComponent(tz)}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : Promise.reject(new Error(`changes ${r.status}`)))
          .then(j => {
            if (cancelled) return;
            setRangeChangesGBP((j.changes as Record<string, number>) || {});
            setRangeChangesNative((j.changes_native as Record<string, number>) || {});
          })
          .catch(() => {});

        const res = await fetch(`/api/portfolio-series?range=${encodeURIComponent(range)}&tz=${encodeURIComponent(tz)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Series fetch failed: ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setSeries(json.points as SeriesPoint[]);
          setRangeChangesGBP((json.changes as Record<string, number>) || {});
          setRangeChangesNative((json.changes_native as Record<string, number>) || {});
        }
        await fast; // settle the fast call
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to load';
        if (!cancelled) setSeriesError(msg);
      } finally {
        if (!cancelled) setLoadingSeries(false);
      }
    }
    loadSeries();
    return () => { cancelled = true; };
  }, [range]);

  function LineChart({ data, className }: { data: SeriesPoint[]; className?: string }) {
    const width = 600; // will scale via CSS
    const height = 160;
    const pad = 8;
    const ys = data.map(p => p.value_gbp);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanY = maxY - minY || 1;
    const n = data.length;

    // For 1D range, map X by time-of-day between market open and close to leave empty space to end-of-day
  // Determine minutes-since-midnight in chosen market timezone
    const minutesSinceMidnight = (d: Date, timeZone: string) => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
      }).formatToParts(d);
      let h = 0, m = 0;
      for (const p of parts) {
        if (p.type === 'hour') h = parseInt(p.value, 10);
        else if (p.type === 'minute') m = parseInt(p.value, 10);
      }
      return h * 60 + m;
    };
  // Use a fixed 24-hour UK day window for 1D
  const tz = 'Europe/London';
  // Use 08:00–22:00 UK window for 1D
  const openMin = 8 * 60;
  const closeMin = 22 * 60;

    const innerW = Math.max(1, width - 2 * pad);
    const xAtTime = (d: Date) => {
      const mm = minutesSinceMidnight(d, tz);
      const t = Math.min(Math.max((mm - openMin) / Math.max(1, closeMin - openMin), 0), 1);
      return pad + t * innerW;
    };
    const xAtIndex = (i: number) => pad + (i * innerW) / Math.max(1, n - 1);
    const xAt = (i: number) => {
      if (range === '1D') {
        const d = new Date(data[i].date);
        return xAtTime(d);
      }
      return xAtIndex(i);
    };
    const yAt = (v: number) => height - pad - ((v - minY) * (height - 2 * pad)) / spanY;
    const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(p.value_gbp).toFixed(2)}`).join(' ');
    // Chart line uses the accent blue (#3cb4e7)
    const stroke = 'var(--color-accent)';
    const fill = 'rgba(60, 180, 231, 0.20)';

    // Chart background per spec:
    // - 1W: alternating day columns (#dcdee0 / #ffffff)
    // - 1M+ (1M/YTD/1Y/ALL): solid grey (#dcdee0)
    // - 1D: solid grey
    const bgRects = (() => {
      const rects: Array<{ x: number; w: number; fill: string }> = [];
      const grey = 'var(--color-gray-back-fixed)';
      const white = '#ffffff';

      if (range === '1W') {
        const dayKey = (iso: string) => String(iso).slice(0, 10);
        const keys = data.map(p => dayKey(p.date));
        const segments: Array<{ start: number; end: number }> = [];
        let start = 0;
        for (let i = 1; i < keys.length; i++) {
          if (keys[i] !== keys[i - 1]) {
            segments.push({ start, end: i - 1 });
            start = i;
          }
        }
        segments.push({ start, end: keys.length - 1 });

        for (let s = 0; s < segments.length; s++) {
          const seg = segments[s];
          const startX = seg.start === 0 ? pad : (xAt(seg.start - 1) + xAt(seg.start)) / 2;
          const endX = seg.end === n - 1 ? (width - pad) : (xAt(seg.end) + xAt(seg.end + 1)) / 2;
          const w = Math.max(0, endX - startX);
          rects.push({ x: startX, w, fill: s % 2 === 0 ? grey : white });
        }
        return rects;
      }

      // Solid grey for 1D and >= 1M ranges
      if (range === '1D' || range === '1M' || range === 'YTD' || range === '1Y' || range === 'ALL') {
        rects.push({ x: 0, w: width, fill: grey });
      }
      return rects;
    })();
    // Area under curve
    const area = `${path} L ${xAt(n - 1).toFixed(2)} ${height - pad} L ${xAt(0).toFixed(2)} ${height - pad} Z`;
    const [hover, setHover] = useState<number | null>(null);
    const onMove = (clientX: number, target: Element | null) => {
      const el = target as SVGSVGElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const relX = clientX - rect.left; // px within element
      // Convert to SVG user-space X using viewBox scaling
      const scaleX = rect.width / width;
      const userX = relX / (scaleX || 1);
      // Consider padding on left/right
      const inner = Math.max(1, width - 2 * pad);
      const t = Math.min(Math.max((userX - pad) / inner, 0), 1);
      let idx = Math.round(t * Math.max(1, n - 1));

      // For 1D, align tooltip to nearest time-of-day, not just index
      if (range === '1D') {
        const targetMin = openMin + t * Math.max(1, closeMin - openMin);
        // Precompute minutes-of-day for each point in tz
        const mins = data.map(p => minutesSinceMidnight(new Date(p.date), tz));
        let bestI = 0;
        let bestD = Infinity;
        for (let i = 0; i < mins.length; i++) {
          const dlt = Math.abs(mins[i] - targetMin);
          if (dlt < bestD) { bestD = dlt; bestI = i; }
        }
        idx = bestI;
      }
      setHover(idx);
    };
    const onLeave = () => setHover(null);
  const hoverX = hover != null ? xAt(hover) : null;
  const hoverY = hover != null ? yAt(data[hover].value_gbp) : null;
    const tooltipBg = '#ffffff';
    const tooltipText = '#111a2e';
  const dt = hover != null ? new Date(data[hover].date) : null;
  const when = dt ? (range === '1D' ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : dt.toLocaleDateString()) : '';
  const label = hover != null ? `${when} • ${formatCurrency(data[hover].value_gbp, 'GBP')}` : '';
  const boxW = 220;
  const boxH = 32;
  const boxX = hoverX != null ? Math.min(Math.max(hoverX - boxW / 2, pad), width - boxW) : pad;
  const boxY = pad;
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={`block ${className || ''}`}
        role="img"
        aria-label={`Portfolio value over ${range}`}
        preserveAspectRatio="none"
        onMouseMove={(e) => onMove(e.clientX, e.currentTarget)}
        onMouseLeave={onLeave}
        onTouchStart={(e) => { if (e.touches[0]) onMove(e.touches[0].clientX, e.currentTarget); }}
        onTouchMove={(e) => { if (e.touches[0]) onMove(e.touches[0].clientX, e.currentTarget); }}
        onTouchEnd={onLeave}
      > 
        {bgRects.map((r, i) => (
          <rect key={i} x={r.x} y={0} width={r.w} height={height} fill={r.fill} />
        ))}
        <path d={area} fill={fill} />
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && hoverX != null && hoverY != null && (
          <g>
            <line x1={hoverX} y1={pad} x2={hoverX} y2={height - pad} stroke={stroke} strokeWidth={1.25} opacity={0.4} />
            <circle cx={hoverX} cy={hoverY} r={4.5} fill={stroke} />
            {/* Tooltip */}
            <g>
              <rect x={boxX} y={boxY} width={boxW} height={boxH} rx={6} fill={tooltipBg} stroke={stroke} opacity={0.95} />
              <text x={boxX + 10} y={boxY + 21} fill={tooltipText} fontSize="12" fontWeight="700">
                {label}
              </text>
            </g>
          </g>
        )}
      </svg>
    );
  }

  // Load persisted range and sort on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const savedRange = localStorage.getItem(RANGE_KEY) as typeof range | null;
      if (savedRange && ['1D','1W','1M','YTD','1Y','ALL'].includes(savedRange)) {
        setRange(savedRange);
      }
    } catch {}
    try {
      const savedSort = localStorage.getItem(SORT_KEY) as SortKey | null;
      const allowed = SORT_OPTIONS.map(o => o.key);
      if (savedSort && (allowed as string[]).includes(savedSort)) {
        setSortBy(savedSort as SortKey);
      }
    } catch {}

    try {
      const savedShowGBP = localStorage.getItem(SHOW_GBP_KEY);
      if (savedShowGBP === '1') setShowGBPValues(true);
      if (savedShowGBP === '0') setShowGBPValues(false);
    } catch {}
  }, []);

  const totalMarketGBP = sorted.reduce((sum, h) => sum + mv(h) * rate(h.currency), 0);
  const totalGBP = totalMarketGBP + cashGBP;
  // Header variance should match the chart.
  // The API "changes" maps are per-ticker helpers for sorting; they intentionally exclude cash and can diverge
  // from the chart when there are trades within the range (because they use shares-as-of-today).
  const chartDeltaGBP = useMemo(() => {
    if (!series || series.length < 2) return null;
    return (series[series.length - 1]?.value_gbp ?? 0) - (series[0]?.value_gbp ?? 0);
  }, [series]);
  const chartBaselineGBP = useMemo(() => {
    if (!series || series.length < 2) return null;
    return series[0]?.value_gbp ?? 0;
  }, [series]);

  // Fallback while series is loading/empty
  const fallbackChangeGBP = sorted.reduce((sum, h) => sum + (rangeChangesGBP[h.ticker] ?? 0), 0);
  const headerChangeGBP = chartDeltaGBP ?? fallbackChangeGBP;
  const headerBaselineGBP = chartBaselineGBP ?? Math.max(0, totalGBP - headerChangeGBP);
  const headerChangePct = headerBaselineGBP > 0 ? (headerChangeGBP / headerBaselineGBP) * 100 : 0;

  // Surfaces per spec
  // - App background/text is controlled by CSS vars (background/foreground)
  // - Menu bar and asset tiles are always themeblue (#247372)
  const cardBgClass = 'bg-themeblue';
  const chartBgClass = 'bg-transparent';
  const sortLabelTextClass = 'text-xs font-semibold text-foreground/70';
  const selectBorderClass = 'border-accent';

  return (
    <div className="space-y-4 text-foreground">
      {/* Header totals */}
      <div>
        <div className="text-foreground/70 text-xs font-semibold">Total Worth</div>
        <div className="flex items-center gap-2">
          {!hideTotals && (
            <div className="text-4xl font-extrabold text-foreground">
              {formatCurrency(Math.round(totalGBP), 'GBP').replace(/\.00$/, '')}
            </div>
          )}
          <button
            type="button"
            onClick={() => setHideTotals((v) => !v)}
            aria-label={hideTotals ? 'Show values' : 'Hide values'}
            className="text-foreground p-1"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
              <circle cx="12" cy="12" r="3" />
              {hideTotals && <path d="M3 3l18 18" />}
            </svg>
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div className={`text-sm font-semibold ${headerChangeGBP >= 0 ? 'text-tgreen' : 'text-tred'}`}>
            {headerChangeGBP === 0 ? '0' : (headerChangeGBP > 0 ? '+' : '-')}
            {formatCurrency(Math.abs(Math.round(headerChangeGBP)), 'GBP').replace(/\.00$/, '')}
              <span
              className={`ml-2 px-1 py-0.5 rounded font-bold ${
                headerChangeGBP >= 0
                  ? 'text-tgreen bg-tgreen-bg'
                  : 'text-tred bg-tred-bg'
              }`}
            >
              {Math.abs(headerChangePct).toFixed(2)}%
            </span>
              <span className="ml-2 px-1 py-0.5 rounded text-xs font-semibold text-themeblue bg-background/60 border border-themeblue/30 align-middle">
              {range}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Intentionally no extra theme toggle here; mobile follows the global theme setting */}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className={`rounded-lg ${chartBgClass} h-40 flex items-center justify-center text-foreground/80 text-sm overflow-hidden border border-Tdivider`}>
        {loadingSeries && <span>Loading…</span>}
        {!loadingSeries && seriesError && <span className="text-tred">{seriesError}</span>}
        {!loadingSeries && !seriesError && series && series.length > 1 && (
          <LineChart data={series} className="w-full h-full" />
        )}
        {!loadingSeries && !seriesError && (!series || series.length <= 1) && (
          <span>Not enough data</span>
        )}
      </div>

      {/* Time range chips */}
      <div className="flex gap-2">
        {(['1D','1W','1M','YTD','1Y','ALL'] as const).map((r) => (
          <button
            key={r}
            type="button"
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              range===r
                ? 'bg-accent text-white border-accent'
                : 'bg-background text-accent border-accent'
            }`}
            onClick={() => {
              setRange(r);
              try { localStorage.setItem(RANGE_KEY, r); } catch {}
            }}
          >{r}</button>
        ))}
      </div>

        {/* Sort control + GBP toggle */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setShowGBPValues((prev) => {
                const next = !prev;
                try { localStorage.setItem(SHOW_GBP_KEY, next ? '1' : '0'); } catch {}
                return next;
              });
            }}
            className={
              showGBPValues
                ? 'px-2 py-0.5 rounded text-[10px] font-semibold bg-accent text-white border border-accent'
                : 'px-2 py-0.5 rounded text-[10px] font-semibold bg-background text-accent border border-accent'
            }
          >
            <span className={showGBPValues ? 'font-extrabold' : 'font-semibold'}>GBP</span>
          </button>
          <div className="flex items-center">
            <label className={`mr-2 ${sortLabelTextClass}`}>Sort</label>
            <select
              className={`bg-transparent border ${selectBorderClass} rounded px-2 py-1 text-sm text-accent`}
              value={sortBy}
              onChange={(e) => {
                const v = e.target.value as SortKey;
                setSortBy(v);
                try { localStorage.setItem(SORT_KEY, v); } catch {}
              }}
            >
              {SORT_OPTIONS.map((o) => (
                <option
                  key={o.key}
                  value={o.key}
                  className="text-accent"
                >
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

      {/* List */}
      <div className="space-y-2">
        {sorted.map((h) => {
          const price = prices[h.ticker]?.price ?? 0;
          const mult = prices[h.ticker]?.price_multiplier ?? 1; // retained for unit price display
          const displayCcy = showGBPValues ? 'GBP' : (h.currency || 'GBP');
          const unitPriceDisplay = showGBPValues ? (price * mult) * rate(h.currency) : (price * mult);
          const mvGBP = mv(h) * rate(h.currency);
          const mvNative = mv(h);
          const unrealNative = mvNative - h.total_cost;
          const unrealGBP = unrealNative * rate(h.currency);
          // Range-aware change using API-provided changes map
          const changeValueGBP = rangeChangesGBP[h.ticker] ?? 0;
          const changeValueNative = rangeChangesNative[h.ticker] ?? 0;
          const changeValueDisplay = showGBPValues ? changeValueGBP : changeValueNative;
          const baseDisplay = (showGBPValues ? mvGBP : mvNative) - changeValueDisplay;
          const changePct = baseDisplay > 0 ? (changeValueDisplay / baseDisplay) * 100 : null;
          return (
            <div key={h.asset_id} className={`rounded-lg ${cardBgClass} px-3 py-2 flex items-center justify-between`}>
              <div className="flex items-center gap-3">
                {/* Logo square; no rounding per request */}
                <LogoWithFallback
                  src={h.logo_url || null}
                  alt=""
                  className="bg-background border border-Tdivider w-9 h-9"
                  fallback={
                    <div className="w-9 h-9 bg-Tdark-shade border border-Tdivider flex items-center justify-center text-xs text-white font-bold">
                      {(h.ticker || '').toUpperCase().slice(0, 4)}
                    </div>
                  }
                />
                <div>
                  <div className="text-white font-semibold leading-tight">{h.ticker}</div>
                  <div className="text-xs text-accent leading-tight">
                    {displayUnits(h.total_shares)} @ {formatCurrency(unitPriceDisplay, displayCcy)}
                  </div>
                </div>
              </div>
              <div className="text-right">
                {!hideTotals && (
                  <div className="text-white font-bold">
                    {formatCurrency(showGBPValues ? mvGBP : mvNative, displayCcy)}
                  </div>
                )}
                <div className="text-xs font-semibold mt-0.5">
                  <span className={`${(showGBPValues ? unrealGBP : unrealNative) >= 0 ? BADGE_POS : BADGE_NEG}`}>
                    {(showGBPValues ? unrealGBP : unrealNative) >= 0 ? '+' : '-'}{formatCurrency(Math.abs(showGBPValues ? unrealGBP : unrealNative), displayCcy)}
                  </span>
                </div>
                <div className="text-xs mt-0.5 flex justify-end gap-1 flex-wrap">
                  <>
                    <span className={`${changeValueDisplay >= 0 ? BADGE_POS : BADGE_NEG}`}>
                      {changeValueDisplay >= 0 ? '+' : '-'}{formatCurrency(Math.abs(changeValueDisplay), displayCcy)}
                    </span>
                    {changePct !== null && isFinite(changePct) && (
                      <span className={`${changeValueDisplay >= 0 ? BADGE_POS : BADGE_NEG}`}>{Math.abs(changePct).toFixed(2)}%</span>
                    )}
                  </>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      
    </div>
  );
}
