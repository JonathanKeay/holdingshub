#!/usr/bin/env bash

echo "Stopping HoldingsHub processes..."
pkill -f "next dev" 2>/dev/null || true
pkill -f "price-streamer.ts" 2>/dev/null || true

echo "Stopping local Supabase..."
cd /opt/holdingshub
npx supabase stop

echo "Development environment stopped."
