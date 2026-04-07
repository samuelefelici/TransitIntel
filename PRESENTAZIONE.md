# 🚍 TransitIntel — Piattaforma Intelligente per il Trasporto Pubblico Locale

> **Decision Support System** per aziende TPL · Analisi territoriale · Ottimizzazione OR con CP-SAT · Dashboard real-time

---

## 🎯 Che cos'è TransitIntel

**TransitIntel** è una piattaforma web full-stack progettata per supportare le decisioni operative e strategiche di un'azienda di trasporto pubblico locale (TPL). Il sistema integra dati GTFS, traffico in tempo reale, dati censuari ISTAT, meteo e punti di interesse per fornire una visione completa del territorio servito e ottimizzare il servizio con algoritmi di Operations Research.

Il progetto nasce nel contesto della **Provincia di Ancona** (Conerobus S.p.A.) ma l'architettura è generalizzabile a qualsiasi contesto TPL italiano.

---

## 🏗️ Architettura Tecnica

| Layer | Stack |
|-------|-------|
| **Frontend** | React 18 · TypeScript · Vite · Tailwind CSS v4 · Framer Motion · Recharts · Mapbox GL JS |
| **Backend** | Express.js 5 · TypeScript · Drizzle ORM · PostgreSQL (Neon.tech) · Pino logger |
| **Solver Engine** | Python 3 · Google OR-Tools CP-SAT · Pipeline multi-stadio |
| **Monorepo** | pnpm Workspaces · 7 pacchetti (`lib/db`, `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`, `artifacts/transitintel`, `artifacts/api-server`, `scripts/`) |
| **API Contract** | OpenAPI 3.1 (131 endpoint) → Orval codegen → TanStack Query hooks type-safe |
| **Testing** | Vitest (49 test backend) · Pytest (93 test Python) |
| **Infra** | Render / Vercel-ready · CI-ready · `.env`-based secrets |

---

## 📄 Le Pagine dell'Applicazione

### 🔐 Login

Schermata di autenticazione con effetto **Matrix Rain** su canvas (pioggia di caratteri giapponesi e codice binario). Supporta autenticazione locale con protezione brute-force.

---

### 📊 1. Dashboard — Centro di Comando

La pagina principale è una **mappa interattiva Mapbox a schermo intero** con overlay multipli sovrapposti:

- **4 stili mappa** selezionabili: Dark, City 3D, 3D Night, Satellite
- **Layer attivabili**: traffico Mapbox in tempo reale, domanda demografica (heatmap censuaria), punti di interesse (POI), fermate GTFS, tracciati linee (shapes), edifici 3D
- **Filtro linee**: ricerca per nome/codice, selezione multipla, filtro per direzione (andata/ritorno), fascia oraria (slider 4:00–26:00), tipo giorno (feriale/sabato/festivo)
- **Widget Meteo**: dati live da OpenWeatherMap per 5 stazioni della provincia (Ancona, Jesi, Senigallia, Fabriano, Falconara) — temperatura, umidità, vento, visibilità, pioggia/neve
- **Card Stato Rete**: KPI sintetici del feed GTFS (linee, fermate, corse, % copertura)
- **Isocrone pedonali**: click su una fermata → calcolo isocrone a 5/10/15 minuti via OpenRouteService
- **Analisi Walkability**: copertura pedonale della rete — quanta popolazione è raggiungibile a piedi entro N minuti da una fermata, con breakdown per fascia di distanza e grafici donut/barre

---

### 🚦 2. Traffico & Rete — Analisi Congestione

Dashboard analitica dedicata al **traffico stradale** con dati TomTom:

- **KPI principali**: congestione media, velocità media, punti critici, trend temporale
- **Profilo orario congestione**: grafico AreaChart con confronto modello teorico (feriale/sabato/festivo) vs dati reali — identifica spostamenti delle ore di punta
- **Heatmap per zona**: congestione media segmentata per 5 zone geografiche (Centro storico, Porto/Lido, Zona Ovest, Nord/Falconara, Entroterra)
- **Correlazione Meteo–Traffico**: analisi incrociata OpenWeatherMap × TomTom — impatto di pioggia, neve, nebbia sulla congestione (badge: "impatto trascurabile" → "rallentamento severo")
- **Sezione meteo corrente** con dati live delle 5 stazioni

