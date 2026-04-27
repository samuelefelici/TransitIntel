# TransitIntel — Sintesi per Presentazione# 🚍 TransitIntel — Piattaforma Intelligente per il Trasporto Pubblico Locale



> Piattaforma di **intelligence per il trasporto pubblico locale (TPL)** della Provincia di Ancona / Regione Marche.> **Decision Support System** per aziende TPL · Analisi territoriale · Ottimizzazione OR con CP-SAT · Dashboard real-time

> Costruita per **pianificare, ottimizzare e simulare** il servizio bus combinando dati GTFS, traffico reale, popolazione ISTAT e modelli di ottimizzazione combinatoria.

---

---

## 🎯 Che cos'è TransitIntel

## 🎯 Cos'è TransitIntel in 30 secondi

**TransitIntel** è una piattaforma web full-stack progettata per supportare le decisioni operative e strategiche di un'azienda di trasporto pubblico locale (TPL). Il sistema integra dati GTFS, traffico in tempo reale, dati censuari ISTAT, meteo e punti di interesse per fornire una visione completa del territorio servito e ottimizzare il servizio con algoritmi di Operations Research.

Una **dashboard operativa** per gli enti che gestiscono il TPL, che risponde a 4 domande chiave:

Il progetto nasce nel contesto della **Provincia di Ancona** (Conerobus S.p.A.) ma l'architettura è generalizzabile a qualsiasi contesto TPL italiano.

1. **Dove serve di più il bus?** → analisi domanda/offerta su popolazione + POI

2. **Come si comporta il traffico?** → dati TomTom storici per fascia oraria/giorno---

3. **Quanti veicoli e turni servono?** → ottimizzatore CP-SAT (Google OR-Tools) per scheduling reale

4. **Quanto costa un viaggio porta-a-porta?** → trip planner con tariffazione DGR Marche## 🏗️ Architettura Tecnica



Sopra a tutto: **🐙 Virgilio**, l'assistente AI che pilota l'app a voce e in chat.| Layer | Stack |

|-------|-------|

---| **Frontend** | React 18 · TypeScript · Vite · Tailwind CSS v4 · Framer Motion · Recharts · Mapbox GL JS |

| **Backend** | Express.js 5 · TypeScript · Drizzle ORM · PostgreSQL (Neon.tech) · Pino logger |

## 🏛️ Architettura| **Solver Engine** | Python 3 · Google OR-Tools CP-SAT · Pipeline multi-stadio |

| **Monorepo** | pnpm Workspaces · 7 pacchetti (`lib/db`, `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`, `artifacts/transitintel`, `artifacts/api-server`, `scripts/`) |

**Monorepo pnpm** con 3 deliverable:| **API Contract** | OpenAPI 3.1 (131 endpoint) → Orval codegen → TanStack Query hooks type-safe |

| **Testing** | Vitest (49 test backend) · Pytest (93 test Python) |

| Componente | Stack | Cosa fa || **Infra** | Render / Vercel-ready · CI-ready · `.env`-based secrets |

|------------|-------|---------|

| `artifacts/api-server` | Express 5 · TypeScript · Drizzle ORM · Zod | API REST + SSE streaming AI |---

| `artifacts/transitintel` | React 18 · Vite · Tailwind v4 · Shadcn UI · Mapbox GL · Recharts · Framer Motion | Frontend single-page |

| `lib/db` · `lib/api-spec` · `lib/api-zod` · `lib/api-client-react` | Drizzle · OpenAPI · Orval | Schemi DB + contratti API condivisi |## 📄 Le Pagine dell'Applicazione



**Database**: PostgreSQL (no PostGIS — tutta la matematica spaziale è custom in TypeScript).### 🔐 Login



**Modello AI**: Anthropic Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) con **16 tool calls** e streaming SSE.Schermata di autenticazione con effetto **Matrix Rain** su canvas (pioggia di caratteri giapponesi e codice binario). Supporta autenticazione locale con protezione brute-force.



------



## 📂 I 13 Moduli Principali### 📊 1. Dashboard — Centro di Comando



### 1. **Dashboard** `/dashboard`La pagina principale è una **mappa interattiva Mapbox a schermo intero** con overlay multipli sovrapposti:

Mappa Mapbox full-screen con layer toggle: heatmap traffico, heatmap domanda, POI, fermate GTFS.

- **4 stili mappa** selezionabili: Dark, City 3D, 3D Night, Satellite

### 2. **Traffico & Rete** `/traffic`- **Layer attivabili**: traffico Mapbox in tempo reale, domanda demografica (heatmap censuaria), punti di interesse (POI), fermate GTFS, tracciati linee (shapes), edifici 3D

Grafici Recharts su congestione media per ora del giorno e giorno della settimana.- **Filtro linee**: ricerca per nome/codice, selezione multipla, filtro per direzione (andata/ritorno), fascia oraria (slider 4:00–26:00), tipo giorno (feriale/sabato/festivo)

- **Widget Meteo**: dati live da OpenWeatherMap per 5 stazioni della provincia (Ancona, Jesi, Senigallia, Fabriano, Falconara) — temperatura, umidità, vento, visibilità, pioggia/neve

### 3. **Territorio & Domanda** `/territory`- **Card Stato Rete**: KPI sintetici del feed GTFS (linee, fermate, corse, % copertura)

Heatmap domanda potenziale + tabella zone sotto-servite (top N celle censuarie con alta popolazione + POI ma fermate distanti) + export CSV.- **Isocrone pedonali**: click su una fermata → calcolo isocrone a 5/10/15 minuti via OpenRouteService

- **Analisi Walkability**: copertura pedonale della rete — quanta popolazione è raggiungibile a piedi entro N minuti da una fermata, con breakdown per fascia di distanza e grafici donut/barre

### 4. **Linee & Fermate** `/network`

Tabella linee bus filtrabile per network (urbano_ancona, urbano_jesi, urbano_senigallia, extraurbano…) con visualizzazione mappa polilinee + fermate.---



### 5. **Scheduling Engine (Fucina)** `/fucina` 🔥### 🚦 2. Traffico & Rete — Analisi Congestione

**Wizard a 7 step** per costruire un servizio completo:

Dashboard analitica dedicata al **traffico stradale** con dati TomTom:

| Step | Cosa fa |

|------|---------|- **KPI principali**: congestione media, velocità media, punti critici, trend temporale

| 0 — Dati GTFS | scelta feed esistente / import zip + data servizio |- **Profilo orario congestione**: grafico AreaChart con confronto modello teorico (feriale/sabato/festivo) vs dati reali — identifica spostamenti delle ore di punta

| 1 — Abbinamento Vetture | seleziona linee + assegna tipo vettura (12m, 18m, midi) |- **Heatmap per zona**: congestione media segmentata per 5 zone geografiche (Centro storico, Porto/Lido, Zona Ovest, Nord/Falconara, Entroterra)

| 2 — Deposito | scegli punto di partenza/rientro mezzi |- **Correlazione Meteo–Traffico**: analisi incrociata OpenWeatherMap × TomTom — impatto di pioggia, neve, nebbia sulla congestione (badge: "impatto trascurabile" → "rallentamento severo")

| 3 — Cluster di Cambio | scegli i punti dove i veicoli possono cambiare turno |- **Sezione meteo corrente** con dati live delle 5 stazioni

| 4 — Fuori Linea | matrice tempi/distanze deadhead tra cluster e deposito |

| 5 — Ottimizzazione | **CP-SAT (Google OR-Tools)** o Greedy → minimizza # veicoli + km a vuoto |---

| 6 — Area di Lavoro | **Gantt interattivo** con drag&drop + esporta CSV / salva scenario |

### 🗺️ 3. Territorio & Domanda — Analisi Demografica

Backend: `scripts/vehicle_scheduler_cpsat.py`, `crew_scheduler_cpsat.py`, `schedule_optimizer_engine.py`.

Pagina composita con 3 sotto-sezioni a tab:

### 6. **Trip Planner** `/trip-planner`

Mappa interattiva, input origine/destinazione (autocomplete Mapbox o click su mappa), calcola fino a 5 alternative porta-a-porta: walk → bus → [transfer → bus] → walk. Confronto **fastest / cheapest / leastWalk** con badge.#### 3a. Panoramica Territorio

- **Statistiche censuarie ISTAT**: popolazione totale, sezioni censuarie, densità media, POI totali

