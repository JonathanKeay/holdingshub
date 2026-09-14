'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
// Cookie-aware client — required now that `settings` is per-user and its
// RLS policies key off the logged-in session (auth.uid()).
import { supabaseBrowser as supabase } from '@/lib/supabase/browser';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { THEME_BLUE_TEXT, THEME_BLUE_DISABLED_BG } from '@/lib/uiColors';

const ALL_STATUSES = ['active', 'delisted', 'acquired', 'inactive', 'unknown'];

// --- Import-style buttons (same tokens used elsewhere) ---
const BTN_BASE =
  'inline-flex items-center rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const BTN_MD = 'text-sm px-3.5 py-2';
const BTN_PRIMARY =
  'bg-themeblue text-white border border-themeblue-hover hover:bg-themeblue-hover shadow-sm focus-visible:ring-themeblue';
const BTN_GHOST =
  `${THEME_BLUE_TEXT} border border-Tdivider hover:bg-Thoverlight-tint focus-visible:ring-themeblue`;

export default function SettingsPage() {
  const [showZero, setShowZero] = useState(true);
  const [visibleStatuses, setVisibleStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      setUserId(user.id);

      // RLS already restricts this to the caller's own row; maybeSingle()
      // (not single()) because a brand-new user has no settings row yet —
      // that's an expected, non-error state, not a fetch failure.
      const { data } = await supabase
        .from('settings')
        .select('*')
        .maybeSingle();
      if (data) {
        setShowZero(!!data.show_zero_holdings);
        setVisibleStatuses(data.visible_statuses ?? ['active']);
        const t = data?.portfolio_prefs?.theme;
        if (t === 'system' || t === 'light' || t === 'dark') setTheme(t);
      }
      setLoading(false);
    };
    load();
  }, []);

  // Upsert (not update) — a brand-new user has no settings row yet, so the
  // first change must create one. user_id is the table's primary key, so
  // this targets exactly the caller's own row (and RLS's WITH CHECK still
  // enforces user_id = auth.uid() regardless).
  const upsertSettings = async (patch: Record<string, unknown>) => {
    if (!userId) return;
    await supabase.from('settings').upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  };

  const updateTheme = async (value: 'system' | 'light' | 'dark') => {
    setTheme(value);
    try {
      await fetch('/api/portfolio-prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: value }),
      });
    } catch {
      // ignore
    }
    try {
      localStorage.setItem('uiThemePrefV1', value);
    } catch {}
    // Apply immediately without a refresh
    try {
      document.documentElement.setAttribute('data-theme', value);
    } catch {}
  };

  const updateShowZero = async (value: boolean) => {
    setShowZero(value);
    await upsertSettings({ show_zero_holdings: value });
  };

  const toggleStatus = async (status: string) => {
    const updated = visibleStatuses.includes(status)
      ? visibleStatuses.filter((s) => s !== status)
      : [...visibleStatuses, status];

    setVisibleStatuses(updated);
    await upsertSettings({ visible_statuses: updated });
  };

  return (
    <main className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Top header with themed buttons */}
      <nav className="flex items-center justify-between">
        <h2 className={`${THEME_BLUE_TEXT} text-2xl font-bold`}>Settings</h2>
        <div className="flex items-center gap-2">
          <Link href="/" className={`${BTN_BASE} ${BTN_GHOST} ${BTN_MD}`} aria-label="Go to Dashboard">
            Dashboard
          </Link>
          <Link
            href="/settings/portfolio-layout"
            className={`${BTN_BASE} ${BTN_PRIMARY} ${BTN_MD}`}
            aria-label="Portfolio layout"
          >
            Portfolio layout
          </Link>
        </div>
      </nav>

      {/* Show Zero Holdings */}
      <section className="border border-Tdivider rounded-md p-4 bg-gray-back-fixed">
        <div className="flex items-center justify-between">
          <Label htmlFor="show-zero" className="text-Tdark-shade font-medium">
            Show tickers with zero holdings
          </Label>
          <Switch id="show-zero" checked={showZero} onCheckedChange={updateShowZero} disabled={loading} />
        </div>
        <p className="mt-2 text-xs text-Tdark-shade/70">
          Toggle whether assets with zero units are visible on the dashboard.
        </p>
      </section>

      {/* Theme */}
      <section className="border border-Tdivider rounded-md p-4 space-y-2 bg-gray-back-fixed">
        <Label className="text-Tdark-shade block text-sm font-medium">Theme</Label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => updateTheme('system')}
            className={`${BTN_BASE} ${theme === 'system' ? BTN_PRIMARY : BTN_GHOST} ${BTN_MD}`}
          >
            System
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => updateTheme('light')}
            className={`${BTN_BASE} ${theme === 'light' ? BTN_PRIMARY : BTN_GHOST} ${BTN_MD}`}
          >
            Light
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => updateTheme('dark')}
            className={`${BTN_BASE} ${theme === 'dark' ? BTN_PRIMARY : BTN_GHOST} ${BTN_MD}`}
          >
            Dark
          </button>
        </div>
        <p className="text-xs text-Tdark-shade/70">
          Choose an app theme that stays consistent across desktop and mobile.
        </p>
      </section>

      {/* Status visibility */}
      <section className="border border-Tdivider rounded-md p-4 space-y-3 bg-themeblue-bg">
        <Label className="text-foreground block text-sm font-medium">
          Asset statuses to include on dashboard
        </Label>

        <div className="divide-y">
          {ALL_STATUSES.map((status) => {
            const checked = visibleStatuses.includes(status);
            return (
              <div key={status} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                <span className="capitalize text-sm">{status}</span>
                <Switch
                  id={`toggle-${status}`}
                  checked={checked}
                  onCheckedChange={() => toggleStatus(status)}
                  disabled={loading}
                />
              </div>
            );
          })}
        </div>

        <div className={`${THEME_BLUE_DISABLED_BG} rounded px-3 py-2 text-xs`}>
          Changes are saved instantly and applied to your dashboard.
        </div>
      </section>

      {/* Extra settings links (card style, themed) */}
      <ul className="grid gap-3">
        <li>
          <Link
            href="/settings/portfolio-layout"
            className="block border border-Tdivider rounded-md px-3 py-2 hover:bg-Thoverlight-tint bg-themeblue-bg"
          >
            <div className={`${THEME_BLUE_TEXT} font-semibold`}>Portfolio layout</div>
            <div className="text-sm text-foreground/60">
              Reorder or hide portfolios for the dashboard.
            </div>
          </Link>
        </li>
        {/* Add more settings tiles here as needed */}
      </ul>
    </main>
  );
}
