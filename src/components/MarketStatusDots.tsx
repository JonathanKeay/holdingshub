"use client";

import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { isMarketHoliday } from '@/lib/marketHolidays';

type MarketCode = 'UK' | 'US';

interface MarketDef {
  code: MarketCode;
  label: string;
  tz: string;
  open: { h: number; m: number };
  close: { h: number; m: number };
  pre: { h: number; m: number };
  post: { h: number; m: number };
}

const MARKETS: MarketDef[] = [
  {
    code: 'UK',
    label: 'LSE',
    tz: 'Europe/London',
    open: { h: 8, m: 0 },
    close: { h: 16, m: 30 },
    pre: { h: 7, m: 0 },
    post: { h: 17, m: 30 },
  },
  {
    code: 'US',
    label: 'US',
    tz: 'America/New_York',
    open: { h: 9, m: 30 },
    close: { h: 16, m: 0 },
    pre: { h: 4, m: 0 },
    post: { h: 20, m: 0 },
  },
];

type Phase = 'holiday' | 'pre' | 'open' | 'post' | 'closed';

interface Session {
  code: MarketCode;
  label: string;
  phase: Phase;
  note?: string;
  nextOpen?: DateTime; // market tz
}

function minutesUntil(a: DateTime, b: DateTime) {
  return Math.max(0, Math.round(a.diff(b, 'minutes').minutes));
}

function formatHM(totalMinutes: number) {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function computeNextOpen(m: MarketDef, nowMarket: DateTime): DateTime {
  const isWeekend = (d: number) => d === 6 || d === 7;
  let dayOffset = 0;

  while (true) {
    const baseDay = nowMarket.startOf('day').plus({ days: dayOffset });
    const wd = baseDay.weekday; // 1..7
    const iso = baseDay.toISODate()!;

    if (!isWeekend(wd) && !isMarketHoliday(m.code, iso)) {
      const open = baseDay.plus({ hours: m.open.h, minutes: m.open.m });
      if (dayOffset === 0) {
        // Only return today's open if it's still in the future
        if (nowMarket < open) return open;
        // otherwise look at the next valid trading day
      } else {
        return open;
      }
    }
    dayOffset += 1;
  }
}

function phaseFor(m: MarketDef, nowUTC: DateTime): Session {
  const now = nowUTC.setZone(m.tz);
  const weekday = now.weekday; // 1..7
  const isoLocal = now.toISODate()!;
  const holiday = isMarketHoliday(m.code, isoLocal);
  const weekend = weekday === 6 || weekday === 7;

  const base = now.startOf('day');
  const pre = base.plus({ hours: m.pre.h, minutes: m.pre.m });
  const open = base.plus({ hours: m.open.h, minutes: m.open.m });
  const close = base.plus({ hours: m.close.h, minutes: m.close.m });
  const post = base.plus({ hours: m.post.h, minutes: m.post.m });

  if (holiday) return { code: m.code, label: m.label, phase: 'holiday', note: 'Holiday', nextOpen: computeNextOpen(m, now) };
  if (weekend) return { code: m.code, label: m.label, phase: 'closed', note: 'Weekend', nextOpen: computeNextOpen(m, now) };

  if (now < pre) {
    return { code: m.code, label: m.label, phase: 'closed', note: `Opens in ${formatHM(minutesUntil(open, now))}`, nextOpen: open };
  }
  if (now >= pre && now < open) {
    return { code: m.code, label: m.label, phase: 'pre', note: `Opens in ${formatHM(minutesUntil(open, now))}`, nextOpen: open };
  }
  if (now >= open && now < close) {
    // Next open is next trading day, not today's close
    const nextOpen = computeNextOpen(m, now.plus({ minutes: 1 }));
    return { code: m.code, label: m.label, phase: 'open', note: `Closes in ${formatHM(minutesUntil(close, now))}`, nextOpen };
  }
  if (now >= close && now < post) {
    const nextOpen = computeNextOpen(m, now.plus({ minutes: 1 }));
    return { code: m.code, label: m.label, phase: 'post', note: `Ext until ${post.toFormat('HH:mm')}`, nextOpen };
  }

  const nextOpen = computeNextOpen(m, now.plus({ minutes: 1 }));
  return { code: m.code, label: m.label, phase: 'closed', note: `Opens in ${formatHM(minutesUntil(nextOpen, now))}`, nextOpen };
}

interface Props {
  tickers?: string[];
  refreshMs?: number;
}

export default function MarketStatusDots({ tickers, refreshMs = 60_000 }: Props) {
  const markets = useMemo(() => {
    if (!tickers || tickers.length === 0) return MARKETS;
    const hasUK = tickers.some(t => /\.L$/i.test(t));
    const hasUS = tickers.some(t => !/\.L$/i.test(t));
    return MARKETS.filter(m => (m.code === 'UK' && hasUK) || (m.code === 'US' && hasUS));
  }, [tickers]);

  const [sessions, setSessions] = useState<Session[]>(() => markets.map(m => phaseFor(m, DateTime.utc())));

  useEffect(() => {
    const update = () => setSessions(markets.map(m => phaseFor(m, DateTime.utc())));
    update();
    const id = setInterval(update, refreshMs);
    return () => clearInterval(id);
  }, [markets, refreshMs]);

  const colorFor = (p: Phase) => {
    switch (p) {
      case 'open': return 'bg-[var(--color-tgreen)] shadow-[0_0_0_2px_rgba(0,0,0,0.15)]';
      case 'pre': return 'bg-yellow-400 animate-pulse shadow-[0_0_0_2px_rgba(0,0,0,0.1)]';
      case 'post': return 'bg-yellow-600 shadow-[0_0_0_2px_rgba(0,0,0,0.15)]';
      case 'holiday': return 'bg-blue-300 shadow-[0_0_0_2px_rgba(0,0,0,0.05)]';
      case 'closed':
      default: return 'bg-[var(--color-tred)] opacity-70 shadow-[0_0_0_2px_rgba(0,0,0,0.05)]';
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-4" aria-label="Market status dots">
      {sessions.map(s => {
        const nextOpenUK = s.nextOpen?.setZone('Europe/London');
        const nextOpenStr = nextOpenUK ? nextOpenUK.toFormat('ccc dd MMM HH:mm') + ' UK' : 'Unknown';
        const tooltip = `${s.label}: ${s.phase}${s.note ? ' · ' + s.note : ''}\nNext open (UK): ${nextOpenStr}`;
        return (
          <span
            key={s.code}
            className="flex items-center gap-1 text-[11px] text-gray-600 font-medium select-none"
            title={tooltip}
          >
            <span>{s.label}</span>
            <span
              className={`inline-block w-3 h-3 rounded-full ${colorFor(s.phase)} transition`}
              aria-label={`${s.label} status`}
            />
          </span>
        );
      })}
    </div>
  );
}
