"use client";

import { useEffect, useState } from "react";

type Props = {
  intervalMs?: number;
};

export default function RefreshIndicator({ intervalMs = 15000 }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  useEffect(() => {
    let timer: number | null = null;

    const fetchOnce = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/prices/version", { cache: "no-store" });
        const j = await r.json();
        setVersion(j?.version ?? null);
      } catch {
        // ignore
      } finally {
        setLastCheck(new Date());
      }
    };

    // immediate hit + interval
    void fetchOnce();
    timer = window.setInterval(fetchOnce, intervalMs) as unknown as number;

    const onVisibility = () => { if (document.visibilityState === 'visible') void fetchOnce(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  return (
    <div className="mt-2 text-xs text-gray-500"> 
      Live update status: version {version ? String(version) : '—'} · last check {lastCheck ? lastCheck.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
    </div>
  );
}
