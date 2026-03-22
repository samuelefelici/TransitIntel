# 🚀 TransitIntel — Guida Deploy Gratuito

## Architettura Produzione

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Vercel (CDN)  │────▶│  Render.com      │────▶│  Neon.tech      │
│   Frontend      │     │  Express API     │     │  PostgreSQL     │
│   React + Vite  │     │  Node.js         │     │  Serverless     │
│   FREE          │     │  FREE            │     │  FREE           │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

---

## STEP 1: Crea il Database — Neon.tech

1. Vai su **https://neon.tech** e registrati (GitHub login)
2. Clicca **"New Project"**
   - Project name: `transitintel`
   - Region: **EU (Frankfurt)** ← più vicino all'Italia
   - Clicca Create
3. Copia la **Connection string** (formato: `postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`)
4. Nel pannello Neon, vai su **"SQL Editor"** e incolla tutto il contenuto di `setup.sql` → premi **Run**

> ✅ Database pronto. Conserva la connection string.

---

## STEP 2: Pusha su GitHub

```bash
# Nella cartella del progetto
cd /Users/samuelefelici/traffic

# Inizializza git (se non già fatto)
git init
git add .
git commit -m "Initial commit — TransitIntel"

# Crea repo su GitHub (vai su github.com/new)
# Nome: transitintel (o quello che vuoi)
git remote add origin https://github.com/TUO-USERNAME/transitintel.git
git branch -M main
git push -u origin main
```

---

## STEP 3: Deploy Backend — Render.com

1. Vai su **https://render.com** e registrati (GitHub login)
2. Clicca **"New +"** → **"Web Service"**
3. Collega il repo GitHub `transitintel`
4. Configura:

| Campo | Valore |
|---|---|
| **Name** | `transitintel-api` |
| **Region** | Frankfurt (EU Central) |
| **Branch** | `main` |
| **Runtime** | Node |
| **Build Command** | `pnpm install && pnpm run build` |
| **Start Command** | `node artifacts/api-server/dist/index.cjs` |
| **Plan** | Free |

5. In **"Environment Variables"** aggiungi:

| Key | Value |
|---|---|
| `DATABASE_URL` | *(la connection string di Neon)* |
| `PORT` | `3000` |
| `NODE_ENV` | `production` |
| `CRON_SECRET` | *(genera: `openssl rand -hex 32`)* |
| `TOMTOM_API_KEY` | *(da developer.tomtom.com, free)* |
| `GOOGLE_PLACES_API_KEY` | *(opzionale)* |
| `MAPBOX_TOKEN` | *(da account.mapbox.com)* |
| `FRONTEND_URL` | *(lo aggiungi dopo, quando hai l'URL Vercel)* |

6. Clicca **"Create Web Service"** → attendi il build (~3-5 min)
7. Il tuo backend sarà su: `https://transitintel-api.onrender.com`

> ⚠️ **Piano Free**: il server va in sleep dopo 15 min di inattività.
> La prima richiesta dopo lo sleep impiega ~30 secondi (cold start).
> Per tenerlo attivo puoi usare https://uptimerobot.com (free, pinga ogni 5 min).

---

## STEP 4: Deploy Frontend — Vercel

1. Vai su **https://vercel.com** e registrati (GitHub login)
2. Clicca **"Add New Project"** → importa il repo `transitintel`
3. Configura:

| Campo | Valore |
|---|---|
| **Framework Preset** | Vite |
| **Root Directory** | `.` (lascia la root) |
| **Build Command** | *(lascia auto, usa vercel.json)* |
| **Output Directory** | *(lascia auto, usa vercel.json)* |

4. In **"Environment Variables"** aggiungi:

| Key | Value |
|---|---|
| `MAPBOX_TOKEN` | *(il tuo token Mapbox)* |
| `VITE_API_BASE_URL` | `https://transitintel-api.onrender.com` |
| `BASE_PATH` | `/` |

5. Clicca **"Deploy"** → attendi build (~2 min)
6. Il tuo frontend sarà su: `https://transitintel-xxx.vercel.app`

---

## STEP 5: Collega Frontend ↔ Backend

Ora che hai entrambi gli URL:

1. **Su Render** → vai nelle Environment Variables → aggiungi/aggiorna:
   ```
   FRONTEND_URL = https://transitintel-xxx.vercel.app
   ```
   (questo abilita il CORS)

2. Trigger un **redeploy** su Render (o aspetta il prossimo push)

---

## STEP 6: Popola i Dati

Una volta online, apri la pagina **"Sincronizza Dati"** nell'app e clicca:

1. **"Popolazione — ISTAT 2023"** → carica i 44 comuni della provincia di Ancona
2. **"Punti di Interesse"** → tramite Google Places o OpenStreetMap
3. **"Traffico — TomTom"** → primo snapshot del traffico
4. **"Import GTFS"** → carica il file GTFS di Conerobus

Oppure da terminale (utile per test):
```bash
# Popola ISTAT (gratuito, nessuna API key)
curl -X POST https://transitintel-api.onrender.com/api/cron/census \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

# Popola POI da OSM (gratuito)
curl -X POST https://transitintel-api.onrender.com/api/cron/poi \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"

# Fetch traffico TomTom (serve TOMTOM_API_KEY)
curl -X POST https://transitintel-api.onrender.com/api/cron/traffic \
  -H "x-cron-secret: IL-TUO-CRON-SECRET"
```

---

## API Keys Gratuite

| Servizio | URL | Limite Free |
|---|---|---|
| **Mapbox** | https://account.mapbox.com | 50k map loads/mese |
| **TomTom** | https://developer.tomtom.com | 2.500 req/giorno |
| **Google Places** | https://console.cloud.google.com | $200 crediti/mese |

---

## Cron Jobs (Opzionale)

Per automatizzare la raccolta dati, usa **cron-job.org** (gratis):

| Job | URL | Schedule |
|---|---|---|
| Traffico | `POST .../api/cron/traffic` | Ogni 15 min |
| POI | `POST .../api/cron/poi` | 1° del mese, ore 3:00 |
| Popolazione | `POST .../api/cron/census` | Ogni lunedì, ore 4:00 |

Per ogni job su cron-job.org:
- Header: `x-cron-secret: IL-TUO-CRON-SECRET`
- Method: POST

---

## Dev Locale

```bash
# Installa dipendenze
pnpm install

# Crea .env dalla template
cp .env.example .env
# Compila con i tuoi valori

# Avvia backend
cd artifacts/api-server && pnpm run dev

# Avvia frontend (in un altro terminale)
cd artifacts/transitintel && PORT=5173 BASE_PATH="/" pnpm run dev
```

---

## Troubleshooting

| Problema | Soluzione |
|---|---|
| Mappa non carica | Verifica `MAPBOX_TOKEN` nelle env vars di Vercel |
| API 500 error | Controlla `DATABASE_URL` su Render → testa con `/api/healthz` |
| CORS blocked | Aggiungi l'URL Vercel in `FRONTEND_URL` su Render |
| Build fallisce su Vercel | Controlla che `pnpm-lock.yaml` sia committato |
| Render slow (30s) | Piano free = cold start. Usa UptimeRobot per tenerlo attivo |
| DB connection refused | Verifica che Neon non sia in "suspend" (apri il pannello Neon) |
