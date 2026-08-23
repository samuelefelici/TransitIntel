# Planning Studio — il modulo di progettazione del servizio

> Dove si disegna il servizio prima che diventi esercizio: rete, corse, orari,
> validità, unità di progettazione. È il modulo su cui lavora **Argos**,
> l'agente pianificatore (repo `samuelefelici/argos`).
>
> Per la teoria e le decisioni architetturali vedi [`PIANIFICAZIONE.md`](PIANIFICAZIONE.md);
> per i solver di turni macchina e turni guida [`SCHEDULING_ENGINE.md`](SCHEDULING_ENGINE.md).

---

## 1. Cos'è un progetto

Un **progetto** (`ps_projects`) è un contenitore isolato: la sua rete, le sue
corse, le sue validità. Ci si lavora dentro senza toccare il feed in esercizio;
alla fine si **materializza** in GTFS e lo si manda in produzione.

La catena verticale che il progetto deve reggere:

```
rete (linee, varianti, fermate)
  └─ corse (trips + stop_times)
       └─ validità (giorni-tipo, categorie, matrice)
            └─ UDP (unità di progettazione)
                 └─ turni macchina  →  turni guida  →  roster
```

Ogni anello a valle dipende da quello a monte: cambiare una fermata di una
variante non è un fatto grafico, tocca gli orari delle corse che ci passano, e
di lì la validità e il conteggio delle vetture. Il modulo è costruito per
rendere questa propagazione **esplicita e verificabile**, non per nasconderla.

## 2. Le sezioni del progetto

Barra di navigazione: `artifacts/transitintel/src/components/planning-studio/PsProjectNav.tsx`.
Tutte le rotte stanno sotto `/planning-studio/:id`.

| Sezione | Rotta | Cosa fa |
|---|---|---|
| **Editor rete** | `/` | disegno di linee, varianti e percorsi sulla mappa |
| **Ispettore** | `/network` | lettura della rete: linee, varianti, fermate, km |
| **Corse** | `/trips` | elenco corse, orari, validità, selezione a blocchi |
| **Percorrenze** | `/percorrenze` | tempi di percorrenza dai dati di traffico |
| **Grafico** | `/ttd` | diagramma tempo-distanza e libretto orario |
| **Calendario** | `/calendar` | profili di calendario e giorni-tipo |
| **Validità** | `/validity` | la matrice corsa × giorno-tipo — la verità |
| **UDP** | `/validity-units` | unità di progettazione calcolate dalla matrice |
| **Nodi** | `/clusters` | cluster di fermate, punti di coincidenza |
| **Zonizzazione** | `/zones` | zone tariffarie e aree |
| **Depositi**, **Fuorilinea**, **Intermodale** | `/depots`, `/deadhead-arcs`, `/intermodal` | infrastruttura del progetto |
| **Registro** | `/activity` | chi ha fatto cosa e quando, operatore o Argos |
| **Esercizio** | `/fucina/esercizio/:id` | il progetto visto dal lato turni |

## 3. Editor rete — il principio della chirurgia locale

La regola che governa tutto l'editor:

> Ho un percorso A → B → C → D → E → F → G. Se tolgo la fermata A, mi aspetto
> A fuori dall'elenco e il tratto A → B non più visibile — e il percorso
> B → C → D → E → F → G **non deve subire modifiche** dovute al ricalcolo.

Nessuna operazione ridisegna l'intero tracciato. `applyLocalEdit` +
`rebuildGeometryLocally` (in `EditorPage.tsx`) ricostruiscono la geometria così:

- le **tratte sopravvissute** restano fette esatte della polilinea vecchia,
  vertice per vertice — non vengono ri-snappate;
- solo i **buchi** aperti dalla modifica vengono ricalcolati, con **una** chiamata
  OSRM per ogni sequenza contigua di buchi;
- le **code** tagliate agli estremi si potano senza chiamare OSRM;
- le giunzioni vengono deduplicate, altrimenti nascono vertici doppi.

`projectWaypointsOnCoords` proietta i waypoint sulla polilinea in avanzamento
monotono: è ciò che rende affidabile il taglio quando il percorso si ripassa
sopra (anelli, capolinea condivisi).

Altri comportamenti che vale la pena conoscere:

- **prima / dopo**: ogni fermata dell'elenco ha le frecce ⤴ ⤵ per scegliere da
  che lato del riferimento inserire; il click su una riga la elegge riferimento.
  Lo stato viaggia in `ref` (`insertSideRef`, `insertAfterIdxRef`) perché i click
  sulla mappa leggano sempre il valore fresco, non quello catturato dalla closure.
