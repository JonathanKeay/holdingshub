# HoldingsHub

Multi-portfolio investment tracker built with Next.js 15 and Supabase.

## Environment Topology (authoritative — read before touching anything production-facing)

| Host | Role | Notes |
|---|---|---|
| `172.16.20.223` (`holdingshub-dev`) | **DEV** | This repo's usual working checkout. All day-to-day development happens here. |
| `172.16.20.225` (`holdingshub-prod`) | **CURRENT PRODUCTION** | Runs via systemd — `holdingshub-prod.service` + `holdingshub-prices.service` — not Docker/Caddy. See [deploy/systemd](deploy/systemd). |
| `172.16.20.227` | **LEGACY / RETIRED** | Was production before the 2026-09-14 promotion to 225. No longer serves live traffic; kept only as an old/backup environment. |
| Hosted Supabase project `portfolio-tracker` | **PRODUCTION** | Treat as protected regardless of which app host is live. |

`DEPLOY.md`, the root `Caddyfile`, and `docker-compose.yml` describe the **retired** Docker Compose + Caddy stack that used to run on 227. They're kept for historical/rollback reference only — see the banners on those files, and "Stack Model" below.

_Last confirmed: 2026-09-22._

Highlights
- Live prices (Yahoo Finance) with caching and multipliers (GBp→GBP)
- Daily FX rates and multi-currency cash balances
- Transaction-centric modeling (BUY/SELL/TIN/TOT/DIV/INT/SPL/BAL)
- Realtime UI updates and accessibility-friendly tables

# HoldingsHub

Multi-portfolio investment tracker built with Next.js 15 and Supabase.

See the day‑2 setup guide in [docs/DevSetup.md](docs/DevSetup.md) for local and Docker workflows, environment variables, and troubleshooting.

## Stack Model

- **Current production**: systemd units on `172.16.20.225` — `holdingshub-prod.service` (app) + `holdingshub-prices.service` (price streamer). See [deploy/systemd](deploy/systemd). This has been the canonical production runtime since the 2026-09-14 promotion.
- **Legacy production (retired)**: [docker-compose.yml](docker-compose.yml) with Caddy proxy on 80/443 → app:3000, previously used on the host at `172.16.20.227`. No longer live production — kept for historical/rollback reference. See `DEPLOY.md`.
- Dev stack: [docker-compose.dev.yml](docker-compose.dev.yml) is optional and only runs when explicitly invoked, for local Docker-based development — unrelated to which stack serves production.

Guidelines
- If ever reviving the legacy Docker stack, change `NEXT_PUBLIC_*` envs only via the compose env file, then rebuild the app container to bake client envs.
- Keep one compose stack active per host to avoid port conflicts or competing services.

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

Current production deploys via systemd on `172.16.20.225` — see [deploy/systemd](deploy/systemd). `DEPLOY.md` documents the retired Docker + Caddy method (previously `172.16.20.227`) for historical/rollback reference.
