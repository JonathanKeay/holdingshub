#!/usr/bin/env bash

echo "=== HoldingsHub Dev Status ==="
echo

echo "Next.js:"
pgrep -af "next dev" || echo "Not running"

echo
echo "Price streamer:"
pgrep -af "price-streamer.ts" || echo "Not running"

echo
echo "Supabase:"
if docker ps --format '{{.Names}}' | grep -q '^supabase_db_holdingshub$'; then
  echo "Running"
else
  echo "Not running"
fi
