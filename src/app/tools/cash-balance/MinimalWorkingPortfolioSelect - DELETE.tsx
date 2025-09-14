// MinimalWorkingPortfolioSelect.tsx
'use client';

import * as React from 'react';

type Portfolio = { id: string; name: string };

const portfolios: Portfolio[] = [
  { id: 'a', name: 'Portfolio A' },
  { id: 'b', name: 'Portfolio B' },
  { id: 'c', name: 'Portfolio C' },
];

export default function MinimalWorkingPortfolioSelect() {
  const [selectedPortfolioId, setSelectedPortfolioId] = React.useState('');

  const derivedPortfolioName =
    portfolios.find((p) => p.id === selectedPortfolioId)?.name || '';

  return (
    <div style={{ padding: 32 }}>
      <label>
        Portfolio:
        <select
          value={selectedPortfolioId}
          onChange={e => setSelectedPortfolioId(e.target.value)}
          style={{ marginLeft: 8 }}
        >
          <option value="">— select —</option>
          {portfolios.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div style={{ marginTop: 16 }}>
        <b>Preview:</b> {derivedPortfolioName || '—'}
      </div>
    </div>
  );
}