- **trascinamento della linea**: sposta **solo** il segmento fra le due fermate
  che lo delimitano.
- **Manuale**: imposta la modalità solo per i **punti nuovi**. Non linearizza il
  percorso esistente.
- Le risposte OSRM sono sequenziate (`snapSeqRef`): una risposta superata da una
  modifica successiva viene scartata invece di ridipingere un tracciato vecchio.

## 4. Corse e orari

`ps_trips` + `ps_stop_times`. Gli orari GTFS possono superare le 24:00 (`25:10:00`
è l'una e dieci del giorno dopo): si usano sempre gli helper `hmsToSec`/`secToHms`,
mai il parsing ingenuo.

- Ordinamento per colonna da ogni intestazione; selezione a blocchi con
  **Shift+click** (modello Explorer: àncora + snapshot, il blocco si riaggiusta).
- Il **codice percorso** della variante segue la corsa nell'elenco ed è leggibile
  da Argos nel quadro orario.
- Cambiare la sequenza di fermate di una variante **riallinea automaticamente**
  gli orari di tutte le sue corse, nella stessa transazione:
  `artifacts/api-server/src/lib/variant-stop-times-sync.ts` (modulo puro, coperto
  da vitest). Regole: fermata conservata → transito intatto; fermata rimossa →
  transito che sparisce; fermata nuova in mezzo → interpolata sulle progressive;
  fermata nuova in testa o coda → estrapolata sulla velocità media; meno di due
  transiti noti → la corsa **non** viene toccata e lo si dichiara nella risposta.
  L'abbinamento è **cronologico** (cursore che avanza), non per `stop_id`:
  altrimenti sui percorsi ad anello la stessa fermata verrebbe abbinata al
  passaggio sbagliato.

## 5. Percorrenze

`/percorrenze` — due modalità sullo stesso motore:

- **Moltiplica corsa base**: da una corsa di riferimento genera una cadenza,
  applicando ai singoli archi il coefficiente di traffico dell'ora di ingresso.
- **Ricalcola esistenti**: prende una cadenza già assegnata e ne rifà le
  percorrenze, con anteprima del Δ corsa per corsa.

Server: `POST /planning-studio/projects/:id/trips/retime`
(`artifacts/api-server/src/lib/planning-studio-trips-ext.ts`). La corsa di
riferimento resta intatta (profilo neutro); ogni corsa è ancorata alla **propria**
partenza; le corse con pattern di fermate diverso vengono saltate e dichiarate.
Tutto in una transazione, tetto di 500 corse, registrato come `trip.retime_traffic`.

Il profilo orario è condiviso fra client e server
(`artifacts/transitintel/src/lib/traffic-profile.ts`) perché l'anteprima mostri
esattamente ciò che verrà scritto.

## 6. Grafico (tempo-distanza)

`/ttd`. Asse verticale = fermate, asse orizzontale = tempo.

- **Selezione multipla** di linee e varianti da un menu a spunte; una variante è
  il **riferimento** (★) e le altre si accendono in overlay.
- L'asse delle fermate è un'**unione per nodo**: due fermate si fondono se stanno
  nello stesso cluster o hanno lo stesso nome entro 150 m, con rilevamento della
  direzione — è ciò che permette di sovrapporre andata e ritorno senza che
  l'ordine impazzisca.
- Asse **completo o compatto**: il compatto tiene capolinea e nodi e salta le
  fermate intermedie interpolate.
- **Validità multipla** con tre modalità di colorazione.
- Vista **libretto orario** oltre al diagramma.
- Qualsiasi corsa accesa si **trascina**; la partenza e il singolo nodo si
  scrivono come `HH:MM` o si spostano al minuto con −/+ e con ←/→ (Shift = 5).
  Un nodo spinto oltre la fermata successiva viene rifiutato con un messaggio.
- Le modifiche sono **locali** finché non si salva (`pendingOps`), e **Ctrl+Z**
  le annulla una per una.

## 7. Validità, UDP, calendario

- La **matrice** corsa × giorno-tipo (`ps_trip_day_validity`) è la verità. Tutto
  il resto — categorie (`ps_validity_categories`, `ps_trip_category_validity`),
  profili di calendario, bollini — è un modo comodo di compilarla.
- Le **UDP** (`ps_validity_units`) si calcolano dalla matrice: due date sono la
  stessa unità se l'insieme delle corse attive coincide. Il metodo, e il
  clustering con tolleranza, sono discussi in [`PIANIFICAZIONE.md`](PIANIFICAZIONE.md) §2.
- La validità si bollina anche **per linea intera** (`routeIds`), che è ciò che
  evita le corse-zombie quando si lavora a colpi di centinaia.

## 8. Argos dentro Planning Studio

L'agente vive in un pannello laterale (`components/ArgosSidebar.tsx`,
`components/argos/*`) e parla con il servizio Argos via proxy.

