# HoldingsHub

Multi-portfolio investment tracker built with Next.js 15 and Supabase.

Highlights
- Live prices (Yahoo Finance) with caching and multipliers (GBp→GBP)
- Daily FX rates and multi-currency cash balances
- Transaction-centric modeling (BUY/SELL/TIN/TOT/DIV/INT/SPL/BAL)
- Realtime UI updates and accessibility-friendly tables

## Local dev

```powershell
npm install
npm run dev
```

Open http://localhost:3000

Set env in .env.local:
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY (for import/price scripts)

## Deploy

See DEPLOY.md for Docker + Caddy setup and Proxmox notes.
