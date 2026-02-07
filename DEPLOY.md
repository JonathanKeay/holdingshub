# Deploying HoldingsHub on Proxmox (Docker + Caddy)

This guide gets HoldingsHub reachable from mobile and desktop via a domain with HTTPS, running on a Proxmox VM using Docker.

## Prereqs
- Proxmox VM (Ubuntu/Debian recommended) with Docker and Docker Compose V2 installed
- A domain name pointing to your VM's public IP (A/AAAA record)
- Supabase project credentials

## Files added in this repo
- `Dockerfile` – multi-stage build producing a small standalone runtime
- `.dockerignore` – keeps build context small and secrets out of images
- `docker-compose.yml` – app + Caddy reverse proxy (TLS)
- `Caddyfile` – minimal HTTPS reverse proxy config
- `.env.docker` – template for runtime env vars

## Configure environment
1) Copy `.env.docker` and fill in values:
   - `PUBLIC_URL=https://your-domain.example`
   - `SITE_DOMAIN=your-domain.example`
   - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
2) Optional: add any API keys used by scripts.

## Build and run
From the repo root on your VM:

```sh
# Build image
docker compose build
# Start services (app + Caddy)
docker compose up -d
# View logs
docker compose logs -f
```

The site should be available at `https://your-domain.example` within ~30s.

## Updating
```sh
git pull
docker compose build --no-cache app
docker compose up -d
```

## Running scripts (optional)
Use `docker compose run --rm app node scripts/refreshPrices.js` etc. Ensure required keys are in `.env.docker`.

## Notes
- We set Next.js `output: 'standalone'` so the container ships only the server and deps it needs.
- Caddy handles TLS automatically via Let's Encrypt. Ensure port 80/443 are open to the VM.
- If you already have a reverse proxy in Proxmox, you can remove the `caddy` service and instead point your existing proxy at `app:3000`.

### Internal vs external URLs (important)

- Inside Docker, services can talk to each other using the service name on the Docker network. In this stack the app service is named `app`, so other containers (like the price streamer) call the app at `http://app:3000`.
- From your browser or any machine on your LAN, `app` is NOT a resolvable hostname. You must use the external address served by Caddy, e.g. `http://192.168.50.227` (or your domain).
- Therefore, seeing `https://app:3000/...` fail in a browser is expected. That URL is only valid from inside the Docker network.
- The price streamer’s `REVALIDATE_URL` is intentionally set to `http://app:3000/api/prices/revalidate` to avoid leaving the Docker network and to work even if the host’s LAN IP changes. Do not paste this into a browser; use the LAN/domain instead.

### Expected update cadence

- US tickers stream over Finnhub WS. We flush any new trades roughly every 15 seconds, but we only write when a new tick arrives or the price moves beyond small epsilon thresholds. Illiquid symbols may not change every flush.
- Non‑US tickers are polled via Yahoo roughly every 5 minutes.
- The UI also polls a lightweight version endpoint (default 15s on the dashboard) and will refresh when any tracked ticker updates.

## Development with Docker Compose

For a dev LXC where you want hot reload and the price streamer running inside containers:

```sh
# Ensure .env has your dev Supabase creds (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.)
# Start the dev stack (app hot-reload + prices streamer)
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f app
docker compose -f docker-compose.dev.yml logs -f prices
```

This uses a bind mount of `/opt/holdingshub` into the containers and runs `npm ci` automatically if `node_modules` is missing.

If you get a permissions error talking to the Docker daemon, either run with sudo or add your user to the docker group:

```sh
sudo usermod -aG docker $USER
newgrp docker  # or log out and back in
```
