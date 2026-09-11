# HoldingsHub

Multi-portfolio investment tracker built with Next.js 15 and Supabase.

Highlights
- Live prices (Yahoo Finance) with caching and multipliers (GBp→GBP)
- Daily FX rates and multi-currency cash balances
- Transaction-centric modeling (BUY/SELL/TIN/TOT/DIV/INT/SPL/BAL)
- Realtime UI updates and accessibility-friendly tables

# HoldingsHub

Multi-portfolio investment tracker built with Next.js 15 and Supabase.

See the day‑2 setup guide in [docs/DevSetup.md](docs/DevSetup.md) for local and Docker workflows, environment variables, and troubleshooting.

## Stack Model

- Canonical stack: [docker-compose.yml](docker-compose.yml) with Caddy proxy on 80/443 → app:3000. Use this for the host at 172.16.20.227.
- Dev stack: [docker-compose.dev.yml](docker-compose.dev.yml) is optional and only runs when explicitly invoked. It should not be active on the same host as the prod stack.
- Systemd units in [deploy/systemd](deploy/systemd) are legacy and provided for reference; Docker Compose is the primary runtime.

Guidelines
- Change `NEXT_PUBLIC_*` envs only via the compose env file, then rebuild the app container to bake client envs.
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

See DEPLOY.md for Docker + Caddy setup and Proxmox notes.
