"use client";

import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { POSITIVE_BADGE, NEGATIVE_BADGE, THEME_BLUE_DISABLED_BG } from '@/lib/uiColors';
import { isMarketHoliday } from '@/lib/marketHolidays';

type MarketCode = 'UK' | 'US';

interface MarketDef {
  code: MarketCode;
  label: string;
  tz: string;
  open: { h: number; m: number };
  close: { h: number; m: number };
}

const MARKETS: MarketDef[] = [
  { code: 'UK', label: 'LSE', tz: 'Europe/London', open: { h: 8, m: 0 }, close: { h: 16, m: 30 } },
  { code: 'US', label: 'US (NYSE/Nasdaq)', tz: 'America/New_York', open: { h: 9, m: 30 }, close: { h: 16, m: 0 } },
];

interface SessionStatus {
  code: MarketCode;
  label: string;
  phase: 'pre' | 'open' | 'post' | 'closed' | 'holiday';
  note?: string; // e.g. opens in Xm / closes in Xm
  nextEvent?: { type: 'opens' | 'closes'; atISO: string; minutes: number };
}

// Extended sessions configuration (UTC-local to market TZ)
const EXTENDED_WINDOWS: Record<MarketCode, { pre: { h: number; m: number }; post: { h: number; m: number } | null }> = {
  UK: { pre: { h: 7, m: 0 }, post: { h: 17, m: 30 } }, // modest pre/post definitions
  US: { pre: { h: 4, m: 0 }, post: { h: 20, m: 0 } },   // US common extended hours
};

function computeSession(m: MarketDef, nowUtc: DateTime): SessionStatus {
  // Convert to market timezone
  const now = nowUtc.setZone(m.tz);
  const weekday = now.weekday; // 1=Mon .. 7=Sun
  const isWeekend = weekday === 6 || weekday === 7;
  const isoLocal = now.toISODate()!; // local market date
  const holiday = isMarketHoliday(m.code, isoLocal);

  const openDT = now.startOf('day').plus({ hours: m.open.h, minutes: m.open.m });
  const closeDT = now.startOf('day').plus({ hours: m.close.h, minutes: m.close.m });

  if (holiday) {
    return { code: m.code, label: m.label, phase: 'holiday', note: 'Holiday' };
  }
  if (isWeekend) {
    // Next open = next Monday at open time
    const daysToMon = weekday === 6 ? 2 : 1; // Sat -> +2, Sun -> +1
    const nextOpen = openDT.plus({ days: daysToMon });
    const mins = Math.round(nextOpen.diff(now, 'minutes').minutes);
    return {
      code: m.code,
      label: m.label,
      phase: 'closed',
      note: `Opens in ${mins}m`,
      nextEvent: { type: 'opens', atISO: nextOpen.toISO()!, minutes: mins },
    };
  }

  const ext = EXTENDED_WINDOWS[m.code];
  const preDT = now.startOf('day').plus({ hours: ext.pre.h, minutes: ext.pre.m });
  const postDT = ext.post ? now.startOf('day').plus({ hours: ext.post.h, minutes: ext.post.m }) : closeDT;

  if (now < preDT) {
    const mins = Math.round(openDT.diff(now, 'minutes').minutes);
    return {
      code: m.code,
      label: m.label,
      phase: 'closed',
      note: `Opens in ${mins}m`,
      nextEvent: { type: 'opens', atISO: openDT.toISO()!, minutes: mins },
    };
  }

  if (now >= preDT && now < openDT) {
    const mins = Math.round(openDT.diff(now, 'minutes').minutes);
    return {
      code: m.code,
      label: m.label,
      phase: 'pre',
      note: `Opens in ${mins}m`,
      nextEvent: { type: 'opens', atISO: openDT.toISO()!, minutes: mins },
    };
  }

  if (now >= openDT && now < closeDT) {
    const mins = Math.round(closeDT.diff(now, 'minutes').minutes);
    return {
      code: m.code,
      label: m.label,
      phase: 'open',
      note: `Closes in ${mins}m`,
      nextEvent: { type: 'closes', atISO: closeDT.toISO()!, minutes: mins },
    };
  }

  if (now >= closeDT && now < postDT) {
    const mins = Math.round(postDT.diff(now, 'minutes').minutes);
    return {
      code: m.code,
      label: m.label,
      phase: 'post',
      note: `Post · ${mins}m left`,
    };
  }

  // After extended close: next open (skip weekend)
  let nextOpen = openDT.plus({ days: 1 });
  let nextWeekday = weekday + 1;
  if (nextWeekday === 6) nextOpen = nextOpen.plus({ days: 2 });
  else if (nextWeekday === 7) nextOpen = nextOpen.plus({ days: 1 });
  const mins = Math.round(nextOpen.diff(now, 'minutes').minutes);
  return {
    code: m.code,
    label: m.label,
    phase: 'closed',
    note: `Opens in ${mins}m`,
    nextEvent: { type: 'opens', atISO: nextOpen.toISO()!, minutes: mins },
  };
}

interface MarketStatusProps {
  refreshMs?: number;
  tickers?: string[]; // optional to filter markets by usage
}

export default function MarketStatusBadges({ refreshMs = 60_000, tickers }: MarketStatusProps) {
  const activeMarkets = useMemo(() => {
    if (!tickers || tickers.length === 0) return MARKETS;
    const hasUK = tickers.some(t => /\.L$/i.test(t));
    const hasUS = tickers.some(t => !/\.L$/i.test(t));
    return MARKETS.filter(m => (m.code === 'UK' && hasUK) || (m.code === 'US' && hasUS));
  }, [tickers]);

  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('market_status_hidden') === '1'; } catch { return false; }
  });

  const [sessions, setSessions] = useState<SessionStatus[]>(() => activeMarkets.map(m => computeSession(m, DateTime.utc())));

  useEffect(() => {
    const update = () => setSessions(activeMarkets.map(m => computeSession(m, DateTime.utc())));
    update();
    const id = setInterval(update, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, activeMarkets]);

  const toggleHidden = () => {
    setHidden(h => {
      const nv = !h;
      try { localStorage.setItem('market_status_hidden', nv ? '1' : '0'); } catch {}
      return nv;
    });
  };

  return (
    <div className="mb-4" aria-label="Market status">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={toggleHidden}
          className="text-xs underline decoration-dotted opacity-70 hover:opacity-100"
        >
          {hidden ? 'Show markets' : 'Hide markets'}
        </button>
        {!hidden && sessions.map(s => {
          const base =
            s.phase === 'open'
              ? POSITIVE_BADGE
              : s.phase === 'holiday'
              ? THEME_BLUE_DISABLED_BG
              : s.phase === 'pre' || s.phase === 'post'
              ? 'inline-block rounded px-1 font-bold bg-yellow-100 text-yellow-700'
              : NEGATIVE_BADGE;
          const labelPhase = s.phase === 'open'
            ? 'Open'
            : s.phase === 'pre'
            ? 'Pre'
            : s.phase === 'post'
            ? 'Post'
            : s.phase === 'holiday'
            ? 'Holiday'
            : 'Closed';
          return (
            <span
              key={s.code}
              className={`${base} text-xs whitespace-nowrap`}
              title={`${s.label} ${labelPhase}. ${s.note || ''}`.trim()}
            >
              {s.label}: {labelPhase}{s.note ? ` · ${s.note}` : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}