---

### 🗺️ 3. Territorio & Domanda — Analisi Demografica

Pagina composita con 3 sotto-sezioni a tab:

#### 3a. Panoramica Territorio
- **Statistiche censuarie ISTAT**: popolazione totale, sezioni censuarie, densità media, POI totali
- **Classifica POI per categoria**: ospedali, scuole, uffici, shopping, industria, parcheggi, turismo, ecc. — con conteggi e colori
- **Top sezioni censuarie**: le aree più dense con distanza dalla fermata più vicina
- **Analisi gap copertura**: sezioni con alta densità ma servizio bus scarso — scoring gap automatico
- **Curva di copertura**: soglia di distanza vs % popolazione coperta
- **Piramide densità**: distribuzione sezioni per fascia (rurale → centro città)

#### 3b. Qualità del Servizio per Segmento di Utenza
- **Scuole**: mappa interattiva con ogni istituto, fermata più vicina, linee disponibili, corse in fascia ingresso/uscita, verdetto qualità (ottimo/buono/sufficiente/critico)
- **Uffici & Attività commerciali**: stessa analisi per POI lavorativi
- **Ospedali**: copertura strutture sanitarie
- **Hub di Interscambio**: nodi con più linee, analisi tempi di coincidenza

#### 3c. Segmenti Utenza
- **Profilo orario domanda vs offerta** per ogni categoria di utenza
- **Gap score**: rapporto domanda stimata / offerta reale
- **POI critici**: strutture più lontane o peggio servite

---

### 🔀 4. Scenari — Progettazione di Nuove Reti

Pagina con **mappa Mapbox interattiva** per creare e confrontare scenari di rete:

- **Upload scenari**: importazione CSV di fermate e percorsi per definire nuove linee
- **Visualizzazione multi-scenario**: overlay fino a N scenari con colori distinti
- **Analisi scenario**: per ogni scenario, calcolo automatico copertura popolazione, copertura POI, indici di accessibilità
- **Confronto A vs B**: comparazione quantitativa di due scenari su tutte le metriche
- **Programma di Esercizio (PdE)**: dato uno scenario, genera automaticamente le corse con:
  - Target km giornalieri
  - Fascia oraria servizio
  - Cadenza min/max
  - Velocità media, tempo sosta, tempo terminale
  - Bidirezionalità
- **TTD (Tavola dei Tempi)**: tabella orari generata automaticamente per ogni linea
- **Export GTFS**: esportazione dello scenario in formato GTFS standard
- **Diagramma Gantt interattivo** per visualizzare le corse

---

### ⚡ 5. Zone di Coincidenza

Editor cartografico per definire **nodi di interscambio modale**:

- **5 tipologie**: Stazione ferroviaria, Terminal portuale, Bus↔Bus, Park & Ride, Aeroporto
- **Creazione visuale**: posiziona il centro sulla mappa, definisci raggio pedonale, seleziona fermate associate
- **Auto-selezione fermate**: disegno poligono → selezione automatica di tutte le fermate interne
- **Analisi coincidenze**: tempi di attesa per ogni coppia di linee al nodo
- **Integrazione con PdE**: le zone di coincidenza vengono usate nel Programma di Esercizio per coordinare gli orari

---

### 🚂 6. Intermodale — Analisi Hub Multimodali

Analisi automatica degli **hub di trasporto intermodale** della provincia:

- **Rilevamento hub**: stazione FS Ancona, porto, aeroporto, principali stazioni bus
- **Analisi per hub**: linee bus connesse, frequenze, tempi di percorrenza, POI nel raggio
- **Orari intermodali**: sincronizzazione arrivi/partenze treni/navi/aerei con bus
- **Mappa con cerchi di copertura**: visualizzazione del raggio pedonale di ogni hub
- **Scoring priorità**: classificazione hub per importanza e qualità del servizio

---

### 🛠️ 7. Ottimizzazione Servizio