### 7. **Fares & Fares Engine** `/fares` · `/fares-engine`- **Classifica POI per categoria**: ospedali, scuole, uffici, shopping, industria, parcheggi, turismo, ecc. — con conteggi e colori

Tariffe DGR Marche (urbano flat / extraurbano fasce chilometriche). Simulatore prezzo viaggio + analytics revenue stimato.- **Top sezioni censuarie**: le aree più dense con distanza dalla fermata più vicina

- **Analisi gap copertura**: sezioni con alta densità ma servizio bus scarso — scoring gap automatico

### 8. **Scenari** `/scenarios`- **Curva di copertura**: soglia di distanza vs % popolazione coperta

Salva configurazioni di servizio (output Fucina) + confronto KPI tra scenari.- **Piramide densità**: distribuzione sezioni per fascia (rurale → centro città)



### 9. **Intermodale** `/intermodal`#### 3b. Qualità del Servizio per Segmento di Utenza

Analisi treni + bus + walking. Hub di interscambio identificati automaticamente.- **Scuole**: mappa interattiva con ogni istituto, fermata più vicina, linee disponibili, corse in fascia ingresso/uscita, verdetto qualità (ottimo/buono/sufficiente/critico)

- **Uffici & Attività commerciali**: stessa analisi per POI lavorativi

### 10. **Zone Coincidenza** `/coincidence-zones`- **Ospedali**: copertura strutture sanitarie

Cluster di fermate dove più linee si incrociano → utili per ottimizzazione cambi.- **Hub di Interscambio**: nodi con più linee, analisi tempi di coincidenza



### 11. **Optimization** `/optimization`#### 3c. Segmenti Utenza

Ottimizzatore standalone per il routing delle linee (separato dalla schedule).- **Profilo orario domanda vs offerta** per ogni categoria di utenza

- **Gap score**: rapporto domanda stimata / offerta reale

### 12. **Driver Shifts** `/driver-shifts`- **POI critici**: strutture più lontane o peggio servite

Gestione turni autisti + vincoli sindacali (pause, riposi, monte ore settimanale).

---

### 13. **Dati & GTFS** `/data`

Import GTFS via drag&drop zip, visualizza feed importati, sync TomTom / OSM / ISTAT.### 🔀 4. Scenari — Progettazione di Nuove Reti



---Pagina con **mappa Mapbox interattiva** per creare e confrontare scenari di rete:



## 🐙 Virgilio — Assistente AI Operativo- **Upload scenari**: importazione CSV di fermate e percorsi per definire nuove linee

- **Visualizzazione multi-scenario**: overlay fino a N scenari con colori distinti

**La feature differenziante.** Un agente Claude integrato che non solo risponde, ma **pilota l'interfaccia**.- **Analisi scenario**: per ogni scenario, calcolo automatico copertura popolazione, copertura POI, indici di accessibilità

- **Confronto A vs B**: comparazione quantitativa di due scenari su tutte le metriche

### Capacità- **Programma di Esercizio (PdE)**: dato uno scenario, genera automaticamente le corse con:

- **Chat sidebar** flottante (340px, non bloccante, sempre disponibile in basso a destra)  - Target km giornalieri

- **Voice input** (Web Speech API, riconoscimento it-IT)  - Fascia oraria servizio

- **Voice output** (TTS, voce maschile italiana fluida — **legge solo le risposte finali**, non i ragionamenti intermedi)  - Cadenza min/max

- **16 tool calls** disponibili:  - Velocità media, tempo sosta, tempo terminale

  - Bidirezionalità

| Categoria | Tool | Cosa fa |- **TTD (Tavola dei Tempi)**: tabella orari generata automaticamente per ogni linea

|-----------|------|---------|- **Export GTFS**: esportazione dello scenario in formato GTFS standard

| 📊 Dati | `list_routes`, `search_stops`, `get_underserved_zones`, `get_coverage_stats`, `get_traffic_stats`, `get_pois`, `list_scenarios`, `simulate_fare`, `plan_journey`, `get_route_details`, `get_stop_details` | Query reali sul DB e API interne |- **Diagramma Gantt interattivo** per visualizzare le corse

