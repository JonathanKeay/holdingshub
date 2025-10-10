"use client";

import React from 'react';

export default function PortfolioExpandCollapseControls() {
  const broadcast = (type: 'expand' | 'collapse') => {
    const evt = new CustomEvent(type === 'expand' ? 'portfolio:expandAll' : 'portfolio:collapseAll');
    window.dispatchEvent(evt);
  };

  return (
    <div className="flex items-center gap-2 mb-3">
      <button
        type="button"
        onClick={() => broadcast('expand')}
        className="text-xs px-2 py-1 rounded border border-themeblue text-themeblue font-semibold bg-white active:scale-[.97]"
        aria-label="Expand all portfolios"
      >
        Expand all
      </button>
      <button
        type="button"
        onClick={() => broadcast('collapse')}
        className="text-xs px-2 py-1 rounded border border-themeblue text-themeblue font-semibold bg-white active:scale-[.97]"
        aria-label="Collapse all portfolios"
      >
        Collapse all
      </button>
    </div>
  );
}
