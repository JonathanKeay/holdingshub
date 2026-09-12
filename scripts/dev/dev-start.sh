#!/usr/bin/env bash
set -e

cd /opt/holdingshub

echo "Starting local Supabase..."
npx supabase start

echo "Starting HoldingsHub dev server..."
nohup npm run dev > /tmp/holdingshub-dev.log 2>&1 &

echo "Starting price streamer..."
nohup env DOTENV_CONFIG_PATH=.env.local npm run prices:stream > /tmp/holdingshub-prices.log 2>&1 &

echo
echo "HoldingsHub dev environment started."
echo "App:      http://172.16.20.223:3000"
echo "Supabase: http://172.16.20.223:54321"
echo "Studio:   http://172.16.20.223:54323"
