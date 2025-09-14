#!/usr/bin/env bash
set -e

# Enable pnpm via Corepack
corepack enable
corepack prepare pnpm@latest --activate

# Install deps if package.json exists
if [ -f package.json ]; then
  pnpm install
fi

echo "✅ Dev container ready. Next steps:"
echo "1) Create .env.local and paste your keys"
echo "2) Run: pnpm dev"
