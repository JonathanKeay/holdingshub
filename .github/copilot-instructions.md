# Portfolio Tracker - AI Coding Guide

## Architecture Overview

This is a **Next.js 15+ portfolio tracker** with Supabase backend, supporting multi-portfolio investment tracking with live prices, FX conversion, and complex transaction modeling.

### Core Components
- **Frontend**: Next.js 15 App Router, TypeScript, Tailwind CSS, Server/Client Components
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Price Data**: Yahoo Finance API with caching and eligibility tracking
- **FX Rates**: ExchangeRate.host API with daily caching

## Database Schema

### Core Tables & Relationships
```sql
portfolios (id:uuid) 
├── base_currency: text = 'GBP'
└── transactions (portfolio_id → portfolios.id)
    ├── asset_id → assets.id
    ├── type: text (BUY/SELL/TIN/TOT/DIV/INT/SPL/BAL)
    ├── cash_value/cash_ccy: Portfolio-side amounts
    └── settle_value/settle_ccy: Asset-side amounts

assets (id:uuid)
├── ticker: text (primary identifier)
├── resolved_ticker: text (Yahoo Finance symbol)
├── price_multiplier: numeric = 1 (ADR/split factor)
├── currency: text = 'GBP'
├── status: text = 'active' (active/delisted/failed)
└── resolution_attempted_at: timestamp (retry cooldown)

prices (ticker:text) - Live price cache
├── price: numeric (current Yahoo Finance price)
├── previous_close: numeric
├── price_multiplier: numeric = 1
└── updated_at: timestamp

fx_rates (date:text) - Daily FX cache
├── source: text = 'GBP'
└── quotes: jsonb (e.g., {"GBPUSD": 1.29})
```

### Critical Database Trigger
```sql
-- Auto-mirrors settle_* fields to cash_* for simple transactions
trg_transactions_mirror_settle_to_cash() ON transactions BEFORE INSERT/UPDATE
```

## Key Data Flow Patterns

### Transaction-Centric Design
All portfolio data derives from `transactions` table. No separate "holdings" table - positions are calculated on-demand from transaction history in `src/lib/queries.ts`:

```typescript
// Core transaction types in TRANSACTION_TYPE_META
BUY/SELL: { units: ±1, cost: ±1, realised: 1 }  // Position + P&L impact
TIN/TOT:  { units: ±1, cost: ±1, realised: 0 }  // In-kind transfers
DIV/INT:  { units: 0,  cost: 0,  realised: 1 }  // Income (cash-only)
SPL:      { units: 0,  cost: 0,  realised: 0 }  // Stock splits
BAL:      { units: ±1, cost: 0,  realised: 0 }  // Cash adjustments
```

### Dual-Currency Transaction Model
```typescript
// Each transaction has TWO currency sides:
settle_value/settle_ccy  // Asset side (e.g., $100 USD for AAPL)
cash_value/cash_ccy      // Portfolio side (e.g., £80 GBP equivalent)
cash_fx_to_portfolio     // Implied FX rate between the two
```

### Price Data Pipeline
```typescript
// src/lib/prices.ts - Smart caching with eligibility
1. Check asset.status != 'failed' OR 24h cooldown expired
2. Use asset.resolved_ticker || asset.ticker for Yahoo Finance
3. Apply asset.price_multiplier (e.g., 0.01 for GBp→GBP)
4. Cache in prices table with TTL (5min market open, 60min closed)
```

## Development Workflows

### Key Commands
```bash
npm run dev              # Development server
npm run refresh:prices   # Manual price refresh (uses service role)
npm run audit:prices     # Debug price fetching with detailed logs
npm run build           # Production build
```

### Database Access Patterns
```typescript
// Server Components: Use server client with auth context
const supabase = await getSupabaseServerClient();

// Client Components: Browser client for realtime/mutations  
const supabase = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// Scripts: Service role for elevated privileges (bypass RLS)
const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
```

## Project-Specific Conventions

### Holdings Calculation (src/lib/queries.ts)
```typescript
// Holdings are NEVER stored - always calculated from transactions:
getPortfoliosWithHoldingsAndCash() // Per-portfolio breakdown
getAllHoldingsAndCashSummary()     // Global aggregation

// Key functions:
applyTransactionToHolding()        // Updates position + cost basis
calculateCashBalancesMulti()       // Multi-currency cash totals
```

### Currency Handling
```typescript
// Three currency domains:
1. Asset Currency: assets.currency (native ticker currency)
2. Portfolio Base: portfolios.base_currency (user's base, e.g., GBP)  
3. Settlement Currency: Per-transaction via settle_ccy field

// FX conversion chain:
Asset Price (USD) → Portfolio Base (GBP) → Display Currency
```

### CSV Import Architecture (src/app/api/import-transactions/)
```typescript
// Sophisticated import pipeline:
1. Parse CSV with fuzzy header matching
2. Auto-resolve tickers (try .L suffix for LSE)
3. Create missing assets with Yahoo Finance metadata
4. Handle complex currency/multiplier logic
5. Batch insert with transaction validation
```

### Price Eligibility System
```typescript
// Smart retry logic in src/lib/prices.ts:
if (asset.status === 'failed' && resolution_attempted_at < 24h_ago) {
  // Skip ticker to avoid API quota waste
} else {
  // Attempt fetch and update status/resolution_attempted_at
}
```

## Component Patterns

### Real-time Updates
```typescript
// LivePricesRefresher.tsx - Hybrid approach:
1. Supabase Realtime subscriptions for instant updates
2. Visibility-aware polling fallback (15s intervals)  
3. Smart throttling with router.refresh()
```

### Caching Strategy
```typescript
// Next.js 15 unstable_cache with tags:
const getFxCached = unstable_cache(fetchExchangeRatesToGBP, ['fx-v1'], 
  { revalidate: 60, tags: ['fx'] });
const getPricesCached = unstable_cache(fetchAndCachePrices, ['prices-v1'], 
  { revalidate: 30, tags: ['prices'] });
```

### UI State Management
```typescript
// No global state - leverage:
1. Server Components for initial data (auth-aware)
2. URL params for filters/navigation (transactions page)
3. Local storage for UI preferences (portfolio layout)
4. Supabase auth context for user state
```

## Integration Points

### External API Quotas
- **Yahoo Finance**: No official limits, but rate-limited internally (BATCH_SIZE=10)
- **ExchangeRate.host**: Daily cache in fx_rates table, fallback to 1:1 GBP
- Both APIs have graceful degradation strategies

### Authentication Flow
```typescript
// middleware.ts enforces auth on all routes except:
/auth/*, /login, /_next/*, /favicon*, /public/*

// RLS policies isolate user data automatically
// Service role bypasses RLS for system operations (price refresh)
```

## Critical Debugging Patterns

### Transaction Debugging
```sql
-- Check transaction currency mappings:
SELECT type, cash_value, cash_ccy, settle_value, settle_ccy 
FROM transactions WHERE portfolio_id = 'uuid';

-- Verify holdings calculation:
SELECT * FROM transactions WHERE asset_id = 'uuid' ORDER BY date, created_at;
```

### Price System Debugging
```typescript
// Check price eligibility:
console.log(asset.status, asset.resolution_attempted_at);

// Verify price multipliers:  
console.log(rawPrice * asset.price_multiplier);
```

### Common Gotchas
1. **GBp vs GBP**: London stocks trade in pence - check price_multiplier=0.01
2. **Transaction Ordering**: Use stable sort by (date, created_at, id) for consistent holdings
3. **Currency Domains**: Always specify which currency domain you're working in
4. **Service Role**: Required for price refresh scripts due to RLS policies