// src/lib/utils.ts
export function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}

/** Format a duration in minutes as `Xd:Xh:Xm` (always includes all parts). */
export function formatDurationDHM(totalMinutes: number) {
  const mins = Math.max(0, Math.round(totalMinutes));
  const d = Math.floor(mins / (60 * 24));
  const h = Math.floor((mins % (60 * 24)) / 60);
  const m = mins % 60;
  return `${d}d:${h}h:${m}m`;
}
