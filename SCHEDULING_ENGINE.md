# 🔥 Scheduling Engine — Analisi Completa del Processo

> **Da Turni Macchina a Turni Guida**
> Documentazione tecnica del flusso end-to-end di pianificazione operativa
> TransitIntel · Conerobus S.p.A. · Aggiornato 18/04/2026

---

## 📋 Indice

1. [Visione d'insieme](#1-visione-dinsieme)
2. [Step 1 — Turni Macchina (Vehicle Scheduling)](#2-step-1--turni-macchina-vehicle-scheduling)
3. [Step 2 — Turni Guida (Crew Scheduling)](#3-step-2--turni-guida-crew-scheduling)
4. [Algoritmi di ottimizzazione](#4-algoritmi-di-ottimizzazione)
5. [Vincoli e normative](#5-vincoli-e-normative)
6. [Configurabilità da UI](#6-configurabilità-da-ui)
7. [Output e analisi](#7-output-e-analisi)
8. [Architettura tecnica](#8-architettura-tecnica)

---

## 1. Visione d'insieme

Lo **Scheduling Engine** trasforma un **Programma di Esercizio** (lista di corse pianificate) in:
- **Turni Macchina** — assegnazione corse → veicoli
- **Turni Guida** — assegnazione blocchi veicolo → autisti

```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  PROGRAMMA          │    │  TURNI MACCHINA     │    │  TURNI GUIDA        │
│  ESERCIZIO          │ ─► │  (Vehicle Sched.)   │ ─► │  (Crew Scheduling)  │
│                     │    │                     │    │                     │
│  • N corse          │    │  • M veicoli        │    │  • K autisti        │
│  • Linee · vetture  │    │  • Sequenze corse   │    │  • Pre/post turno   │
│  • Orari            │    │  • Vuoti & deposito │    │  • Pause normative  │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
       INPUT                     STEP 1                     STEP 2
```

**Approccio**: ispirato agli ottimizzatori professionali (Maior, GIRO HASTUS), ogni step esegue un **portfolio multi-scenario** con strategie alternative e seed randomizzati, poi seleziona la soluzione migliore con una **polish phase** finale.

---

## 2. Step 1 — Turni Macchina (Vehicle Scheduling)

### 🎯 Obiettivo
Assegnare le corse del Programma di Esercizio a un numero minimo di veicoli, rispettando:
- Compatibilità tipo veicolo (urbano/suburbano/snodato/midi)
- Tempo minimo di layover (turn-around) tra corse
- Distanza massima di trasferimento vuoto (deadhead)
- Costo reale in Euro (km servizio + km vuoto + idle + rientri deposito)

### 📥 Input
```jsonc
{
  "trips": [
    {
      "trip_id": "T001",
      "route_id": "R11",
      "departure_min": 360,        // 06:00
      "arrival_min": 405,          // 06:45
      "first_stop_lat": 43.6, ...  // capolinea partenza
      "last_stop_lat": 43.5, ...   // capolinea arrivo
      "required_vehicle": "urbano",
      "category": "urbano"
    }
  ],
  "config": {
    "solverIntensity": "deep",     // fast | normal | deep | extreme
    "vehicleCosts": { ... }        // €/km, €/min idle, €/rientro depot
  }
}
```

### 🔧 Pipeline interna (`scripts/vehicle_scheduler_cpsat.py`)

```
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 1 — BUILD COMPATIBILITY ARCS (O(n × k) bisect)                │
│   Per ogni coppia (i, j) di trip compatibili genera un arco con:   │
│     • dh_km     → km vuoto stimati                                 │
│     • dh_min    → tempo trasferimento                              │
│     • gap_min   → minuti di idle                                   │
│     • depot_return → True se gap > soglia                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 2 — PRE-COMPUTE COSTS (per strategia)                         │
│   Costo arco = costo_dh + costo_idle + costo_depot                 │
│   Costo fisso = €/giorno × tipo_veicolo                            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 3 — GREEDY WARMSTART (cost-aware)                             │
│   Ordina trip per departure_min, assegna ognuno al veicolo che     │
│   minimizza il costo dell'arco (dh + idle + depot).                │
│   Output: warm-start con N° veicoli ragionevole.                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 4 — PORTFOLIO MULTI-SCENARIO CP-SAT (★ Maior-style ★)         │
│                                                                     │
│   Per ogni intensità, esegue N scenari con strategia diversa:      │
│     fast    → 3 scenari × 30s                                      │
│     normal  → 5 scenari × 60s                                      │
│     deep    → 8 scenari × 120s                                     │
│     extreme → 12 scenari × 150s                                    │
│                                                                     │
│   8 STRATEGIE DISPONIBILI (riscalano i pesi dell'obiettivo):       │
│     ┌────────────────┬──────────────────────────────────────────┐  │
│     │ balanced       │ Equilibrio costo/qualità (baseline)      │  │
│     │ min_vehicles   │ Massimizza concatenazione (meno mezzi)   │  │
│     │ min_deadhead   │ Riduce trasferimenti vuoti               │  │
│     │ monolinea ⭐   │ Bonus se i e j hanno stessa route_id     │  │
│     │ min_idle       │ Minimizza minuti morti tra corse         │  │
│     │ compact        │ Pairing serrato (gap minimi)             │  │
│     │ depot_minimal  │ Evita rientri al deposito intermedi      │  │
│     │ aggressive     │ Costo bassissimo, accetta qualità minore │  │
│     └────────────────┴──────────────────────────────────────────┘  │
│                                                                     │
│   Ogni scenario:                                                    │
│     • seed CP-SAT diverso (42 + idx × 101)                         │
│     • randomize_search = True                                       │
│     • warm-start = miglior soluzione finora                        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 5 — POLISH PHASE (rifinitura finale)                          │
│   Ri-esegue CP-SAT con strategia 'balanced' per 20% del tempo      │
│   totale, partendo dal miglior scenario. Spesso recupera           │
│   ulteriore 1-3% di costo.                                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 6 — ADVANCED LOCAL SEARCH (5 tipi di mossa)                   │
│   • merge      → unisce due chain                                  │
│   • relocate   → sposta un trip da una chain all'altra             │
│   • swap       → scambia posizione di due trip                     │
│   • or_opt     → riordina segmento di 1-3 trip                     │
│   • rebalance  → redistribuisce carico tra chain lunghe e corte    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 7 — CHAIN → VEHICLE SHIFT (formato output)                    │
│   Inserisce automaticamente:                                        │
│     • depot pull-out (uscita iniziale dal deposito)                │
│     • deadhead (trasferimento vuoto tra corse)                     │
│     • depot return (rientro intermedio)                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 📤 Output
```jsonc
{
  "vehicleShifts": [
    {
      "vehicle_id": "V001",
      "vehicle_type": "urbano",
      "trips": [...],         // mix di trip + deadhead + depot
      "total_service_min": 480,
      "total_deadhead_km": 12.3,
      "depot_returns": 1
    }
  ],
  "metrics": {
    "vehicles": 24,
    "totalServiceKm": 1240.5,
    "totalDeadheadKm": 87.3,
    "costEur": 4250.80,
    "savingsEur": 320.50,        // vs greedy
    "savingsPct": 7.0,
    "scenariosRun": 8,
    "bestStrategy": "Preferenza monolinea"
  },
  "optimizationAnalysis": { ... },     // narrativa per UI
  "scenarioRanking": [ ... ]           // classifica scenari
}
```

---

## 3. Step 2 — Turni Guida (Crew Scheduling)

### 🎯 Obiettivo
Suddividere ogni **turno macchina** (vehicle block) in segmenti che possano essere svolti da uno o due autisti, rispettando il **RD 131/1938** e i contratti collettivi nazionali (CCNL).

### 📥 Input
```jsonc
{
  "vehicleShifts": [...],     // output dello Step 1
  "config": {
    "solverIntensity": 2,     // 1=Rapido | 2=Standard | 3=Aggressivo | 4=Estremo
    "bds": {
      "shiftRules": {         // ★ NUOVO: configurabile da UI ★
        "intero":      { "maxNastro": 435, "maxLavoro": 435 },
        "semiunico":   { "maxNastro": 555, "maxLavoro": 480, "intMin": 75, "intMax": 179 },
        "spezzato":    { "maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999 },
        "supplemento": { "maxNastro": 150, "maxLavoro": 150 }
      },
      "rd131":  { "attivo": true, "maxGuidaContinuativa": 270, "sostaMinima": 15 },
      "pasto":  { "attivo": true, "pranzoSostaMinima": 30 },
      "stacco": { ... },
      "riprese": { ... }
    },
    "weights": { ... },       // pesi obiettivo
    "selectedClusterIds": [...]  // cluster di cambio attivi
  }
}
```

### 🔧 Pipeline interna (`scripts/crew_scheduler_v4.py`)

```
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 1 — PARSE VEHICLE BLOCKS                                       │
│   Converte JSON → VehicleBlock[]                                    │
│   Ogni block contiene la sequenza di trip + deadhead + depot del    │
│   veicolo, con timestamp esatti e ID linea.                        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 2 — ANALISI PUNTI DI TAGLIO                                    │
│   Per ogni blocco identifica i CutCandidate (luoghi dove si può    │
│   spezzare il blocco per dare il cambio).                          │
│                                                                     │
│   SCORING TAGLIO (più alto = preferito):                           │
│     • +5.0 → taglio al capolinea con sosta ≥ 15 min                │
│     • +3.0 → taglio in cluster di cambio configurato               │
│     • +0.1 × min → bonus per gap lungo                             │
│     • -15.0 → stessa route (penalità: peggio di un cambio reale)   │
│     • -8.0  → no cluster                                           │
│     • -0.05 × min → penalità nastro lungo                          │
│                                                                     │
│   Tagli intra-corsa (in fermata intermedia, con sosta ≥ 2 min)     │
│   sono permessi ma penalizzati (-2.0 base) — preferenza al         │
│   capolinea.                                                        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 3 — COLLASSO CAMBI VICINI                                      │
│   Tagli a meno di 45 min uno dall'altro vengono collassati nel     │
│   migliore (BDS — un autista non cambia 2 volte in 1h).            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 4 — CLASSIFICAZIONE BLOCCHI                                    │
│   ┌────────────┬──────────────┬───────────────────────────┐        │
│   │ CORTO      │ ≤ 7h15       │ → 1 turno intero          │        │
│   │ CORTO_BAS. │ ≤ 7h15 + low │ → 1 turno intero ridotto  │        │
│   │ MEDIO      │ ≤ 9h15       │ → 2 turni / semiunico     │        │
│   │ LUNGO      │ > 9h15       │ → 3 turni o spezzato      │        │
│   └────────────┴──────────────┴───────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 5 — BUILD INITIAL SEGMENTS                                     │
│   Applica i tagli e genera Segment[] candidati.                    │
│   Ogni segment: (vehicle_id, start_min, end_min, trip_indexes)     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 6 — PORTFOLIO MULTI-SCENARIO CP-SAT (★ 8 strategie ★)         │
│                                                                     │
│   Numero scenari per intensity:                                    │
│     1 (Rapido)     → 14 scenari ×  ~6s = ~90s                      │
│     2 (Standard)   → 24 scenari × ~10s = ~4min  ← consigliato      │
│     3 (Aggressivo) → 36 scenari × ~13s = ~8min                     │
│     4 (Estremo)    → 48 scenari × ~18s = ~15min                    │
│                                                                     │
│   8 STRATEGIE (riscalano i pesi dell'obiettivo):                   │
│     ┌──────────────────┬────────────────────────────────────────┐  │
│     │ balanced         │ Costo + qualità in equilibrio          │  │
│     │ min_cost         │ Spinge al risparmio puro               │  │
│     │ min_drivers      │ Favorisce pair (meno autisti)          │  │
│     │ max_quality      │ Carichi di lavoro bilanciati           │  │
│     │ min_supplementi  │ Elimina straordinari                   │  │
│     │ min_spezzati     │ Evita turni spezzati                   │  │
│     │ min_transfer     │ Minimizza trasferimenti / auto         │  │
│     │ aggressive       │ Costo bassissimo anche con semi/spezz  │  │
│     └──────────────────┴────────────────────────────────────────┘  │
│                                                                     │
│   Output: best_duties (lista DriverDutyV3)                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 7 — POLISH PHASE                                               │
│   20% del tempo totale → ri-solve sul miglior scenario per         │
│   estrarre l'ultimo margine di ottimizzazione.                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 8 — VALIDAZIONE BDS COMPLETA                                   │
│   Ogni duty viene controllato contro:                               │
│     ✓ Nastro max (435/555/630 min)                                 │
│     ✓ Lavoro max (435/480/450 min)                                 │
│     ✓ Guida continuativa max 4h30 (RD 131)                         │
│     ✓ Sosta minima 15 min al capolinea                             │
│     ✓ Intervallo pasto (pranzo/cena ≥ 30 min)                      │
│     ✓ Stacco minimo tra turni                                      │
│     ✓ Max riprese per turno (default 2)                            │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ FASE 9 — HANDOVER & CAR POOL                                        │
│   • Identifica i cambi bus (un autista lascia, un altro prende)    │
│   • Calcola movimenti auto aziendali per portare gli autisti       │
│     nei punti di cambio (pool di 5 auto default)                   │
│   • Segnala conflitti (auto non disponibile a un dato orario)      │
└─────────────────────────────────────────────────────────────────────┘
```

### 📤 Output
```jsonc
{
  "duties": [
    {
      "duty_id": "D001",
      "duty_type": "intero",        // intero | semiunico | spezzato | supplemento
      "driver_idx": 1,
      "segments": [
        {
          "vehicle_id": "V003",
          "start_time": "06:12",    // include pre-turno 12 min
          "end_time": "13:27",
          "nastro_min": 435,
          "lavoro_min": 412,
          "guida_min": 380,
          "trips": [...]
        }
      ],
      "validation": {
        "compliant": true,
        "violations": []
      }
    }
  ],
  "handovers": [
    { "from_duty": "D003", "to_duty": "D012", "vehicle_id": "V005",
      "location": "Piazza Garibaldi", "time": "13:45" }
  ],
  "carPool": [
    { "car_id": "AUTO_2", "driver_idx": 5, "from": "Deposito",
      "to": "Capolinea Nord", "departure": "12:30" }
  ],
  "metrics": {
    "totalDuties": 32,
    "interi": 18, "semiunici": 8, "spezzati": 4, "supplementi": 2,
    "violations": 0,
    "scenariosRun": 24,
    "polishImprovementEur": 45.20
  },
  "optimizationAnalysis": { ... },     // narrativa portfolio
  "scenarioRanking": [ ... ]
}
```

---

## 4. Algoritmi di ottimizzazione

### 🧠 Solver: Google OR-Tools CP-SAT

Constraint Programming con propagazione SAT. Vantaggi:
- Trova soluzioni **provatamente ottimali** o quasi (gap %)
- Gestisce vincoli logici, di flusso e numerici uniti
- Multi-thread (8-16 worker in parallelo per intensità alta)
- Warm-start da soluzione greedy → riduce drasticamente tempo

### 🎲 Perché soluzioni diverse a ogni run?

Prima dell'ultimo refactor: stesso seed → stessa soluzione sempre.

**Ora**: ogni scenario usa
```python
solver.parameters.random_seed = 42 + scenario_idx * 101
solver.parameters.randomize_search = True
```
→ ogni scenario esplora un **ramo diverso** dell'albero di ricerca, e con 8-12 strategie su pesi diversi è statisticamente impossibile ottenere la stessa soluzione due volte.

### 📊 Anatomia della funzione obiettivo (Vehicle Scheduling)

```python
minimize  Σᵢ (fixed_cost[i] × first[i])           # costo fisso veicolo
        + Σ_arc (arc_cost[i,j] × seq[i,j])        # costo arco
```
Dove `arc_cost` include:
```python
cost_euro =
    dh_km × €/km × mul_deadhead             # vuoto
  + idle_min × €/min × mul_idle             # attesa
  + (long_idle - threshold) × €/min × mul_idle  # attesa lunga
  + per_depot_return × mul_depot            # rientro deposito
  − 0.5 × (mul_monolinea − 1) if same_route # bonus monolinea
  + gap_min × 0.005 × (mul_pairing − 1)     # penalità pairing
```

I `mul_*` sono i moltiplicatori della **strategia** corrente → riscalano selettivamente le componenti.

### 📊 Anatomia della funzione obiettivo (Crew Scheduling)

```python
minimize
    Σ duty (cost_orario × ore_lavoro)              # mul_cost
  + Σ duty (squared(work − target))                # mul_balance
  + Σ duty (penalty if duty_type == supplemento)   # mul_suppl
  + Σ duty (penalty if duty_type == spezzato)      # mul_spezz
  + Σ handover (cost_trasferimento)                # mul_transfer
```

---

## 5. Vincoli e normative

### 📜 RD 131/1938 (TPL urbano)

| Parametro | Default | Configurabile da UI |
|---|---|---|
| Max guida continuativa | 4h30 (270 min) | ✅ |
| Sosta minima reset continuità | 15 min | ✅ |
| Max lavoro giornaliero | 7h15 (435 min) | ✅ |
| Pre-turno deposito | 12 min | ✅ |
| Pre-turno cambio | 5 min | ✅ |

### 📜 SHIFT_RULES (massimali per tipo turno)

| Tipo | Nastro max | Lavoro max | Interruzione | maxPct |
|---|---|---|---|---|
| **Intero** | 7h15 (435) | 7h15 (435) | 0 | 100% |
| **Semiunico** | 9h15 (555) | 8h00 (480) | 1h15 – 2h59 | 12% |
| **Spezzato** | 10h30 (630) | 7h30 (450) | ≥ 3h | 13% |
| **Supplemento** | 2h30 (150) | 2h30 (150) | 0 | 100% |

✅ **Tutti modificabili da `Config → Normativa BDS → Limiti Turni Guida`**

### 📜 Intervallo Pasto

- Pranzo: sosta ≥ 30 min nella fascia 12:00 – 14:30
- Cena: sosta ≥ 30 min nella fascia 19:00 – 21:30

### 📜 Pre/Post Turno (4 livelli)

```
TURNO     pre_dep=12  pre_cambio=5   post_dep=0   post_cambio=0
RIPRESA   pre=12      post=0
PEZZO     pre_cambio=3                post_cambio=2
```

---

## 6. Configurabilità da UI

### 🎛️ Pannello Config (driver-shifts → bottone "Config")

```
╔══════════════════════════════════════════════════════════╗
║  CONFIG OPERATORE                                        ║
╠══════════════════════════════════════════════════════════╣
║  📊 Pesi obiettivo                                       ║
║     • costo · bilanciamento · supplementi · spezzati     ║
║     • trasferimenti                                      ║
║                                                          ║
║  ⚡ Intensità Solver (4 livelli)                         ║
║     ⚡ Rapido     →  14 scenari · ~90s                   ║
║     ⚖️ Standard   →  24 scenari · ~4 min  (consigliato)  ║
║     🧠 Aggressivo →  36 scenari · ~8 min                 ║
║     🔥 Estremo    →  48 scenari · ~15 min                ║
║                                                          ║
║  💰 Costi (€)                                            ║
║     • orario autista · supplemento · cambio bus · auto   ║
║                                                          ║
║  ⚠️ Normativa BDS                                        ║
║     ├─ Pre/Post Turno (8 parametri)                     ║
║     ├─ CE 561/2006 (3 parametri + on/off)               ║
║     ├─ Intervallo Pasto (2 parametri + on/off)          ║
║     ├─ Gestore Riprese (4 parametri)                    ║
║     └─ ★ Limiti Turni Guida (RD 131) ★                  ║
║         ├─ intero      { maxNastro, maxLavoro }          ║
║         ├─ semiunico   { maxNastro, maxLavoro,           ║
║         │                intMin, intMax }                ║
║         ├─ spezzato    { maxNastro, maxLavoro,           ║
║         │                intMin, intMax }                ║
║         ├─ supplemento { maxNastro, maxLavoro }          ║
║         └─ targetWork  { low, mid, high }                ║
╚══════════════════════════════════════════════════════════╝
```

### 🎛️ Pannello Optimizer Step (turni macchina)

```
╔══════════════════════════════════════════════════════════╗
║  ⚙️ Modalità Solver                                      ║
║     • Greedy (3 sec, soluzione approssimata)             ║
║     • CP-SAT (ottimizzazione combinatoria)               ║
║                                                          ║
║  🧠 Intensità CP-SAT (portfolio multi-scenario)          ║
║     ⚡ Veloce     ~60s   · 3 scenari                     ║
║     ⚙️ Normale    ~3min  · 5 scenari                     ║
║     🔬 Profondo   ~7min  · 8 scenari                     ║
║     🔥 Estremo    ~15min · 12 scenari                    ║
╚══════════════════════════════════════════════════════════╝
```

---

## 7. Output e analisi

### 📊 Card di analisi (visualizzate sotto i risultati)

#### 🎯 OptimizationAnalysisCard (turni guida)
Narrativa in italiano + 4 metriche principali:
- **Scenari eseguiti** (es. 24/24)
- **Strategie diverse usate** (es. 8)
- **Variabilità di costo** (spread tra miglior/peggior scenario)
- **Tempo speso**

#### 📊 ScenarioRankingCard
Classifica completa di tutti gli scenari con:
- Strategia usata + label colorato
- Numero turni · costo Euro
- Badge ★ NEW BEST sul migliore
- Icona 🪄 sulla polish phase
- Bar di confronto orizzontale

### 📊 Metriche operative dei turni guida

```jsonc
{
  "totalDuties": 32,
  "byType": {
    "intero": 18,        // 56%
    "semiunico": 8,      // 25% (max 12% normativo → ⚠️)
    "spezzato": 4,       // 12% (max 13% normativo ✓)
    "supplemento": 2     // 6%
  },
  "compliance": {
    "semiCompliant": false,      // 25% > 12% max
    "spezCompliant": true,
    "violationsTotal": 0
  },
  "workload": {
    "avgWorkMin": 412,
    "minWorkMin": 380,
    "maxWorkMin": 435,
    "stdDev": 18                 // più basso = più bilanciato
  }
}
```

---

## 8. Architettura tecnica

### 📁 File chiave

```
scripts/
├── vehicle_scheduler_cpsat.py    # Step 1: Vehicle Scheduling (1118 righe)
├── crew_scheduler_v4.py          # Step 2: Crew Scheduling (2729 righe)
├── optimizer_common.py           # Dataclass + costanti condivise
└── cost_model.py                 # Modello costi (CostRates, DutyCostBreakdown)

artifacts/
├── api-server/                   # Express + tsx
│   └── src/
│       ├── index.ts              # Server (timeout HTTP 25 min per CP-SAT)
│       └── routes/
│           ├── service-program.ts        # Endpoint /api/service-program/cpsat
│           └── driver-shifts.ts          # Endpoint /api/driver-shifts (job async)
└── transitintel/                 # React + Vite + Tailwind
    └── src/
        ├── pages/
        │   ├── fucina.tsx                # Wizard turni macchina (4 step)
        │   ├── fucina/steps/
        │   │   ├── DepotStep.tsx         # Step 1: scelta deposito
        │   │   ├── VehicleAssignmentStep.tsx  # Step 2: linee→veicoli
        │   │   ├── OptimizerStep.tsx     # Step 3: lancio CP-SAT
        │   │   └── WorkspaceStep.tsx     # Step 4: gantt + analisi
        │   └── driver-shifts.tsx         # Pagina turni guida
        └── components/
            ├── OperatorConfigPanel.tsx   # Pannello config (pesi+BDS+limiti)
            ├── OptimizationProgress.tsx  # Progress streaming SSE
            └── ui/...
```

### 🔄 Comunicazione client → solver

#### Turni macchina (sincrono)
```
Browser ──POST /api/service-program/cpsat──► Express
              { trips, config }
                                   │
                                   ▼
                            spawn Python
                            vehicle_scheduler_cpsat.py
                                   │
                                   ▼ stdout
                            JSON { vehicleShifts, metrics, ... }
                                   │
Browser ◄────── HTTP 200 ──────────┘
```

Timeout HTTP allungato a **25 minuti** per supportare intensità Estremo (15 min reali).

#### Turni guida (asincrono con jobId + SSE)
```
Browser ──POST /api/driver-shifts/start──► Express
                                   │ spawn detached
                                   │ ritorna jobId
Browser ◄── 202 { jobId } ─────────┘

Browser ──GET /api/driver-shifts/{jobId}/stream──► SSE
              ◄── progress events (5%, 10%, ...) ──
              ◄── final result {duties, ...} ──────
```

### ⚙️ Tempi default attuali

| Step | Modalità | Default | Estremo |
|---|---|---|---|
| Turni Macchina | greedy | 3s | 3s |
| Turni Macchina | CP-SAT | 180s (normal) | 900s (15 min) |
| Turni Guida | CP-SAT | 240s (standard) | 900s (15 min) |

---

## 🎯 Esempio di output reale

```
=== CP-SAT Vehicle Scheduler v2 (MAIOR-inspired) ===
  Trips: 248, intensity: deep, forced: false
  Arcs: 4827
  Greedy: 28 vehicles, EUR 4570.30

[VSP-MULTI] 8 scenari × 47s + polish 84s (totale 420s, int=deep)
  Scenario 1 (balanced):     27 veh, EUR 4380.20  (-190.10) ★ NEW BEST
  Scenario 2 (min_vehicles): 25 veh, EUR 4395.80  (-15.40)
  Scenario 3 (min_deadhead): 27 veh, EUR 4351.10  (-29.10) ★ NEW BEST
  Scenario 4 (monolinea):    26 veh, EUR 4368.90  (+17.80)
  Scenario 5 (min_idle):     27 veh, EUR 4344.50  (-6.60)  ★ NEW BEST
  Scenario 6 (compact):      27 veh, EUR 4352.20  (+7.70)
  Scenario 7 (depot_min):    26 veh, EUR 4339.80  (-4.70)  ★ NEW BEST
  Scenario 8 (aggressive):   25 veh, EUR 4338.90  (-0.90)  ★ NEW BEST
    Polish migliora: EUR 4338.90 → EUR 4321.50

[LS] 1247 iter, 25 chains, EUR 4318.20, 30.0s

=== RESULTS ===
  Vehicles: 25 (greedy was 28)
  Cost: EUR 4318.20 (greedy EUR 4570.30)
  Savings: EUR 252.10 (5.5%)
  Total time: 458.3s
```

---

## 🚀 Roadmap suggerita

1. **Streaming progress per vehicle scheduler** (SSE, come crew)
2. **Card di confronto strategie** anche per turni macchina (pari al ScenarioRankingCard del crew)
3. **Salvataggio scenari turni macchina** (oggi solo turni guida)
4. **Cross-day scheduling** (turni che attraversano la mezzanotte)
5. **Vincolo competenze autista** (es. patente extra-urbana)

---

> **Documento generato il 18/04/2026**
> Versione algoritmi: vehicle_scheduler_cpsat v2 · crew_scheduler_v4
> Solver: Google OR-Tools CP-SAT 9.x