Pagina composita con 3 moduli:

#### 7a. Programma Esercizio — Turni Macchina (Vehicle Scheduling)
- **Input**: selezione data operativa, linee da includere, tipo veicolo per linea (autosnodato/12m/10m/pollicino)
- **Override per corsa**: possibilità di cambiare veicolo a livello di singola corsa
- **2 solver**: Greedy (istantaneo) o **CP-SAT** (Google OR-Tools, configurabile: fast/normal/deep)
- **Output**: turni macchina completi con sequenza corse, trasferimenti, soste, km servizio/fuori linea
- **KPI**: n° veicoli, costo totale €, km servizio, km fuori linea, durata media turno
- **Diagramma Gantt interattivo**: drag & drop per spostare corse tra veicoli, resize per modificare tempi, collision detection (anello rosso + blocco drop su sovrapposizione), undo/redo, zoom
- **Salva/Carica scenari**: persistenza su DB per confronto successivo
- **Modello di costo MAIOR-inspired**: costo fisso giornaliero + €/km servizio + €/km deadhead + penalità sbilanciamento (quadratica) + penalità gap nastro-lavoro

#### 7b. Ottimizzazione Orari (Schedule Optimization)
- **Analisi euristica**: identifica sovrapposizioni, gap di cadenza, corse sopprimibili
- **CP-SAT multi-strategia**: 5 strategie pre-configurate (min costo, max regolarità, max copertura, bilanciata, custom) — genera **frontiera di Pareto**
- **Decisioni**: per ogni corsa, suggerimento "mantieni" / "sopprimi" / "anticipa/posticipa di N min"
- **Radar chart**: confronto visuale delle strategie su 5 assi

#### 7c. Gestione Cluster — Cambio in Linea
- **Editor cartografico**: disegno poligoni per raggruppare fermate in cluster
- **Selezione fermate per linea**: filtro per linea GTFS
- **Autovetture aziendali**: configurazione n° auto per cluster per trasferimenti autisti
- **Impatto sull'ottimizzazione**: i cluster definiti qui vengono usati dal solver turni guida

---

### 👨‍✈️ 8. Turni Guida (Crew Scheduling)

Pagina dedicata per lo scenario selezionato:

- **Input**: scenario turni macchina salvato + configurazione operatore
- **2 solver**: Greedy o **CP-SAT** con intensità configurabile
- **Tipologie turno**: Intero, Semi-unico, Spezzato, Supplemento — con regole CCNL (7h30 max, pausa obbligatoria, guida continua max, ecc.)
- **Output**: assegnazione conducenti con dettaglio riprese, pause, trasferimenti, cambi in linea
- **KPI**: n° conducenti, costo totale €, bilanciamento carico, straordinari
- **Gantt interattivo**: stessa tecnologia drag & drop dei turni macchina
- **Pannello Configurazione Operatore**: pesi solver personalizzabili (min conducenti, bilanciamento, preferenza intero, qualità target, ecc.)
- **Progress bar real-time**: durante l'ottimizzazione CP-SAT, aggiornamento % completamento con polling

---

### 🔍 9. Linee & Fermate — Analisi Rete

Pagina con 3 tab:

#### 9a. Analisi Linee
- **Sovrapposizioni di rete**: per ogni coppia di linee, calcolo Jaccard similarity su fermate condivise + collisioni orarie
- **Headway analysis**: cadenza media/massima per linea, distribuzione per fascia oraria, identificazione "worst gap"
- **Directory linee**: tabella completa con n° corse, fermate, indice headway, n° collisioni

#### 9b. Tempi di Percorrenza
- Analisi tempi di viaggio per linea e direzione

#### 9c. Elenco Fermate
- **Directory paginata**: tutte le fermate del feed con ricerca, n° linee passanti
- **Dettaglio fermata**: linee, orari partenza raggruppati per fascia, colori GTFS

---

### 💾 10. Dati & GTFS

Pagina di gestione dati con 2 tab:

