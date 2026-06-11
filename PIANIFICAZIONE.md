# Pianificazione operativa del TPL — struttura canonica e applicazione a TransitIntel

> Sintesi della letteratura di ricerca operativa (Ceder; Desaulniers & Hickman;
> Ibarra-Rojas et al.) e degli standard CEN (Transmodel/NeTEx), con le decisioni
> architetturali per TransitIntel. Bibliografia in fondo.

## 1. La pipeline canonica

La letteratura OR descrive la pianificazione TPL come processo sequenziale a fasi
(ogni sottoproblema è NP-hard, da cui la decomposizione):

| Livello | Fase | Modulo TransitIntel |
|---|---|---|
| Strategico | 1. Network design (linee, percorsi, fermate) | Planner Studio (rete) |
| Tattico | 2. Frequency setting | Territory/Analytics (domanda) → Planner Studio |
| Tattico | 3. Timetabling (orari corse) | Planner Studio (trips/stop_times) |
| Operativo | 4. Vehicle scheduling (VSP/MDVSP) | Fucina · turni macchina (CP-SAT) |
| Operativo | 5. Crew scheduling (CSP, run-cutting) | Fucina · turni guida (CP-SAT, RD 148/CCNL) |
| Operativo | 6. Crew rostering | Roster (`/roster`) |
| Esercizio | 7. Dispatching / real-time | Sala Operativa + AVM Caronte + GTFS-RT |

La struttura dati della suite riflette la gerarchia: **rete → programma di
esercizio → unità di progettazione → turni macchina → turni guida → roster**,
con un solo programma **operativo** alla volta (feed attivo).

## 2. Giorni-tipo: come tenere POCHE unità di progettazione

L'anno ha ~365 giorni di esercizio ma si progetta su pochi **giorni-tipo**
(Transmodel/NeTEx: `DAY TYPE`). Prassi consolidata italiana: feriale invernale
scolastico, feriale invernale non scolastico, feriale estivo, sabato, festivo,
più giorni speciali (vigilie, agosto, eventi).

**Algoritmo raccomandato per il calcolo delle unità (2 livelli):**

