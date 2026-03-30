#!/bin/bash
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
export DATABASE_URL='postgresql://neondb_owner:npg_dk3DUt5ZNWqO@ep-muddy-bread-agpt6182.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
export PORT=3000
export NODE_ENV=development
export OPENROUTE_API_KEY=5b3ce3597851110001cf6248ffcbee0ca1a245bb83ea094aa7a4ffd3
export GOOGLE_PLACES_API_KEY=AIzaSyAb4RT_7ZdE3hufvEJiM08QeTM-HgUjfdA
export CRON_SECRET=dev-secret-change-in-production
export TOMTOM_API_KEY=X08cVAKj606lY5aWLdg1yfW8Vl9j7Tjv
export FRONTEND_URL=http://localhost:5173

cd /Users/samuelefelici/traffic/artifacts/api-server
exec npx tsx ./src/index.ts
