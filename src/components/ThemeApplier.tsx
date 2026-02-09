'use client';

import { useEffect } from 'react';

type ThemePref = 'system' | 'light' | 'dark';

const THEME_KEY = 'uiThemePrefV1';

function coerceTheme(v: unknown): ThemePref | null {
  if (v === 'system' || v === 'light' || v === 'dark') return v;
  return null;
}

function applyTheme(theme: ThemePref) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export default function ThemeApplier() {
  useEffect(() => {
    // 1) Apply local preference immediately (prevents “wrong theme” flash)
    try {
      const local = coerceTheme(localStorage.getItem(THEME_KEY));
      if (local) applyTheme(local);
      else applyTheme('system');
    } catch {
      applyTheme('system');
    }

    // 2) Fetch cloud preference and sync
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portfolio-prefs', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const cloud = coerceTheme(json?.theme) ?? 'system';
        if (cancelled) return;
        applyTheme(cloud);
        try {
          localStorage.setItem(THEME_KEY, cloud);
        } catch {}
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
