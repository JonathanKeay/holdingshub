# Running HoldingsHub on Proxmox LXC

## Current environment topology (authoritative — confirmed directly on the live host)

- `172.16.20.223` (`holdingshub-dev`) = **DEV** — this repo's usual working checkout.
- `172.16.20.225` (`holdingshub-prod`) = **CURRENT PRODUCTION** — runs natively via systemd (no Docker). Repo at `/opt/holdingshub`, production env file at `/etc/holdingshub/holdingshub-prod.env`.
  - `holdingshub-prod.service` — the app (`npm start`)
  - `holdingshub-prices.service` — the realtime price streamer (`npm run prices:stream`)
  - Both confirmed **active and running** on 225 as of 2026-09-22, by reading the live installed unit files directly. `deploy/systemd/holdingshub-prod.service` and `deploy/systemd/holdingshub-prices.service` in this repo now mirror that live configuration.
- `172.16.20.227`, and the Docker Compose + Caddy stack ("Option 2" below, plus the root `docker-compose.yml` / `Caddyfile` / `DEPLOY.md`), are **legacy/retired** — not current production. Kept for historical/rollback reference only.
- `deploy/systemd/portfolio-tracker.service` is an old-named unit **confirmed absent** from the live 225 host — do not install it.
- Hosted Supabase project `portfolio-tracker` is production regardless of which app host is live.

_Last confirmed directly against the live 225 host: 2026-09-22._

Two deployment options exist in this repo; only Option 1 is current production.

## Option 1: Native with Node + systemd (current production method)

Steps:
1. Create an Ubuntu/Debian LXC and enable `features: keyctl=1,nesting=1` if you need build tools.
2. Install Node.js 22 LTS:
   - Using NodeSource or nvm (ensure `node -v` shows 22.x)
3. Clone the repo to `/opt/holdingshub` and `cd` into it.
4. Install dependencies and build:
   ```sh
   npm ci
   npm run build
   ```
5. Create the production env file at `/etc/holdingshub/holdingshub-prod.env` with your production secrets (`SUPABASE_SERVICE_ROLE_KEY`, `FINNHUB_API_KEY`, etc.).
6. Install the systemd services — these unit files already reflect the live 225 configuration:
   ```sh
   sudo cp deploy/systemd/holdingshub-prod.service /etc/systemd/system/holdingshub-prod.service
   sudo cp deploy/systemd/holdingshub-prices.service /etc/systemd/system/holdingshub-prices.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now holdingshub-prod
   sudo systemctl enable --now holdingshub-prices
   # Tail logs
   journalctl -u holdingshub-prod -f
   journalctl -u holdingshub-prices -f
   ```
7. Put a reverse proxy in front if you need TLS/a domain (Caddy/NGINX/Traefik on the Proxmox host or another LXC), pointing to `LXC_IP:3000`. The retired 227 stack ran Caddy in-container as part of Docker Compose — see `DEPLOY.md` (marked legacy) if you're specifically looking at that older approach, not as a guide for 225.

### Development services

For a dev LXC with your dev checkout under `/opt/holdingshub-dev` and env at `/opt/holdingshub-dev/holdingshub-dev.env`:

```sh
sudo cp deploy/systemd/holdingshub-dev.service /etc/systemd/system/holdingshub-dev.service
sudo cp deploy/systemd/holdingshub-prices-dev.service /etc/systemd/system/holdingshub-prices-dev.service
sudo systemctl daemon-reload
sudo systemctl enable --now holdingshub-dev
sudo systemctl enable --now holdingshub-prices-dev

# Tail logs
journalctl -u holdingshub-dev -f
journalctl -u holdingshub-prices-dev -f
```

(Note: this repo's actual dev host, 223/`holdingshub-dev`, is normally driven via `scripts/dev/dev-start.sh` rather than these dev systemd units — see the project's top-level `CLAUDE.md`. These unit files remain here for an LXC-native dev setup that doesn't use that script.)

## Option 2: Docker inside LXC (legacy/retired — not current production)

This was the deployment method for the retired `172.16.20.227` host, superseded by Option 1 above on 225 as of the 2026-09-14 promotion. Kept for historical/rollback reference only.

- Pros: Same config as VM, reproducible
- Cons: Extra nesting complexity and permissions

Steps:
1. Ensure LXC has nesting enabled: `features: nesting=1`.
2. Install Docker in the LXC.
3. Use the repo's `docker-compose.yml` and `.env.docker` — see `DEPLOY.md` (also marked legacy).

## Legacy unit files in this directory

- `portfolio-tracker.service` — an older, generically-named standalone unit (pre-dating the `holdingshub-prod`/`holdingshub-prices` split, uses the old `/opt/portfolio-tracker` path). Confirmed absent from the live 225 host. Kept for historical reference only — see the deprecation banner in the file itself.

## Reverse proxy on Proxmox host

If you don't want TLS in the LXC, run Caddy/NGINX on the Proxmox host and reverse_proxy to the container IP:3000. This note predates the current 225 setup — confirm the actual reverse-proxy arrangement on 225 (if any) before relying on it.
