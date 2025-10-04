"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

export type LivePricesRefresherProps = {
  tickers: string[];
  refreshMinMs?: number; // throttle: minimum ms between refreshes
  pollMs?: number; // fallback polling interval when tab is visible
  disableRealtime?: boolean; // set true if replication/publications are unavailable
};

export default function LivePricesRefresher({
  tickers,
  refreshMinMs = 15_000,
  pollMs = 60_000,
  disableRealtime = false,
}: LivePricesRefresherProps) {
  const router = useRouter();
  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  );

  const lastRefresh = useRef(0);
  const tryRefresh = () => {
    const now = Date.now();
    if (
      document.visibilityState === "visible" &&
      now - lastRefresh.current >= refreshMinMs
    ) {
      lastRefresh.current = now;
      // Re-fetch server data (prices/fx) without full reload
      router.refresh();
    }
  };

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let versionTimer: number | null = null;
    let lastSeenVersion: string | null = null;

    // Subscribe to price changes for the given tickers (if any) unless realtime is disabled
    if (!disableRealtime && tickers && tickers.length > 0) {
      // Sanitize to avoid commas/parentheses issues in PostgREST filter
      const inList = tickers
        .map((t) => String(t).replace(/[(),]/g, ""))
        .filter(Boolean)
        .join(",");

      if (inList.length > 0) {
        channel = supabase
          .channel("prices-live")
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "prices",
              filter: `ticker=in.(${inList})`,
            },
            () => tryRefresh()
          )
          .subscribe();
      }
    }

    // Visibility-aware fallback polling
    const onVisibility = () => {
      if (document.visibilityState === "visible") tryRefresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Lightweight version polling: hit our API to see if prices updated since last check
    const pollVersion = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/prices/version", { cache: "no-store" });
        if (!res.ok) return;
        const json: { version: string | null } = await res.json();
        if (json.version && json.version !== lastSeenVersion) {
          lastSeenVersion = json.version;
          tryRefresh();
        }
      } catch {
        // ignore network errors; next poll will try again
      }
    };
    versionTimer = window.setInterval(pollVersion, pollMs) as unknown as number;

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (versionTimer) window.clearInterval(versionTimer);
      if (channel) supabase.removeChannel(channel);
    };
    // Only re-run if the set of tickers changes materially or realtime toggle changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, pollMs, disableRealtime, JSON.stringify(tickers?.slice().sort())]);

  return null;
}
