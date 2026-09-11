# Day‑2 Development Setup (VS Code + Docker)

This guide gets you back to a working dev environment quickly, locally or via Docker.

## Prereqs

- Node.js 22.x
- Docker + Docker Compose
- Git
- VS Code extensions: Docker, ESLint, Tailwind CSS IntelliSense, Supabase (optional)

## Local Dev (no Docker)

1. Install dependencies:

```bash
npm ci
```

2. Create `.env.local` (client-side runtime config):

```env
NEXT_PUBLIC_APP_ORIGIN=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=YOUR_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

3. Start the app:

```bash
npm run dev
```

Open http://localhost:3000

## Docker Dev (hot reload)

The dev stack mounts your repo and runs `npm run dev` inside `node:22-alpine`.

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml logs -f app
```

Open http://localhost:3000

Stop the stack:

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Production Stack (server)

Prod is defined in `docker-compose.yml` and served by Caddy at http://172.16.20.227.

```bash
docker compose build --no-cache app
docker compose up -d
docker compose ps
docker compose logs --tail=120 app
```

## Environment Files

- Docker runtime: `.env.docker` — public origin is set to `http://172.16.20.227`.
- Local dev: `.env.local` — use `http://localhost:3000`.
- Build-time in Docker: `NEXT_PUBLIC_*` are baked into the client bundle via Dockerfile `ARG`s — rebuild after changes.

## Price Streamer

Local:

```bash
npm run prices:stream
```

Docker (prod): `prices` service runs automatically.

## Troubleshooting

- Port busy:

```bash
ss -ltnp | awk 'NR==1 || /:3000|:4000/'
```

- Caddy → app routing: see `Caddyfile` (proxies to `app:3000`).
- Icons/logos: proxy uses Logo.dev only (see `src/app/api/logo-proxy/route.ts`).

## Housekeeping

Avoid running dev and prod stacks on the same host simultaneously.
Backups (`*.bak.*`) should be removed to prevent confusion.