- Tre posture: **agente** (indaga), **piano** (chiude sempre con card
  approvabili), **accetta** (applica). Senza `accetta` non si scrive nulla.
- **Regia in diretta**: mentre l'agente lavora, `ArgosLiveBridge` apre la
  schermata pertinente — la mappa sulla variante che sta modificando, l'elenco
  corse su quelle che ha appena generato.
- **Anteprima fantasma**: un percorso proposto si vede tratteggiato e agganciato
  alla strada (OSRM) **prima** di confermare.
- **Annullo del turno**: disfa le scritture di un run e ripristina i bollini di
  validità com'erano.
- **Registro attività**: ogni scrittura è attribuita a chi l'ha fatta, operatore
  o Argos (`ps_project_activity_log`).
- **Stima istantanea**: `POST /planning-studio/projects/:id/quick-estimate`
  risponde in meno di un secondo su corse reali e **ipotetiche** insieme, e
  dichiara sempre i propri limiti nel payload. Il giudizio vero resta il CP-SAT
  della Fucina.
- Vincolo che non si negozia: **l'agente non crea né propone fermate nuove**.

Il connettore **MCP** di Argos legge questo stesso progetto in sola lettura dalle
app Claude dell'utente. Il conio dei token a breve scadenza avviene qui:
`POST /cron/argos-mcp-token` e `/cron/argos-mcp-projects`
(`artifacts/api-server/src/routes/argos-watch.ts`), protetti da `x-cron-secret`.
Lo stesso segreto serve ad Argos per **rinnovare** il token utente durante i turni
lunghi: senza, un turno oltre i 10 minuti muore a metà.

## 9. Dove sta il codice

| Cosa | Dove |
|---|---|
| Pagine | `artifacts/transitintel/src/pages/planning-studio/` |
| Componenti condivisi | `artifacts/transitintel/src/components/planning-studio/` |
| Client API | `artifacts/transitintel/src/lib/planning-studio-api.ts` |
| Rotte progetto/rete/corse | `artifacts/api-server/src/lib/planning-studio.ts` |
| Estensioni corse (retime, bulk) | `artifacts/api-server/src/lib/planning-studio-trips-ext.ts` |
| Riallineamento orari | `artifacts/api-server/src/lib/variant-stop-times-sync.ts` |
| Validità e UDP | `artifacts/api-server/src/lib/planning-studio-validity*.ts` |
| Stima istantanea | `artifacts/api-server/src/lib/quick-estimate.ts`, `src/routes/planning-studio-estimate.ts` |
| Proxy e contesto Argos | `artifacts/api-server/src/routes/argos-*.ts` |
| Materializzazione GTFS | `artifacts/api-server/src/lib/planning-studio-materialize.ts` |

## 10. Verifica

```bash
pnpm run typecheck                    # tutto il workspace — è ciò che gira in CI
pnpm --filter transitintel typecheck  # solo il frontend, più rapido

# i moduli puri della pianificazione, ~1 secondo, nessun servizio richiesto
pnpm --filter @workspace/api-server exec vitest run \
  src/__tests__/variant-stop-times-sync.test.ts \
  src/__tests__/quick-estimate.test.ts \
  src/__tests__/planning-studio-validity-eval.test.ts \
  src/__tests__/validity-matrix-pure.test.ts \
  src/__tests__/timetable-merge.test.ts \
  src/__tests__/day-classifier.test.ts
```

I moduli che fanno aritmetica su orari e validità sono **puri e testati**.
Quando una regola riguarda orari o bollini, la si scrive lì e la si copre con
vitest — non dentro una rotta Express, dove nessuno può più metterla alla prova.

> ⚠️ `pnpm --filter @workspace/api-server test` esegue **tutta** la suite,
> comprese `cache`, `driver-shifts` e `optimizer-route`, che montano rotte
> Express e vogliono database e servizi: senza, vanno in timeout. Non è una
> regressione della pianificazione — per quella basta il comando mirato qui
> sopra.

La CI (`.github/workflows/ci.yml`) esegue il typecheck dell'intero workspace.
