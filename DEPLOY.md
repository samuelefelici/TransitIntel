# 🚀 TransitIntel — Guida Deploy (Coolify, self-hosted)

## Architettura Produzione

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Web (Dockerfile.web)│────▶│  API (Dockerfile.api)│────▶│  PostgreSQL          │
│  React + Vite build  │     │  Express + Node 20   │     │  self-hosted         │
│  servito da nginx :80│     │  + Python (OR-Tools) │     │  (servizio Coolify)  │
│  su Coolify          │     │  :3000 su Coolify    │     │                      │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

Tutto gira su **Coolify** (self-hosted). Vercel/Render/Neon sono **legacy** e non più
usati: i file `vercel.json` (rimosso) e `render.yaml` appartengono alla vecchia
architettura e possono essere ignorati/eliminati.

I tre componenti sono tre **risorse Coolify** nello stesso progetto, così possono
parlarsi via rete interna:

| Componente | Sorgente build | Porta | Note |
|---|---|---|---|
| **Database** | immagine PostgreSQL di Coolify | 5432 | schema da `setup.sql` + `migrations/` |
| **API** | `Dockerfile.api` (repo) | 3000 | start: `node artifacts/api-server/dist/index.cjs` |
| **Web** | `Dockerfile.web` (repo) | 80 | nginx serve la SPA (`artifacts/transitintel/dist`) |

---

## STEP 1: Database — PostgreSQL su Coolify

1. Nel progetto Coolify: **+ New → Database → PostgreSQL** (versione 15+).
2. Scegli nome, utente e password; avvialo.
3. Annota l'**hostname interno** del servizio (Coolify lo espone agli altri
   servizi dello stesso progetto via rete privata) e l'eventuale **URL pubblico**.
4. Applica lo schema. Da un client con accesso al DB:
   ```bash
   psql "$DATABASE_URL" -f setup.sql
   psql "$DATABASE_URL" -f migrations/2026-05_caronte_and_stop_classification.sql
   psql "$DATABASE_URL" -f migrations/2026-06_operations_live.sql   # Sala Operativa + GTFS-RT
   # opzionale, validatore Caronte:
   psql "$DATABASE_URL" -f caronte_setup.sql
   ```
   > In alternativa puoi incollare il contenuto degli `.sql` in un SQL editor.
   > Alcune tabelle (es. polimetriche, snapshot) vengono create **lazy**
   > dall'API al primo uso (`CREATE TABLE IF NOT EXISTS`), quindi non serve
   > una migration manuale per quelle.

> ✅ Conserva la connection string. Forma tipica su rete interna Coolify (senza SSL):
> `postgres://user:password@<servizio-db>:5432/dbname`
> Se il DB è esposto pubblicamente con certificato self-signed, usa
> `?sslmode=no-verify` **oppure** imposta `PGSSL_NO_VERIFY=1` (vedi env).

---

## STEP 2: Backend API — `Dockerfile.api`

1. **+ New → Application → da repository Git** (collega questo repo).
2. Build: **Dockerfile**, percorso `Dockerfile.api`. Branch: `main`.
3. Porta esposta: **3000**.
4. Imposta le **variabili d'ambiente** (vedi tabella in fondo). Minime:
   - `DATABASE_URL` (verso il servizio DB di Coolify)
   - `PGSSL_NO_VERIFY=1` se il Postgres usa un certificato self-signed
   - `NODE_ENV=production`, `PORT=3000`
   - `JWT_SECRET` (genera con `openssl rand -hex 32`) — **OBBLIGATORIO**: senza,
     in produzione l'API rifiuta l'avvio (i token sarebbero forgiabili)
   - `CERBERO_API_KEY` — **OBBLIGATORIA** se usi Caronte (validatore/AVM): senza,
     gli endpoint `/api/caronte/*` rispondono 503 fail-closed
   - `CRON_SECRET` (genera con `openssl rand -hex 32`)
   - `FRONTEND_URL` = dominio pubblico del Web (per il CORS, allowlist ESATTA di
     origin) — lo completi allo STEP 4
   - chiavi opzionali: `TOMTOM_API_KEY`, `MAPBOX_TOKEN`, `GOOGLE_PLACES_API_KEY`, `OPENROUTE_API_KEY`