| 🎮 UI | `ui_navigate`, `ui_focus_map`, `ui_highlight`, `ui_plan_trip`, `ui_fucina_wizard` | Pilota l'app: naviga, evidenzia, riempie form, guida wizard |

---

### Esempi di prompt da provare alla demo

### ⚡ 5. Zone di Coincidenza

| Prompt | Cosa succede |

|--------|--------------|Editor cartografico per definire **nodi di interscambio modale**:

| *"Quante linee servono Senigallia?"* | tool `list_routes` + risposta in tabella |

| *"Mostrami le 3 zone più sotto-servite"* | naviga `/territory` + highlight neon delle righe top-3 |- **5 tipologie**: Stazione ferroviaria, Terminal portuale, Bus↔Bus, Park & Ride, Aeroporto

| *"Voglio andare dalla stazione di Ancona a Numana sabato alle 9"* | va su `/trip-planner`, **riempie il form da solo**, clicca calcola |- **Creazione visuale**: posiziona il centro sulla mappa, definisci raggio pedonale, seleziona fermate associate

| *"Aiutami a creare un servizio di scheduling"* | apre `/fucina`, salta lo splash, **wizard guidato step-by-step** in chat con domande una alla volta |- **Auto-selezione fermate**: disegno poligono → selezione automatica di tutte le fermate interne

| *"Riepilogo della rete"* | dati aggregati + commento sintetico |- **Analisi coincidenze**: tempi di attesa per ogni coppia di linee al nodo

- **Integrazione con PdE**: le zone di coincidenza vengono usate nel Programma di Esercizio per coordinare gli orari

---

---

## 🛠️ Stack Tecnico — Dettagli

### 🚂 6. Intermodale — Analisi Hub Multimodali

### Frontend

- **React 18** + **Vite** (HMR sub-second)Analisi automatica degli **hub di trasporto intermodale** della provincia:

- **Tailwind CSS v4** + **Shadcn UI** (componenti accessibili)

- **Mapbox GL** (`react-map-gl/mapbox`) per tutte le mappe- **Rilevamento hub**: stazione FS Ancona, porto, aeroporto, principali stazioni bus

- **Recharts** per grafici- **Analisi per hub**: linee bus connesse, frequenze, tempi di percorrenza, POI nel raggio

- **Framer Motion** per animazioni fluide- **Orari intermodali**: sincronizzazione arrivi/partenze treni/navi/aerei con bus

- **TanStack Query** per data fetching- **Mappa con cerchi di copertura**: visualizzazione del raggio pedonale di ogni hub

- **wouter** per routing leggero- **Scoring priorità**: classificazione hub per importanza e qualità del servizio

- **react-markdown** + `remark-gfm` per il rendering chat

---

### Backend

- **Express 5** + TypeScript stretto### 🛠️ 7. Ottimizzazione Servizio

- **Drizzle ORM** (no PostGIS — math custom)

- **Zod** validation runtimePagina composita con 3 moduli:

- **SSE** (Server-Sent Events) per lo streaming AI

- **Pino** logging strutturato#### 7a. Programma Esercizio — Turni Macchina (Vehicle Scheduling)

- **Anthropic SDK** per Claude (`@anthropic-ai/sdk`)- **Input**: selezione data operativa, linee da includere, tipo veicolo per linea (autosnodato/12m/10m/pollicino)

- **Override per corsa**: possibilità di cambiare veicolo a livello di singola corsa

### Optimization (Python)- **2 solver**: Greedy (istantaneo) o **CP-SAT** (Google OR-Tools, configurabile: fast/normal/deep)

- **OR-Tools CP-SAT** per scheduling vetture / autisti- **Output**: turni macchina completi con sequenza corse, trasferimenti, soste, km servizio/fuori linea

- Algoritmi custom: cluster transfer matrix, deadhead, duty enumerator- **KPI**: n° veicoli, costo totale €, km servizio, km fuori linea, durata media turno

- **Diagramma Gantt interattivo**: drag & drop per spostare corse tra veicoli, resize per modificare tempi, collision detection (anello rosso + blocco drop su sovrapposizione), undo/redo, zoom

### Dati Sorgente- **Salva/Carica scenari**: persistenza su DB per confronto successivo

