import React from "react";

export function TickerFallbackIcon({ ticker }: { ticker: string }) {
  const letters = (ticker || "").toUpperCase().slice(0, 3);
  return (
    <div className="flex items-center justify-center h-10 w-10 rounded bg-themeblue border mr-2">
      <span className="text-white font-bold text-sm tracking-wide">
        {letters}
      </span>
    </div>
  );
}