5. Deploy. Il build compila le librerie, builda l'API e installa OR-Tools
   (Python) — può richiedere qualche minuto.
6. Assegna un **dominio** all'API (Coolify fornisce HTTPS via Traefik/Let's Encrypt),
   es. `https://api.transitintel.tuodominio.it`. Verifica `GET /api/healthz`.

> L'API ha bisogno di **Python + OR-Tools** per gli scheduler: ci pensa
> `Dockerfile.api` (installa `python3` e fa `pnpm run build:deploy`, che include
> `install:python`). Non serve configurare nulla a mano.

---

## STEP 3: Frontend Web — `Dockerfile.web`

1. **+ New → Application → da repository Git** (stesso repo).
2. Build: **Dockerfile**, percorso `Dockerfile.web`. Branch: `main`.
3. Porta esposta: **80**. Assegna un **dominio** (HTTPS), es. `https://transitintel.tuodominio.it`.

> ⚠️ **Importante — variabili `VITE_*` sono build-time.**
> Vite "cuoce" le variabili `VITE_...` **durante il build** (stage builder del
> `Dockerfile.web`), non a runtime. Vanno quindi fornite come **build args / env
> di build** in Coolify, altrimenti finiscono vuote nel bundle. Le principali:
> - `VITE_MAPBOX_TOKEN` — token Mapbox per le mappe.
> - `VITE_API_BASE_URL` — URL pubblico dell'API (es. `https://api.transitintel.tuodominio.it`).

> ℹ️ **Come il Web raggiunge l'API.** `nginx.conf` serve solo la SPA e **non** fa
> proxy di `/api`. Hai due strade valide:
> 1. **Cross-origin (consigliata qui):** imposta `VITE_API_BASE_URL` (build-time)
>    al dominio dell'API. Il frontend chiama direttamente l'API su un altro dominio;
>    il cookie di sessione `ti_auth` è `SameSite=None; Secure`, quindi **entrambi i
>    domini devono essere in HTTPS** (Coolify lo fa) e l'API deve avere
>    `FRONTEND_URL` corretto per il CORS.
> 2. **Same-origin via proxy:** instradi `/api` verso il servizio API (reverse
>    proxy / regola di dominio Coolify) e lasci `VITE_API_BASE_URL` vuoto. In
>    questo caso il cookie può restare `SameSite=Lax`.

---

## STEP 4: Collegamento Web ↔ API (CORS + cookie)

1. Sull'**API** imposta `FRONTEND_URL` = dominio pubblico del **Web**
   (es. `https://transitintel.tuodominio.it`). Abilita il CORS e l'invio del cookie.
2. Sul **Web**, assicurati che `VITE_API_BASE_URL` (build-time) punti all'API e
   **ri-builda** (le `VITE_*` cambiano solo con un nuovo build).
3. Entrambi su **HTTPS** (necessario per il cookie cross-site `SameSite=None; Secure`).

---

## STEP 5: Popola i Dati

Dall'app, pagina **"Dati & GTFS" / "Sincronizza Dati"**:
1. **Popolazione — ISTAT** → comuni della provincia di Ancona
2. **Punti di Interesse** → Google Places o OpenStreetMap
3. **Traffico — TomTom** → primo snapshot
4. **Import GTFS** → carica il feed (Conerobus)

Oppure da terminale (sostituisci il dominio API e il secret):
```bash
curl -X POST https://api.transitintel.tuodominio.it/api/cron/census \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

curl -X POST https://api.transitintel.tuodominio.it/api/cron/poi \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

curl -X POST https://api.transitintel.tuodominio.it/api/cron/traffic \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"
```