- **GTFS** Conerobus + extraurbano Marche- **Modello di costo MAIOR-inspired**: costo fisso giornaliero + €/km servizio + €/km deadhead + penalità sbilanciamento (quadratica) + penalità gap nastro-lavoro

- **TomTom Traffic API** (snapshot ogni ora)

- **OSM Overpass** per POI (~3000 punti)#### 7b. Ottimizzazione Orari (Schedule Optimization)

- **ISTAT** sezioni censuarie (~462k abitanti coperti)- **Analisi euristica**: identifica sovrapposizioni, gap di cadenza, corse sopprimibili

- **DGR Marche** tariffe ufficiali- **CP-SAT multi-strategia**: 5 strategie pre-configurate (min costo, max regolarità, max copertura, bilanciata, custom) — genera **frontiera di Pareto**

- **Decisioni**: per ogni corsa, suggerimento "mantieni" / "sopprimi" / "anticipa/posticipa di N min"

---- **Radar chart**: confronto visuale delle strategie su 5 assi



## 🔢 Numeri Chiave (per slide)#### 7c. Gestione Cluster — Cambio in Linea

- **Editor cartografico**: disegno poligoni per raggruppare fermate in cluster

- **~462.000** abitanti nella provincia di Ancona modellati- **Selezione fermate per linea**: filtro per linea GTFS

- **~2.966** POI georeferenziati- **Autovetture aziendali**: configurazione n° auto per cluster per trasferimenti autisti

- **6** network bus distinti (5 urbani + extraurbano)- **Impatto sull'ottimizzazione**: i cluster definiti qui vengono usati dal solver turni guida

- **16** tool AI operativi

- **7 step** del wizard scheduling---

- **5 alternative** di viaggio nel trip planner

- **CP-SAT** — solver combinatorio di Google OR-Tools### 👨‍✈️ 8. Turni Guida (Crew Scheduling)



---Pagina dedicata per lo scenario selezionato:



## 🎬 Demo Script Suggerito (5 minuti)- **Input**: scenario turni macchina salvato + configurazione operatore

- **2 solver**: Greedy o **CP-SAT** con intensità configurabile

### Minuto 1 — Setup & Dashboard- **Tipologie turno**: Intero, Semi-unico, Spezzato, Supplemento — con regole CCNL (7h30 max, pausa obbligatoria, guida continua max, ecc.)

1. Apri `/dashboard` → mostra mappa con layer attivi (traffico + popolazione + POI + fermate)- **Output**: assegnazione conducenti con dettaglio riprese, pause, trasferimenti, cambi in linea

2. Apri Virgilio in basso a destra- **KPI**: n° conducenti, costo totale €, bilanciamento carico, straordinari

3. **Chiedi a voce**: *"Dammi un riepilogo della rete"* → mostra capacità AI- **Gantt interattivo**: stessa tecnologia drag & drop dei turni macchina

- **Pannello Configurazione Operatore**: pesi solver personalizzabili (min conducenti, bilanciamento, preferenza intero, qualità target, ecc.)

### Minuto 2 — Analisi Territorio- **Progress bar real-time**: durante l'ottimizzazione CP-SAT, aggiornamento % completamento con polling

4. Chiedi: *"Quali sono le 3 zone più sotto-servite?"*

5. → Virgilio naviga `/territory`, evidenzia (outline neon + scrollIntoView) sulle 3 righe critiche, parla solo la conclusione---



### Minuto 3 — Trip Planner agentico### 🔍 9. Linee & Fermate — Analisi Rete

6. Chiedi: *"Voglio andare dalla stazione di Ancona a Numana sabato alle 9"*

7. → Virgilio porta su `/trip-planner`, **riempie il form da solo** con animazione typing, clicca calcola, mostra alternativePagina con 3 tab:



### Minuto 4 — Scheduling Engine#### 9a. Analisi Linee

8. Chiedi: *"Aiutami a creare un servizio di scheduling"*- **Sovrapposizioni di rete**: per ogni coppia di linee, calcolo Jaccard similarity su fermate condivise + collisioni orarie

9. → Virgilio apre `/fucina`, salta splash, fa la prima domanda (una alla volta!)- **Headway analysis**: cadenza media/massima per linea, distribuzione per fascia oraria, identificazione "worst gap"

10. Rispondi → procede allo step successivo, fino a CP-SAT- **Directory linee**: tabella completa con n° corse, fermate, indice headway, n° collisioni

