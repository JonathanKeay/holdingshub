'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const ORDER_KEY = 'portfolio-order-v1';
const HIDDEN_KEY = 'portfolio-hidden-v1';

// Find portfolio blocks by their Transactions link
function collectBlocks(root: ParentNode) {
  const anchors = Array.from(
    root.querySelectorAll('a[href^="/transactions?portfolio="]')
  ) as HTMLAnchorElement[];

  const blocks: { id: string; node: HTMLElement }[] = [];
  for (const a of anchors) {
    try {
      const url = new URL(a.href);
      const id = url.searchParams.get('portfolio');
      if (!id) continue;
      const node = (a.closest('div.mb-8') || a.closest('div')) as HTMLElement | null;
      if (node) blocks.push({ id, node });
    } catch {}
  }
  return blocks;
}

export default function PortfolioLayoutApplier() {
  const pathname = usePathname();
  const search = useSearchParams();

  const retriesRef = React.useRef(0);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isApplyingRef = React.useRef(false);

  // Track scheduled burst timers so we can cancel between route changes
  const burstTimersRef = React.useRef<number[]>([]);

  const clearBurstTimers = React.useCallback(() => {
    for (const t of burstTimersRef.current) clearTimeout(t);
    burstTimersRef.current = [];
  }, []);

  const apply = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    if (pathname !== '/') return; // only dashboard

    const root = document.querySelector('main');
    if (!root) return;

    const blocks = collectBlocks(root);
    if (blocks.length === 0) {
      // DOM not ready yet -> retry a few times
      if (retriesRef.current < 20) {
        retriesRef.current += 1;
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => apply(), 120);
      }
      return;
    }

    retriesRef.current = 0;
    const parent = blocks[0].node.parentElement;
    if (!parent) return;

    // Read prefs
    let savedOrder: string[] = [];
    let savedHidden: string[] = [];
    try {
      const so = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      const sh = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      if (Array.isArray(so)) savedOrder = so;
      if (Array.isArray(sh)) savedHidden = sh;
    } catch {}

    const natural = blocks.map((b) => b.id);
    const desiredOrder =
      savedOrder.length > 0
        ? savedOrder
            .filter((id) => natural.includes(id))
            .concat(natural.filter((id) => !savedOrder.includes(id)))
        : natural;

    const idToNode = new Map(blocks.map((b) => [b.id, b.node]));

    // Hide/show only if changed
    for (const { id, node } of blocks) {
      const shouldHide = savedHidden.includes(id);
      const currentlyHidden = node.style.display === 'none';
      if (shouldHide !== currentlyHidden) {
        node.style.display = shouldHide ? 'none' : '';
      }
    }

    // Compute current sequence (only the portfolio nodes)
    const currentSeq = Array.from(parent.children).filter((el) => {
      return blocks.some((b) => b.node === el);
    }) as HTMLElement[];

    const desiredSeq = desiredOrder.map((id) => idToNode.get(id)!).filter(Boolean);

    // If sequences already match, do nothing
    if (
      currentSeq.length === desiredSeq.length &&
      currentSeq.every((el, i) => el === desiredSeq[i])
    ) {
      return;
    }

    if (isApplyingRef.current) return;
    isApplyingRef.current = true;

    // Reorder with minimal DOM ops
    const frag = document.createDocumentFragment();
    for (const el of desiredSeq) frag.appendChild(el);
    parent.appendChild(frag);

    // release flag on next frame
    requestAnimationFrame(() => {
      isApplyingRef.current = false;
    });
  }, [pathname]);

  // Schedule a small burst of applies to survive hydration reflow
  const scheduleApplyBurst = React.useCallback(() => {
    clearBurstTimers();
    // run now + a few times after to beat hydration/streaming bumps
    const delays = [0, 50, 200, 600, 1200, 2500];
    for (const d of delays) {
      const t = window.setTimeout(() => apply(), d);
      burstTimersRef.current.push(t);
    }
  }, [apply, clearBurstTimers]);

  // Apply on mount & when route/search change (client-side navigation)
  React.useEffect(() => {
    // cancel any pending burst from previous route
    clearBurstTimers();
    // wait a tick so the dashboard has rendered, then burst
    const id = requestAnimationFrame(() => scheduleApplyBurst());
    return () => cancelAnimationFrame(id);
  }, [scheduleApplyBurst, clearBurstTimers, pathname, search]);

  // Also apply on focus/visibility restore/BFCache and when prefs change in other tabs
  React.useEffect(() => {
    const onFocus = () => scheduleApplyBurst();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleApplyBurst();
    };
    const onPageShow = () => scheduleApplyBurst(); // BFCache restore
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === ORDER_KEY || e.key === HIDDEN_KEY) scheduleApplyBurst();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('storage', onStorage);
    };
  }, [scheduleApplyBurst]);

  // Cleanup retry timer + any pending burst timers
  React.useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      clearBurstTimers();
    };
  }, [clearBurstTimers]);

  return null;
}