---

## Variabili d'Ambiente

Riferimento completo in `.env.example`. Sintesi:

### API (`Dockerfile.api`) — runtime

| Key | Obbligatoria | Note |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://user:pass@<servizio-db>:5432/dbname` |
| `PGSSL_NO_VERIFY` | — | `1` se Postgres usa certificato self-signed |
| `NODE_ENV` | ✅ | `production` |
| `PORT` | ✅ | `3000` |
| `JWT_SECRET` | ✅ | `openssl rand -hex 32` |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32` (header `x-cron-secret`) |
| `FRONTEND_URL` | ✅ | dominio del Web (CORS) |
| `TOMTOM_API_KEY` | — | traffico |
| `MAPBOX_TOKEN` | — | usi server-side mappe |
| `GOOGLE_PLACES_API_KEY` | — | sync POI |
| `OPENROUTE_API_KEY` | — | isocrone pedonali |
| `PROVINCE_BBOX` | — | default `12.7,43.2,13.65,43.95` |
| `LOG_LEVEL` | — | `info` / `debug` / `warn` / `error` |
| `COPILOT_MODEL` | — | override modello provider AI |
| `CERBERO_API_KEY` | — | Bearer key per `/api/caronte/*` (validatore + AVM) |
| `GTFS_RT_API_KEY` | — | key per i feed `/api/gtfs-rt/*` (vuota = feed pubblico) |
| `GTFS_FEED_ID` | — | forza il feed GTFS usato da Sala Operativa / caronte |

### Web (`Dockerfile.web`) — **build-time** (build args)

| Key | Note |
|---|---|
| `VITE_API_BASE_URL` | URL pubblico dell'API (vuoto se usi un proxy same-origin) |
| `VITE_MAPBOX_TOKEN` | token Mapbox per le mappe nel frontend |

---

## Cron Jobs (Opzionale)

Automatizza la raccolta dati con uno scheduler esterno (es. **cron-job.org**) o
con i cron interni di Coolify:

| Job | Endpoint | Schedule consigliato |
|---|---|---|
| Traffico | `POST /api/cron/traffic` | ogni 15 min |
| POI | `POST /api/cron/poi` | 1° del mese, ore 3:00 |
| Popolazione | `POST /api/cron/census` | ogni lunedì, ore 4:00 |

Per ogni job: metodo **POST**, header `x-cron-secret: IL-TUO-CRON-SECRET`.

---

## Dev Locale

```bash
# Installa dipendenze
pnpm install

# Crea .env dalla template e compila i valori
cp .env.example .env

# Avvia backend
cd artifacts/api-server && pnpm run dev

# Avvia frontend (in un altro terminale)
cd artifacts/transitintel && PORT=5173 pnpm run dev
```

In locale, il proxy di Vite gira `/api` verso il backend, quindi `VITE_API_BASE_URL`
può restare vuoto e il cookie usa `SameSite=Lax`.

---

## Troubleshooting

| Problema | Soluzione |
|---|---|
| Mappa non carica | `VITE_MAPBOX_TOKEN` deve essere passato **a build-time** al Web e poi ri-buildare |
| Frontend non chiama l'API | Verifica `VITE_API_BASE_URL` (build-time) o il proxy `/api`; controlla la Network del browser |
| Login non persiste / 401 | Cookie cross-site: servono **HTTPS** su entrambi i domini + `FRONTEND_URL` corretto sull'API |
| CORS blocked | Imposta `FRONTEND_URL` sull'API col dominio esatto del Web |
| API 500 / DB | Controlla `DATABASE_URL`; se TLS self-signed imposta `PGSSL_NO_VERIFY=1`; testa `GET /api/healthz` |
| DB connection refused | Verifica che API e DB siano nello **stesso progetto Coolify** e usa l'hostname interno del servizio |
| Scheduler non parte | OR-Tools (Python) è installato dal `Dockerfile.api`; controlla i log del build dell'API |