11. Mostra il **Gantt interattivo** finale

#### 9b. Tempi di Percorrenza

### Minuto 5 — Wow factor & chiusura- Analisi tempi di viaggio per linea e direzione

12. Vai su `/fucina` step 5 → run CP-SAT → mostra animazione + risultato

13. Mostra il **voice picker**: scegli Diego/Luca Premium ♂⭐ → riascolta una risposta#### 9c. Elenco Fermate

14. Chiusura: *"In ~6 mesi abbiamo costruito una piattaforma che combina BI, ottimizzazione combinatoria e AI agentica per il TPL pubblico."*- **Directory paginata**: tutte le fermate del feed con ricerca, n° linee passanti

- **Dettaglio fermata**: linee, orari partenza raggruppati per fascia, colori GTFS

---

---

## ✅ Checklist Pre-Demo

### 💾 10. Dati & GTFS

- [ ] **Backend up**: `curl http://localhost:3000/api/ai/health` → deve restituire `{configured:true, tools:16}`

- [ ] **Frontend up**: il task "Frontend Dev Server" deve girare (porta 5173)Pagina di gestione dati con 2 tab:

- [ ] **Anthropic API key valida** (controlla bilancio su console.anthropic.com)

- [ ] **Mapbox token** presente in `.env` come `VITE_MAPBOX_TOKEN` o `MAPBOX_TOKEN`#### 10a. Importa GTFS

- [ ] **Database popolato** (sezioni censuarie, POI, traffic snapshots)- **Upload feed GTFS** (ZIP): parsing completo di stops, routes, trips, stop_times, calendar, calendar_dates, shapes, fare_attributes, fare_rules, agency

- [ ] **Browser**: Chrome/Edge per Web Speech API completa (Safari ha limiti su recognition)- **Analisi automatica post-import**: score complessivo, distribuzione frequenze, ranking linee, copertura POI, copertura popolazione, allineamento traffico, fermate peggio servite

- [ ] **Audio attivo** + microfono concesso al browser- **Grafici**: barre frequenza, radial score, pie coverage, ranking

- [ ] **Voce Virgilio** scelta dal picker (preferisci Diego/Luca/Cosimo Premium su macOS — segno ♂⭐)

- [ ] **Hard reload** del browser (`Cmd+Shift+R`) prima della demo per evitare cache vecchie#### 10b. Sincronizza Dati

- [ ] **Notebook** in modalità "Non disturbare" (no notifiche durante demo)- **4 sorgenti esterne** con sync manuale:

- [ ] **Connessione internet** stabile (Anthropic API + Mapbox tile server)  - **Google Places API**: POI con coordinate precise

  - **OpenStreetMap / Overpass**: POI open-source

---  - **TomTom Traffic**: snapshot congestione real-time (auto-sync ogni 30 min)

  - **ISTAT Census**: sezioni censuarie con popolazione e densità

## ⚠️ Cose da NON fare in demo

---

- ❌ Non mostrare il codice — la demo è product-driven

- ❌ Non aprire DevTools (i warning di Mapbox sono normali ma confondono)## ⚙️ Engine di Ottimizzazione Python — Pipeline CP-SAT

- ❌ Non chiedere a Virgilio cose troppo complesse al primo turno (rischio timeout / costo token alto)

- ❌ Non dire "ora vediamo se funziona": le persone notano il dubbio. Parla con sicurezza.L'engine di ottimizzazione è una **pipeline multi-stadio** in Python con Google OR-Tools:



---```

┌──────────────────────────────────────────────────────────────┐

## 🧯 Piano B se qualcosa va storto│                    LIVELLO 1: Turni Macchina                 │

│                                                              │

| Problema | Soluzione |│  vehicle_scheduler_cpsat.py                                  │

|----------|-----------|│  ├── Input: corse GTFS + tipi veicolo + configurazione       │

| Virgilio non risponde | Riavvia backend: `pkill -f "tsx ./src/index.ts" && bash start-backend.sh` |│  ├── Modello: CP-SAT con costi MAIOR-inspired                │

| Voce non parte | Controlla che `🔊` sia attivo in chat header + scegli voce dal picker ▾ |│  │   ├── Costo fisso giornaliero per veicolo                 │

| Highlight non visibile | Outline neon + scrollIntoView, sostituisce i tentacoli SVG (rimossi per pulizia visiva) |│  │   ├── €/km servizio + €/km deadhead                       │

| Mappa nera/vuota | Verifica `VITE_MAPBOX_TOKEN` in `.env` |│  │   ├── Penalità sbilanciamento (quadratica)                │

| CP-SAT fallisce | Fallback automatico su solver Greedy nel wizard |│  │   └── Penalità gap nastro-lavoro                          │

| Frontend in errore | Hard reload `Cmd+Shift+R` |│  └── Output: assegnazione corsa→veicolo, turni macchina      │

| Errore 401 Anthropic | Bilancio API esaurito → ricarica su console.anthropic.com |└──────────────────────┬───────────────────────────────────────┘

                       │

---                       ▼

┌──────────────────────────────────────────────────────────────┐

## 💡 Argomenti da preparare per Q&A│                    LIVELLO 2: Turni Guida                    │

│                                                              │

- **"Perché AI?"** → Riduce il time-to-insight da minuti (cliccare 5 menu) a secondi (1 frase). Democratizza l'accesso ai dati per chi non sa dove cercare.│  Pipeline 4 stadi:                                           │

- **"Costo dell'AI?"** → Claude Haiku 4.5: ~$0.001 per richiesta media. Anche con 1000 query/giorno: ~$30/mese.│  ┌─ task_generator.py ──────────────────────────────────────┐│

- **"Privacy?"** → Nessun dato personale viene mandato a Claude. Solo metriche aggregate e nomi di linee/fermate (dati pubblici GTFS).│  │  Genera task multi-granularità (fine/medium/coarse)      ││

- **"Scalabilità?"** → Drizzle + Postgres regge milioni di righe. CP-SAT può girare su singolo nodo per province <100 linee.│  │  per ogni turno macchina                                 ││

- **"Quanto ci avete messo?"** → ~6 mesi part-time. Stack scelto per velocità di sviluppo (Vite, Drizzle, Shadcn).│  └──────────────────────────────────────────────────────────┘│

- **"Si può estendere ad altre regioni?"** → Sì, il bbox è configurabile in `.env`. Cambi GTFS feed e tariffe DGR.│  ┌─ transfer_matrix.py ─────────────────────────────────────┐│

- **"Perché non Google Maps Directions?"** → Costo licenza, mancato controllo del modello tariffario locale, no integrazione con dati di pianificazione.│  │  Calcola distanze, tempi e costi di trasferimento        ││

- **"Perché CP-SAT e non un solver commerciale?"** → CP-SAT è gratuito (Apache 2.0), competitivo con Gurobi su scheduling discreto, ben integrato in Python.│  │  tra ogni coppia di task (same_vehicle, walk,            ││

│  │  company_car, taxi)                                      ││

---│  └──────────────────────────────────────────────────────────┘│

│  ┌─ duty_enumerator.py ─────────────────────────────────────┐│

## 🚀 Roadmap (cose che potresti dire come "next steps")│  │  Genera tutti i duty candidati                           ││

│  │  (intero, semi-unico, spezzato, supplemento)             ││

- 📲 **App mobile** per autisti (visualizzazione turno, comunicazioni)│  │  con vincoli CCNL e cross-cluster transfers              ││

- 🛰️ **GPS realtime** dei mezzi → integrazione AVM│  └──────────────────────────────────────────────────────────┘│

- 🤖 **Predittivo**: modello di ML per stimare ritardi futuri│  ┌─ cost_model.py ──────────────────────────────────────────┐│

- 🌐 **Multi-tenant**: estendere ad altre province con onboarding self-service│  │  Valuta ogni duty in EUR (retribuzione, straordinari,    ││

- 📊 **Open data**: pubblicare dataset aggregati come API pubbliche│  │  sosta, trasferimenti, penalità qualità)                 ││

│  └──────────────────────────────────────────────────────────┘│

---│  ┌─ crew_scheduler_cpsat.py ────────────────────────────────┐│

│  │  Set Covering Problem con CP-SAT                         ││

In bocca al lupo! 🍀│  │  min Σ costo_duty · x_duty                               ││

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
