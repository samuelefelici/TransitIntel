# TransitIntel Workspace

## Overview

pnpm workspace monorepo using TypeScript. Full-stack public transport planning intelligence platform for the Ancona/Marche province of Italy.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM (no PostGIS — using coordinate math instead)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Frontend**: React + Vite + Tailwind CSS v4 + Shadcn UI
- **Maps**: Mapbox GL JS via `react-map-gl/mapbox`
- **Charts**: Recharts
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── transitintel/       # React + Vite frontend
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## TransitIntel Feature Pages

- `/dashboard` — Full-screen Mapbox map with layer toggles (traffic heatmap, demand heatmap, POIs, GTFS stops) and live status overlay
- `/traffic` — Traffic analysis charts (by hour, by day of week) with Recharts
- `/territory` — Population density & POI distribution analysis
- `/stops` — Bus stop CRUD management with nearby POI/population data
- `/reports` — Demand analysis, underserved area table with export to CSV
- `/gtfs` — GTFS feed upload (drag & drop zip), route/stop/trip visualization, feed management

## Database Tables

- `traffic_snapshots` — TomTom traffic data (speed, congestion per point)
- `census_sections` — ISTAT population data (centroid, population, density)
- `points_of_interest` — OSM POIs (schools, hospitals, shopping, industrial, leisure, office, transit)
- `bus_stops` — Bus stop CRUD (name, code, lat/lng, lines)
- `bus_routes` — Bus routes (lineCode, name, serviceType)

## API Routes

### Data API
- `GET /api/traffic` — Traffic snapshots
- `GET /api/traffic/heatmap` — Heatmap data by hour/day
- `GET /api/traffic/stats` — Aggregated traffic statistics
- `GET /api/poi?categories=...` — POIs with category filter
- `GET /api/population/density` — Census section polygons
- `GET /api/stops` — Bus stops list
- `POST/PUT/DELETE /api/stops/:id` — CRUD for stops
- `GET /api/stops/:id/nearby` — Nearby POIs and population for a stop
- `GET /api/routes` — Bus routes
- `POST/DELETE /api/routes/:id` — CRUD for routes
- `GET /api/analysis/coverage` — Population coverage analysis
- `GET /api/analysis/demand-score` — Composite demand score grid
- `GET /api/analysis/underserved` — High-demand zones without stops
- `GET /api/analysis/stats` — Dashboard summary stats

### Cron Routes (Protected by CRON_SECRET header)
- `POST /api/cron/traffic` — Ingest TomTom traffic data
- `POST /api/cron/poi` — Ingest OSM Overpass POIs
- `POST /api/cron/population` — Upsert ISTAT census sections

## Environment Variables / Secrets

- `DATABASE_URL` — PostgreSQL connection (auto-provisioned)
- `MAPBOX_TOKEN` — Mapbox GL JS public token (used as `VITE_MAPBOX_TOKEN` via vite.config.ts define)
- `TOMTOM_API_KEY` — TomTom Traffic API key
- `CRON_SECRET` — Secret header for cron endpoint protection
- `PROVINCE_BBOX` — Optional: bounding box override (default: `12.9,43.3,13.9,43.9`)

## Seeded Data

- **Traffic**: 57 points on real Marche roads (A14, SS76, Tangenziale, urban streets). Max lng 13.606 — all on land
- **POI**: 86 POIs across the province in 7 categories (hospital, school, shopping, transit, industrial, leisure, office). All on land
- **Census**: 42 sections covering the whole province (Ancona, Jesi, Senigallia, Fabriano, Osimo, etc.). Max lng 13.606 — all on land. Total pop 348,500
- **Demand/Underserved**: No synthetic grid — endpoints use census centroids + POI coordinates only (guaranteed on land)
- **Coverage**: Real spatial query; 13 manual stops → 24.5% population coverage, 30 underserved zones

## Important Notes

- `react-map-gl` v8 requires importing from `react-map-gl/mapbox` (not `react-map-gl`)
- `VITE_MAPBOX_TOKEN` is injected via Vite `define` in `vite.config.ts` from the `MAPBOX_TOKEN` secret
- Drizzle schema uses `doublePrecision` (not `float8`) for floating-point columns
- `db.execute(sql\`...\`)` returns `{ rows: [...] }` — always use `result.rows[0]`, not destructuring
- Province bbox for Ancona/Marche: `12.9,43.3,13.9,43.9`; eastern coast at ~13.52 (Ancona), 13.22 (Senigallia) — nothing east of 13.62 is on land
- Tailwind v4: no `@apply ... !important`; use raw CSS