#### 10a. Importa GTFS
- **Upload feed GTFS** (ZIP): parsing completo di stops, routes, trips, stop_times, calendar, calendar_dates, shapes, fare_attributes, fare_rules, agency
- **Analisi automatica post-import**: score complessivo, distribuzione frequenze, ranking linee, copertura POI, copertura popolazione, allineamento traffico, fermate peggio servite
- **Grafici**: barre frequenza, radial score, pie coverage, ranking

#### 10b. Sincronizza Dati
- **4 sorgenti esterne** con sync manuale:
  - **Google Places API**: POI con coordinate precise
  - **OpenStreetMap / Overpass**: POI open-source
  - **TomTom Traffic**: snapshot congestione real-time (auto-sync ogni 30 min)
  - **ISTAT Census**: sezioni censuarie con popolazione e densità

---

## ⚙️ Engine di Ottimizzazione Python — Pipeline CP-SAT

L'engine di ottimizzazione è una **pipeline multi-stadio** in Python con Google OR-Tools:

```
┌──────────────────────────────────────────────────────────────┐
│                    LIVELLO 1: Turni Macchina                 │
│                                                              │
│  vehicle_scheduler_cpsat.py                                  │
│  ├── Input: corse GTFS + tipi veicolo + configurazione       │
│  ├── Modello: CP-SAT con costi MAIOR-inspired                │
│  │   ├── Costo fisso giornaliero per veicolo                 │
│  │   ├── €/km servizio + €/km deadhead                       │
│  │   ├── Penalità sbilanciamento (quadratica)                │
│  │   └── Penalità gap nastro-lavoro                          │
│  └── Output: assegnazione corsa→veicolo, turni macchina      │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    LIVELLO 2: Turni Guida                    │
│                                                              │
│  Pipeline 4 stadi:                                           │
│  ┌─ task_generator.py ──────────────────────────────────────┐│
│  │  Genera task multi-granularità (fine/medium/coarse)      ││
│  │  per ogni turno macchina                                 ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌─ transfer_matrix.py ─────────────────────────────────────┐│
│  │  Calcola distanze, tempi e costi di trasferimento        ││
│  │  tra ogni coppia di task (same_vehicle, walk,            ││
│  │  company_car, taxi)                                      ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌─ duty_enumerator.py ─────────────────────────────────────┐│
│  │  Genera tutti i duty candidati                           ││
│  │  (intero, semi-unico, spezzato, supplemento)             ││
│  │  con vincoli CCNL e cross-cluster transfers              ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌─ cost_model.py ──────────────────────────────────────────┐│
│  │  Valuta ogni duty in EUR (retribuzione, straordinari,    ││
│  │  sosta, trasferimenti, penalità qualità)                 ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌─ crew_scheduler_cpsat.py ────────────────────────────────┐│
│  │  Set Covering Problem con CP-SAT                         ││
│  │  min Σ costo_duty · x_duty                               ││
│  │  s.t. ogni task coperto esattamente 1 volta              ││
│  │       vincoli CCNL: 7h30 max, pause, guida continua     ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                  LIVELLO 3: Ottimizzazione Orari             │
│                                                              │
│  schedule_optimizer_engine.py                                │
│  ├── Multi-strategia: 5 profili + custom                     │
│  ├── Genera frontiera di Pareto                              │
│  └── Decisioni: mantieni / sopprimi / shift ±N min           │
└──────────────────────────────────────────────────────────────┘
```

---

## 🌐 Integrazioni API Esterne

| Servizio | Utilizzo |
|----------|----------|
| **Mapbox GL JS** | Mappa base, stili 3D, geocoding |
| **TomTom Traffic** | Snapshot congestione real-time (auto-sync 30 min) |
| **OpenWeatherMap** | Meteo corrente 5 stazioni, correlazione meteo-traffico |
| **Google Places API** | POI con coordinate precise (ospedali, scuole, uffici) |
| **OpenRouteService** | Isocrone pedonali (5/10/15 min) |
| **OpenStreetMap / Overpass** | POI open-source alternativo |
| **ISTAT (Shapefile locali)** | Sezioni censuarie, popolazione, densità — import da .shp/.dbf |

---

## 📐 Database Schema

**26 tabelle** PostgreSQL gestite con Drizzle ORM:

- `traffic_snapshots` — serie storica congestione TomTom
- `weather_snapshots` — serie storica meteo OWM
- `census_sections` — sezioni censuarie ISTAT con geometria GeoJSON
- `points_of_interest` — POI Google/OSM
- `gtfs_feeds`, `gtfs_stops`, `gtfs_routes`, `gtfs_trips`, `gtfs_stop_times`, `gtfs_calendar`, `gtfs_calendar_dates`, `gtfs_shapes`, `gtfs_fare_attributes`, `gtfs_fare_rules` — feed GTFS completo
- `bus_stops`, `bus_routes` — rete legacy
- `scenarios`, `scenario_stops`, `scenario_routes` — scenari di rete
- `coincidence_zones`, `coincidence_zone_stops` — zone di interscambio
- `clusters`, `cluster_stops` — cluster per cambio in linea
- `intermodal_hubs`, `intermodal_schedules` — hub multimodali

---

## 🧩 Componenti Chiave del Frontend

| Componente | Descrizione |
|------------|-------------|
| **InteractiveGantt** | Gantt chart riutilizzabile con drag & drop, resize, collision detection, undo/redo, zoom (630 LOC) |
| **SchoolMap** | Mappa Mapbox dedicata alla visualizzazione scuole con cerchi di copertura |
| **OptimizationProgress** | Progress bar real-time per solver CP-SAT con polling |
| **OperatorConfigPanel** | Pannello configurazione pesi solver per operatore |
| **ErrorBoundary** | Error boundary React con logging e fallback graceful |
| **Layout / Sidebar** | Sidebar collassabile con sezioni raggruppate e animazioni Framer Motion |

---

## 📈 Numeri del Progetto

| Metrica | Valore |
|---------|--------|
| **Linee di codice frontend** | ~29.400 (TypeScript/React) |
| **Linee di codice backend** | ~17.400 (TypeScript/Express) |
| **Linee di codice solver** | ~10.900 (Python/OR-Tools) |
| **Endpoint API** | 131 (verificati su OpenAPI + route handlers) |
| **Test automatici** | 142 (49 Vitest backend + 93 Pytest Python) |
| **Tabelle database** | 26 (PostgreSQL, Drizzle ORM) |
| **Integrazioni API esterne** | 6 (TomTom, OpenWeatherMap, Google Places, OpenRouteService, Overpass/OSM, Mapbox) + dati ISTAT via Shapefile |
| **Pagine frontend** | 12 pagine principali + sotto-pagine |
| **LOC totali progetto** | ~57.700 |

---

## 🛠️ Competenze Dimostrate

- **Full-Stack TypeScript**: React 18 + Express.js 5 con type-safety end-to-end (OpenAPI → Orval → TanStack Query)
- **Operations Research**: Modellazione problemi di Vehicle Scheduling e Crew Scheduling come programmi combinatori, risolti con CP-SAT (Google OR-Tools)
- **GIS / Mapping**: Mapbox GL JS, layer GeoJSON, isocrone, heatmap, 3D buildings
- **Data Engineering**: Pipeline ETL per GTFS, TomTom, OpenWeatherMap, ISTAT Census, Google Places
- **Design System**: UI moderna dark-theme con Tailwind CSS v4, Framer Motion, Recharts
- **Architettura Software**: Monorepo pnpm, code-splitting lazy, API contract-first, error boundaries
- **DevOps**: Deploy Render/Vercel-ready, secret management, auto-sync cron jobs

---

## 🚀 Come Eseguire

```bash
# Clona il repository
git clone https://github.com/samuelefelici/TransitIntel.git
cd TransitIntel

# Installa dipendenze
pnpm install

# Configura variabili d'ambiente
cp .env.example .env
# Compila i valori: DATABASE_URL, MAPBOX_TOKEN, TOMTOM_API_KEY, OPENWEATHER_API_KEY...

# Avvia backend
bash start-backend.sh

# Avvia frontend (in un altro terminale)
cd artifacts/transitintel && pnpm dev
```

---

> **TransitIntel** · Built with ❤️ by Samuele Felici
> Full-Stack Developer · Operations Research · GIS
