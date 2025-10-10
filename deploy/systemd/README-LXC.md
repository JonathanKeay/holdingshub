# Running on Proxmox LXC (no Docker)

Two options:
1) Run natively with Node + systemd (simple and lightweight)
2) Run Docker inside LXC (requires nesting)

## Option 1: Native (recommended for simplicity)
- Pros: Smallest overhead, easiest to debug
- Cons: You manage Node version yourself

Steps:
1. Create an Ubuntu/Debian LXC and enable `features: keyctl=1,nesting=1` if you need build tools.
2. Install Node.js 22 LTS:
   - Using NodeSource or nvm (ensure `node -v` shows 22.x)
3. Clone repo to `/opt/portfolio-tracker` and `cd` into it.
4. Install dependencies and build:
   ```sh
   npm ci
   npm run build
   ```
5. Create an `.env.local` with your production secrets (similar to `.env.docker`).
6. Install the systemd service:
   ```sh
   sudo cp deploy/systemd/portfolio-tracker.service /etc/systemd/system/portfolio-tracker.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now portfolio-tracker
   ```
7. Put a reverse proxy in front (Caddy/NGINX/Traefik on Proxmox host or another LXC) and point it to `LXC_IP:3000`.

## Option 2: Docker inside LXC
- Pros: Same config as VM, reproducible
- Cons: Extra nesting complexity and permissions

Steps:
1. Ensure LXC has nesting enabled: `features: nesting=1`.
2. Install Docker in the LXC.
3. Use the repo's `docker-compose.yml` and `.env.docker` like in the VM guide.

## Reverse proxy on Proxmox host
If you don't want TLS in the LXC, run Caddy/NGINX on the Proxmox host and reverse_proxy to the container IP:3000.