1. **Livello esatto** — due date sono equivalenti se l'insieme delle corse
   attive è identico (hash dell'insieme ordinato di trip per data). È la
   semantica GTFS: ogni `service_id` è una classe di equivalenza. *(È quello
   che fa oggi il "Calcola Unità" della matrice di validità.)*
2. **Livello progettuale con tolleranza** — clustering agglomerativo
   gerarchico (average linkage) sulla **distanza di Jaccard tra insiemi di
   corse**: `d(A,B) = 1 − |A∩B| / |A∪B|`, con **soglia configurabile
   dall'operatore (slider 0–5%)**. Con soglia 0 si degenera nel livello
   esatto; con 2–5% i giorni quasi-uguali si fondono e le unità crollano da
   decine a una manciata. Il rappresentante del cluster è la data modale;
   le corse presenti solo in alcune date del cluster vengono marcate come
   **eccezioni dell'unità** (visibili, non perse).

**Vincoli pratici (non negoziabili):**
- Partizioni hard **feriale / sabato / festivo** dentro cui clusterizzare:
  mai fondere giorni con regole contrattuali diverse anche se le corse
  coincidono al 97%.
- Variante pesata: Jaccard pesato sulle vetture·km della corsa (una corsa
  scolastica da 30 km non pesa come un rinforzo da 3 km).
- Spiegabilità: per ogni fusione mostrare il delta ("il 24/12 differisce dal
  feriale tipo per il 4% delle corse: queste 12").

## 3. Validità: un sistema semplice per gli operatori

I sistemi commerciali (HASTUS, IVU.plan, MAIOR, Optibus) convergono su tre
pattern componibili; la raccomandazione per TransitIntel è la **doppia
rappresentazione**:

- **Source of truth editabile = livelli stratificati con precedenza**
  (dal basso): base settimanale → stagione (inverno/estate) → calendario
  scolastico → festività → eccezioni puntuali. L'operatore NON tocca le
  singole date: dichiara «questa linea: feriale ∧ scolastico ∧ inverno,
  esclusa la vigilia» componendo concetti nominati (stile NeTEx
  `ValidityCondition`).
- **Rappresentazione compilata = bitmask di 365/730 date**, ricalcolata a
  ogni modifica e usata da: motori di calcolo, materializzazione GTFS,
  conteggi (vetture·km, ore guida annue) e dalla **validazione di
  copertura**: «ogni data dell'anno è coperta da esattamente un giorno-tipo
  per contratto?» (zero buchi, zero sovrapposizioni).

UX consigliata: wizard a 3 passi per linea o gruppo di linee —
(1) scegli il pattern settimanale, (2) scegli stagione + scolastico da
calendari aziendali predefiniti, (3) aggiungi eccezioni puntuali. La matrice
di validità esistente resta come *vista compilata* di verifica.

## 4. Rostering

- **Ciclico vs aciclico** (Xie & Suhl 2015): per il TPL italiano lo standard è
  il roster **ciclico** (rotazione di un pattern di n settimane su un gruppo
  omogeneo di agenti) + riga di scorta/disponibilità. Il tabellone attuale
  (`/roster`) è la base aciclica manuale; la v2 aggiunge generazione del
  pattern ciclico a due fasi: prima i **riposi** (days-off pattern, es. 6+2 a
  scorrimento — Mesquita et al. 2015), poi l'assegnazione dei turni alle
  celle lavorative.
- **Normativa**: il Reg. (CE) 561/2006 NON si applica ai servizi di linea
  ≤ 50 km (art. 3.a): valgono R.D. 148/1931, D.Lgs. 234/2007 e CCNL
  Autoferrotranvieri. Il motore di regole deve quindi essere **parametrico
  per contratto** (urbano vs extraurbano > 50 km), mai cablato su un solo
  regime. I parametri BDS della Fucina sono già configurabili: la stessa
  filosofia va estesa al roster (riposo giornaliero 11h, riposo settimanale,
  limite 6° giorno).

## 5. Integrazione veicoli-personale

La ricerca (Freling/Huisman/Wagelmans 2003; Borndörfer/Löbel/Weider 2008;
Steinzen 2010) misura risparmi 1–5% con l'integrazione completa VSP+CSP, ma a
costi computazionali alti. **Per operatori da 100–300 mezzi la raccomandazione
è l'integrazione parziale**: sequenziale con vincoli *crew-aware* nel vehicle
scheduling (limiti di lunghezza blocco, cambi agente solo ai cluster
presidiati) + feedback iterativo — che è esattamente l'architettura attuale
della Fucina (i cluster di cambio guidano già il taglio dei blocchi).
L'integrazione piena resta un'opzione futura per singole unità critiche.

## Bibliografia essenziale

- Ceder, A. — *Public Transit Planning and Operation*, 2ª ed., CRC Press, 2016.
- Desaulniers, G., Hickman, M. — "Public Transit", *Handbooks in OR & MS*, vol. 14, Elsevier, 2007.
- Ibarra-Rojas, O.J. et al. — "Planning, operation, and control of bus transport systems: A literature review", *Transportation Research Part B*, 77, 2015.
- Bertossi, Carraresi, Gallo — "On some matching problems arising in vehicle scheduling models", *Networks*, 17, 1987 (NP-hardness MDVSP).
- Borndörfer, Grötschel, Löbel — "Duty Scheduling in Public Transit", Springer, 2003.
- Freling, Huisman, Wagelmans — "Models and algorithms for integration of vehicle and crew scheduling", *Journal of Scheduling*, 6, 2003.
- Borndörfer, Löbel, Weider — "A Bundle Method for Integrated Multi-Depot Vehicle and Duty Scheduling", Springer, 2008.
- Xie, L., Suhl, L. — "Cyclic and non-cyclic crew rostering problems in public bus transit", *OR Spectrum*, 37, 2015.
- Mesquita, M. et al. — "A decompose-and-fix heuristic … for driver rostering with days-off pattern", *EJOR*, 245(2), 2015.
- CEN — Transmodel EN 12896 / NeTEx CEN/TS 16614 (DAY TYPE, ValidityCondition).
- Reg. (CE) 561/2006, art. 3 (esenzione servizi regolari ≤ 50 km); R.D. 148/1931; D.Lgs. 234/2007; CCNL Autoferrotranvieri.
