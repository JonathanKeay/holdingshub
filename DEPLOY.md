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
