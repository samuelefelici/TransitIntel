# Argos · stato dei lavori (Domenica Ancona)

Nota di passaggio fra sessioni: chi riprende parte da qui, senza ricostruire il contesto dalla chat.
Aggiornata al 7 settembre 2026, 14:40 UTC.

## Progetto e vincoli di test

- Progetto Planning Studio «Domenica Ancona»: `fe78db8e-11b9-4ac9-bdb2-a21ef9892244`, giorno-tipo festivo, data di esercizio di prova 2026-09-20, 17 linee urbane, 365 corse festive.
- **Solo il deposito di Ancona** (`b2f3de29-aa93-4d02-adcb-b866f0581998`) in ogni giro: `depotIds` sempre valorizzato. Gli altri depositi (Jesi ecc.) hanno tratte senza arco in archivio.
- Parametri del giro di riferimento: `date 2026-09-20, mode vcsp, serviceType urbano, companyCars 5, crewShiftScope trip, shiftPenaltyEur 1`; per il giro «a regola d'arte»: `intensity deep, **rounds 5, probes 6, crewTimeLimit 240**, crewSolverIntensity 3, crewMaxRounds 10, crewWeights {minDrivers 10, preferIntero 10, minSupplementi 10, qualityTarget 3, workBalance 1, minCambi 1}`.
- **Prima di confrontare due giri, verifica i parametri di tutti e due** con `ti_vcsp_status` senza jobId (elenca i giri recenti col loro `params`). Questa riga diceva `rounds 3, probes 10, crewTimeLimit 600` mentre i giri della serie AL→AQ2 giravano con `rounds 5, probes 6, crewTimeLimit 240`: fidarsi della nota invece dei giri veri ha prodotto un confronto senza senso e una diagnosi sbagliata («varianza del solver») il 9 settembre.
- Le corse hanno tutte una tipologia dichiarata: `defaultVehicleType` non serve, e passarlo cambia `vehicleSource` da `planning` a `planning+default`.

## Regole dell'azienda recepite nel motore

- BDS: intero ≤ 7:15; semiunico ≤ 9:15 con interruzione ≥ 1:15; spezzato ≤ 10:30 con interruzione ≥ 3:00; **massimo 5 autovetture aziendali — inviolabile** (il progetto è configurato a 6: passare `companyCars: 5` esplicito a ogni giro finché non viene corretto); domenica: più interi possibile.
- Costo del conducente: **27 €/ora**. Corrispettivo: **2,60 €/km su TUTTI i km**, di linea e di fuorilinea. Un fuorilinea non è quindi una perdita: 10 km rendono 26 €, costano ~9,50 € di mezzo e ~13,50 € di conducente. Quello che costa davvero sono **le ore pagate**.
- Tetti percentuali di semiunici e spezzati rigidi, sforabili al massimo di 0,9 turni entro l'unità intera; base di calcolo = turni senza i supplementi (modello e stato allineati).
- Bus mai incustodito oltre 15′; il montante prende il bus all'arrivo (sosta ≤ 30′ coperta); ogni cambio scritto nel turno («In [nodo] lascia/prende la vettura al turno …»).
- Fuorilinea solo dall'archivio di Planning Studio, stesso tempo in andata e ritorno; rientri in deposito reali; corse di rientro in linea proposte al posto dei vuoti.
- Regola del giro sulle linee radiali: dal capolinea periferico si riparte con la corsa di ritorno dello stesso bus.
- **Nel servizio urbano non esistono** né il tetto di guida per ripresa (4h30) né la guida continuativa RD 131: entrambi spenti con `serviceType urbano`, salvo attivazione esplicita in `bds.riprese.maxGuidaPerRipresa` / `bds.rd131.attivo`.
- Codici dei turni guida: lettera del deposito + tre cifre, 001–099 mattinali (inizio nastro prima delle 12:00), 100–199 pomeridiani (es. A005).
- Fogli turno: una pagina A4 per turno (voce «Fogli turno» nel menu Esporta e dalla card del singolo turno); accanto alla matricola c'è il tipo di mezzo.
- **Regola della sagoma.** Il tipo dichiarato su una linea è il mezzo giusto **e insieme il suo tetto fisico**: sopra quella taglia la strada non regge. Scala: autosnodato (18 m) → 12 m → 10 m → pollicino. Quindi:
  - **mai un mezzo più grande** del dichiarato (non è spreco: non passa);
  - si può **declassare di un gradino solo**, mai due (il pollicino non fa una corsa da 12 m: sarebbe un doppio declassamento);
  - un blocco di una certa taglia serve solo le linee della propria taglia e quelle di **una** taglia superiore, queste ultime declassate;
  - il declassamento è **l'ultima spiaggia**, non la norma: una corsa isolata fuori punta non fa danno, venti sì. Tetti di riferimento: 10% delle corse della linea, 5% in punta;
  - quando la sagoma impedisce di allungare un blocco, **non si piega il blocco: si muove il conducente** con un cambio, che deve stare dentro i cluster e lasciare il mezzo fermo non oltre 15′;
  - un cambio in più vale la pena se fa risparmiare un mezzo.
  - Ad Ancona: pollicino, 10 m, 12 m, autosnodato (solo 1/4 e 10). Massimo **3 pollicini**, nessun tetto sugli altri tipi. Tutti i conducenti guidano tutti i tipi.
  - Domenica la punta è **il pomeriggio** (15:00–20:00), non mattina e sera: fasce configurabili in `config.sagoma.fascePunta`.

## Ordine di ragionamento dell'operatore (come si costruisce un piano)

Dettato dall'operatore, ed è l'ordine da seguire quando si lancia e si giudica un giro:

1. **Riempire i turni macchina** di corse della giusta dimensione di mezzo, cercando la **saturazione massima** e riducendo al minimo il numero di vetture.
2. **Creare i turni guida** su quei blocchi.
3. **Spostare corse fra turni macchina diversi** per ridurre o migliorare i turni guida. È il passo che si salta più facilmente, ed è quello che risolve i problemi di cambio.
4. Solo se non basta, **spostare corse in pianificazione**: spostamenti mirati, sapendo che effetti generano su TM e TG.

Nel motore: il passo 3 è il ciclo VSP↔CSP a costi-ombra dell'orchestratore VCSP, il passo 4 è la sonda di spostamento (oggi timidissima: accetta 0–2 spostamenti su 4 prove).

## Il piano festivo REALE di Ancona, come metro di paragone

Da `AN_Festivo_Invernale_2026.pdf`, 38 fogli turno veri:

| | Piano umano | Nostro giro AF |
|---|---|---|
| Turni guida | 38 (37 Interi + 1 supplemento) | 37 |
| Turni macchina | 21 | 19 |
| Semiunici / spezzati | **0 / 0** | 5 / 2 |
| Nastro totale | 244h19 (media 6h25) | — |
| Scambi di vettura | 42 | 29 |
| **Trasferimenti in auto** | **8** | tutti i 29 |
| Fuorilinea | 88 | — |

**La lezione più importante di tutte.** Loro fanno PIÙ scambi di noi e consumano UN QUINTO delle auto. Il meccanismo sta nelle note dei fogli: «(A) = Consegnare la vettura al A011», «(B) = Ritirare la vettura dal A011». I turni **iniziano e finiscono in deposito** — il conducente porta fuori il bus e lo riporta dentro (88 fuorilinea) — e lo scambio avviene fra due conducenti **già entrambi al nodo**. Costo in autovetture: zero.

Nel nostro modello `_walk_partner` (`crew_scheduler_v3.py:1138`) cerca il compagno di scambio **solo dentro lo stesso turno**: in ogni altro caso chiama l'auto. Manca la mossa del deposito, ed è la causa di tutti gli sforamenti del tetto auto della serie AA–AF. **Non è una taratura, è un pezzo di modello mancante.**

Dove lasciano valore loro: nastri fra 6h11 e 6h58 contro un tetto di 7h15, cioè **31h11 di margine non usato** — a nastro pieno basterebbero 33,7 turni invece di 38. Obiettivo: **≤ 34 turni guida e < 21 turni macchina**.

Altro meccanismo che non abbiamo: la **Riserva** (4 casi, 4h45) — conducente fermo in deposito, pagato, dentro un turno che resta Intero.

## Serie di giri Z → AF (regola della sagoma)

| Giro | Vetture | Turni | Auto (tetto 5) | Incustodito | Note |
|---|---|---|---|---|---|
| Y | 18 | 40 | 5/5 ✓ | 15′ ✓ | prima della sagoma |
| Z | 21 | 43 | — | — | sagoma accesa, 28,5% declassate |
| AA | 19 | 43 | 8 ❌ | 105′ ❌ | 1/4 inchiodata al 12 m |
| AB | 19 | 43 | 7 ❌ | 81′ ❌ | più tempo al solver guida: non basta |
| AC | 28 | 42 | 5 ✓ | 15′ ✓ | giunti mirati, penalità troppo care |
| AD | 19 | 43 | 6 ❌ | 81′ ❌ | penalità ricalibrate |
| AE | 24 | 42 | 5 ✓ | 15′ ✓ | escalation delle penalità |
| **AF** | **19** | **37** | 7 ❌ | 105′ ❌ | scarsità delle auto; miglior piano, batte quello umano su vetture e turni |
| AG | 19 | 38 | 7 ❌ | 105′ ❌ | km a vuoto pagati (#456): **nessun effetto**, 169,5 km contro 171,2 |
| AH | 26 | 41 | **5 ✓** | **15′ ✓** | taglio in deposito ammesso (#457): regole rispettate, ma 7 vetture in piu' e 32,3% di declassate |
| AI | 19 | 37 | 7 ❌ | 105′ ❌ | prima misura di `cambiInDeposito`: **1 su 33**. Risposta: (b) |
| **AL** | **19** | 42 | **5 ✓** | **15′ ✓** | rientro come alternativa (#459): 240,4 km a vuoto, 7 cambi in deposito, tetti NON rilassati, 2 violazioni BDS |
| AM | 20 | 43 | 5 ✓ | 15′ ✓ | pesi spinti su turni pochi e pieni: **nastro medio identico al minuto**, 367′ |
| AN | 24 | 43 | 5 ✓ | 15′ ✓ | banda a 7h15: nastro 367→376 (previsti 400-412), **previsione sbagliata** |
| AO | 22 | 42 | 5 ✓ | 15′ ✓ | trasferimento vero nelle coppie: **0 violazioni BDS**, nastro 379′, costo guida piu' basso della serie |

Nessun giro ha mai prodotto un mezzo fuori sagoma o un doppio declassamento.

**Correzione di un mio errore di lettura.** Avevo letto in `handoverModes` di AG «29 in auto, 3 a piedi, zero in deposito» e l'avevo presentata come la prova che il motore non faceva mai un cambio in deposito. Quel numero non puo' dire questo: `handoverModes` e `totalCambi` sono calcolati su `inline_handovers()` (`crew_scheduler_v3.py:1247`), che **scarta per costruzione** i cambi in deposito. Il numero vero e' `totalDepotChanges` (`crew_scheduler_v4.py:4720`), che **non era esposto da nessuna parte**: ne' dalla risposta compatta dell'api-server ne' dal cruscotto MCP. Per otto giri abbiamo giudicato alla cieca il numero che conta di piu'. Ora e' esposto in entrambi i punti.

Il difetto trovato e corretto con la #457 resta reale e dimostrato eseguendo il codice (il taglio in deposito fuori cluster nasceva a −5,1 e veniva cancellato da `filter_cuts_by_cluster`): e' la prova che era sbagliata, non la conclusione.

## Scenari salvati (Cerbero → Fucina)

| Giro | Scenario | Esito |
|---|---|---|
| W | `91060104-d307-4495-96f9-4e7b8edbad70` | 18 vetture, 40 turni, 0 suppl., 16.367 €, quadro non ancora corretto |
| X | `f23d4ecc-cf52-4f03-b3cd-c78993984578` | codici A001/A100 in linea, 361 corse (UDP non allineata), 16.355 € |
| **Y** | `239b91b3-39a4-4948-940d-09ce6952e3e2` | **365 corse, 18 vetture, 40 turni (35 interi, 5 semiunici, 0 spezzati, 0 suppl.), 196 km a vuoto, 153 giri naturali su 167, auto 5/5, incustodito ≤ 15′, 16.093 €** |

Segnalazioni residue nel giro Y: 2 turni interi senza sosta ≥ 15′ al capolinea; 12 proposte di rientro in linea; la sonda propone lo spostamento di una corsa di 15′ (da approvare).

## Quadro orario festivo: correzioni fatte

- 93: la corsa delle 20:02 su variante senza codice non è più festiva; nuova 93R 20:02 → 20:39; 93R 07:47 → 08:15 e 14:47 → 14:50.
- 30: nuova 30R 06:46 da Torrette.
- 3: nuove 3R 08:47 e 21:47; 3R 07:17 → 07:52.
- 2/6: 2/6R 07:44 → 08:04, 08:44 → 09:04, 21:54 → 22:04.
- 24: le 10 corse 24RD da xx:03 a xx:09.

Proposte non ancora approvate: 3R 20:47 (la 3A 20:20 arriva alle 20:42); 30A 21:12 (alimenta la 30R 21:46); sorte della 3R 08:17, rimasta senza andata dopo l'aggiunta della 08:47.

## Strumenti e flusso

- Giri: `ti_vcsp_run` (la UDP superata si riallinea da sola al lancio; la risposta porta `udpRefresh`) e `ti_vcsp_status` (sezione `kpi` predefinita, ~500 token; `summary`, `crew`, `probe`, `rounds` a richiesta). Il registro dei giri è sul database: gli esiti sopravvivono ai deploy, un giro interrotto da un riavvio si dichiara con la richiesta per rilanciarlo.
- Quadro: `ti_round_trip_audit` (anomalie di giro per linea e giorno-tipo), `ti_apply_plan_fixes` (lotto di spostamenti, generazioni e bollini in una chiamata, dopo il sì esplicito), `ti_line_timetable`, `ti_project_health` (controllo `round_trip_gaps`).
- Ogni scrittura sul piano richiede la descrizione dell'intervento e il sì esplicito dell'utente; gli spostamenti (`ti_shift_trip`) un secondo sì. Mai creare fermate.
- Deploy: TransitIntel al merge su `main`; Argos (Coolify) al push su `claude/argos-planner-engine-d3a387` (base delle PR: `claude/beautiful-faraday-8q8iis`). Il connettore Argos rilegge l'elenco dei tool solo alla riconnessione.

## Regole a basso consumo di token

1. Nessuna sorveglianza automatica delle PR e nessun check-in periodico: l'utente merge e avvisa.
2. Un giro per lotto di modifiche, mai durante un merge: il processo del solver muore col riavvio del container.
3. Una sola lettura per giro, con la sezione `kpi`; `crew` solo se richiesto.
4. Correzioni del quadro in un unico lotto con `ti_apply_plan_fixes`.
5. Nuova sessione per ogni nuovo filone di lavoro, partendo da questa nota.

## La catena completa del problema «autovetture» (diagnosi chiusa)

1. Il conducente puo' passare da un pezzo all'altro **senza auto** se il pezzo inizia con l'uscita del bus dal deposito o finisce col suo rientro: `seg_transfer_out` / `seg_transfer_back` (`crew_scheduler_v4.py:1138-1152`) azzerano il trasferimento in quel caso. **Il meccanismo c'e' gia'.**
2. Ma un pezzo puo' iniziare o finire in deposito **solo se il turno macchina ci passa** (`starts_at_depot` / `ends_at_depot`, `crew_scheduler_v4.py:1783-1854`).
3. E il VSP **evita** i passaggi in deposito, perche' li prezza come costo puro: `per_depot_return` 15 € piu' i km a vuoto (0,75-1,20 €/km).
4. Ma i km a vuoto sono **pagati 2,60 €/km** come quelli di linea. Un rientro in deposito non e' una perdita: e' compensato.

Quindi il motore fugge da una cosa che rende, i blocchi restano fuori tutto il giorno, i tagli dei turni guida cadono in linea, e serve un'auto per ogni cambio. **E' l'anello che chiude la diagnosi**: non manca il modello della mossa del deposito, manca il prezzo giusto dei km a vuoto.

Regole confermate dall'operatore (8 settembre):
- il rientro del bus in deposito a meta' turno e la successiva uscita sono **lavoro pagato normale, al 100%**;
- la **riserva** NON e' un riempitivo di buchi: si mette su un turno intero povero di corse per avere qualcuno **disponibile** a coprire il pezzo di un assente o a spostare vetture. E' una risorsa di scorta, non un pezzo di turno;
- la **codifica dei turni** resta la nostra (A + 3 cifre, 001-099 mattinali, 100-199 pomeridiani): il piano reale e' numerato alla vecchia maniera e non fa testo.

## Il quinto anello: il taglio in deposito era VIETATO (trovato col giro AG)

Il prezzo dei km a vuoto (#456) era necessario ma non sufficiente: i km a vuoto non si sono mossi (169,5 contro 171,2) e le auto sono rimaste 7 su 5. Il motivo e' a monte di ogni calcolo economico.

In `analyze_vehicle_block` (`crew_scheduler_v4.py`) ogni punto di taglio nasceva con:

    allows_cambio = cid is not None          # cid = cluster della fermata

e subito dopo `filter_cuts_by_cluster` (attiva per default, `cutOnlyAtClusters`) **cancellava** ogni candidato con `allows_cambio` falso. Il taglio al passaggio in deposito riceveva gia' il suo bonus (`CUT_DEPOT_BONUS + CUT_NO_CLUSTER_PENALTY`, cioe' l'intenzione dell'autore era chiara), ma se il capolinea da cui partiva il rientro non era in un cluster veniva **buttato via prima di poter competere**. Ad Ancona i rientri a meta' blocco partono da Montesicuro, Ospedale, Scataglini, Madonnetta: nessuno di questi e' un cluster. Da qui i cambi in deposito a zero.

Misurato sul banco (capolinea periferico fuori cluster): punteggio **−5,1 e cancellato** → **17,4 e ammesso**; il cambio che ne nasce e' `depot`/`depot`, trasferimento 0, **auto 0, incustodito 0**.

La correzione, in `analyze_vehicle_block`:
- `allows_cambio = cid is not None or is_depot_cut` — un passaggio in deposito e' per definizione un punto di cambio: chi smonta ci arriva **guidando** il bus, chi monta riparte **guidandolo** fuori;
- `transfer_cost = 0` al taglio in deposito (non c'e' nessun trasferimento da pagare);
- la penalita' radiale (`CUT_SAME_ROUTE_PENALTY`, fino a −22,5) non si applica: difende dal cambio al capolinea periferico, che costerebbe un'auto e lascerebbe il bus incustodito — al deposito non accade ne' l'una ne' l'altra cosa.

`compute_car_pool` e `seg_transfer_out`/`seg_transfer_back` erano gia' corretti: una volta che il pezzo ha un bordo in deposito, l'auto non viene piu' prenotata. Nessuna modifica li'.

## Il giro AH e la lettura onesta

Col taglio in deposito ammesso (#457) **le due regole rigide rientrano per la prima volta**: autovetture 5 su 5 con zero conflitti e zero turni senza auto, vettura incustodita 15′ esatti. Le violazioni BDS scendono da 6 a 1, i tetti percentuali sono rispettati **senza rilassamento** (era la prima volta), e la forma dei turni migliora molto: 34 interi, 5 semiunici, 1 spezzato, 1 supplemento, nastro medio 371′ contro 414′.

Ma il prezzo e' alto e va detto: **26 vetture invece di 19** (il piano umano ne usa 21), km a vuoto 214,4 contro 169,5, e soprattutto il declassamento esplode: **32,3%** contro il 17% di AG, con **5 pollicini** contro i 2-3 dichiarati dall'operatore e 8 catene spezzate. La 91 e' declassata all'83%, la 2/6 al 54%.

E c'e' una spiegazione piu' banale del merito della #457: la ripartizione dei blocchi passa da 17 LUNGO / 1 MEDIO / 0 CORTO a 11 LUNGO / 4 MEDIO / **10 CORTO**. Un blocco corto non ha bisogno di nessun taglio, quindi niente cambio e niente auto. Le auto possono essere rientrate cosi', non perche' i cambi siano passati in deposito. Senza `totalDepotChanges` non si distinguono i due casi — ed e' esattamente il motivo per cui va esposto.

## Il giro AI: la risposta e' (b), e la causa e' a monte di ogni prezzo

Primo giro con `cambiInDeposito` visibile: **1 cambio in deposito su 33** (32 in linea). AI e' tornato alla forma di AG — 19 vetture, 37 turni, blocchi 17 LUNGO / 1 MEDIO / **0 CORTO**, auto 7 su 5, incustodito 105′ — quindi la conformita' di AH veniva dallo spezzare i blocchi (10 CORTO), non dai cambi in deposito.

La #457 ha tolto il divieto, ma l'occasione quasi non esiste. Il motivo e' in `precompute_arc_costs` (`vehicle_scheduler_cpsat.py:928-980`): il passaggio in deposito fra due corse viene generato in **due soli casi, entrambi forzati**:

1. `dh_km >= DH_FORBIDDEN_KM` — il riposizionamento diretto e' vietato dall'archivio fuorilinea, il bus e' costretto a passare dal deposito;
2. `gap > rates.max_idle_at_terminal` — e quella soglia vale **240 minuti**.

Non c'e' un terzo ramo. Il motore non genera **mai** l'arco via deposito come *alternativa* a un collegamento diretto legale: quando il diretto esiste e la sosta sta sotto le quattro ore, l'opzione non entra nemmeno nel modello. Un bus puo' restare fermo a un capolinea fino a **quattro ore** prima che il motore consideri di mandarlo a casa — e in quelle ore serve un conducente che lo aspetti o un'autovettura che porti il cambio.

Questo spiega anche perche' la #456 non aveva mosso nulla: prezzare bene i km a vuoto non serve se la mossa non e' fra le alternative. Non era un problema di prezzo, era un problema di **arco mancante**.

**Fatto (soglia data dall'operatore: soste oltre 30 minuti).** L'arco via deposito ora entra fra le alternative e vince solo se costa meno dell'attesa. Perche' il confronto fosse onesto mancava una voce: la regola aziendale dice che la vettura non puo' restare sola piu' di 15 minuti, quindi ogni minuto oltre quel limite lo paga qualcuno — il conducente che resta col mezzo, o un'autovettura che porta il cambio. Senza quella voce un'attesa di tre ore costava 38 € di sosta contro i 72 € di nastro che consuma davvero, e tenere il bus fuori sembrava sempre conveniente.

Misura sul banco, con un rientro tipico di Ancona (10 km, 30′ di guida, 16,50 €):

| sosta | aspetta | in deposito | sceglie |
|---|---|---|---|
| 30′ | 8,61 € | 16,50 € | aspetta |
| 45′ | 18,81 € | 16,50 € | **deposito** |
| 90′ | 49,41 € | 16,50 € | **deposito** |
| 180′ | 110,61 € | 16,50 € | **deposito** |

Il punto di pareggio (~40-45′) **non e' fissato a mano: esce dalla distanza del deposito**. Un capolinea vicino manda il bus a casa prima, uno lontano lo tiene fuori piu' a lungo — la stessa regola da' risposte diverse dove la citta' e' diversa.

## Il giro AL: la catena si e' chiusa, e resta un solo problema

Tutti e cinque i criteri dichiarati PRIMA di vedere i numeri sono stati centrati:

| | previsto | AI | AL |
|---|---|---|---|
| km a vuoto | devono SALIRE | 163,1 | **240,4** |
| autovetture | devono SCENDERE | 7 su 5 ❌ | **5 su 5, 0 conflitti ✓** |
| incustodito | deve SCENDERE | 105′ ❌ | **15′ ✓** |
| cambi in deposito | devono SALIRE | 1 su 33 | **7 su 33** |
| nastro medio | non deve esplodere | 417′ | **367′** (sceso) |

`chosenOverDirect` = **8.254 soste convertite in rientri**: la mossa e' entrata nel modello e viene usata. 17 rientri in deposito nel giorno. Restano 19 vetture — **contro le 21 del piano umano** — con 2 sole violazioni BDS, i tetti percentuali rispettati **senza rilassamento**, 0 fuori sagoma, 0 doppi declassamenti, 1/4 a zero declassate, 153 giri naturali e nessuno saltato.

**Quello che manca e' uno solo, ed e' preciso.** I turni sono 42 contro i 38 del piano umano. Ma il nastro TOTALE e' praticamente identico a quello del giro AI:

- AI: 15.429 minuti su 37 turni (media 417′)
- AL: 15.414 minuti su 42 turni (media 367′)
- piano umano: 14.659 minuti su 38 turni (media **385,8′**)

Cioe': la correzione strutturale **non e' costata tempo pagato**, ha solo ridistribuito lo stesso lavoro su turni piu' corti. E i turni di AL sono meno pieni di quelli dell'operatore: 367′ contro 385,8′. Con la densita' del piano umano lo stesso lavoro starebbe in **40 turni**; al massimo di nastro consentito (435′) in **35,4**.

Non e' quindi un problema di struttura ma di **densita' dei turni**, e la prima leva da provare non e' codice: sono i pesi del solver guida (`crewWeights`: `minDrivers`, `preferIntero`, `minSupplementi`). Si prova prima di scrivere.

Resta fuori una regola: **4 pollicini contro il tetto di 3**. Il parametro `flotta` esiste su `ti_vcsp_run` ma questa sessione ha lo schema in cache e non puo' passarlo.

## Il giro AM e la banda del turno pieno

Esperimento sulle sole manopole (`crewWeights`: minDrivers 10, preferIntero 8, minSupplementi 9, qualityTarget 8), nessuna modifica al codice. I fattori sono stati applicati davvero (`weightFactors`: duty 1,25, suppl 2,25, spezz 1,31, quality 1,60) e i supplementi sono andati a zero. Ma:

**il nastro medio e' rimasto 367 minuti, identico ad AL al minuto.** I turni sono saliti a 43 e le vetture a 20.

E' la conferma pulita della diagnosi: i pesi non toccano la densita' dei turni, perche' il vincolo non sono i pesi.

In `cost_model` la banda entro cui un turno non costa nulla di extra nasce da `target_work_min`/`target_work_max`:

    target_mid = (390 + 402) / 2 = 396
    sopra target_mid + 12 = 408  ->  maggiorazione di straordinario
    sotto target_mid - 30 = 366  ->  costo di sottoutilizzo

Banda «gratis» = **[366, 408]**, cioe' lo straordinario partiva **27 minuti prima del tetto legale del turno intero**, che e' 435 (7h15) e fino a li' e' lavoro ordinario pagato al 100% — lo dice `SHIFT_RULES["intero"]`, lo conferma l'operatore, e il frontend aveva gia' `targetWork.high = 435`. L'anomalia stava solo nel modello di costo.

Il solver faceva l'unica cosa razionale: **parcheggiare ogni turno sul fondo della banda**. 367 minuti, un minuto sopra la soglia. Nella lista dei turni di AM si vede a occhio: una massa di interi da 165′, 190′, 198′, 208′, 226′, 262′... e solo una manciata sopra i 400′.

Sullo stesso lavoro (15.414 minuti di nastro misurati in AL):

| nastro medio | turni |
|---|---|
| 367′ (dove si posava) | 42,0 |
| 385,8′ (piano umano) | 40,0 |
| **412′ (nuova banda)** | **37,4** |
| 435′ (tetto legale) | 35,4 |

Corretto: `target_work_max` 402 → 435, `TARGET_WORK_MID` 408 → 412 (media di [390, 435]), cosi' le due definizioni di «turno pieno» che convivevano nel motore — 396 in `cost_model`, 408 in `optimizer_common` — smettono di divergere. Un test lega la banda al tetto di `SHIFT_RULES`.

## Il giro AN: la previsione era sbagliata, e l'errore era mio

Avevo dichiarato prima della misura: nastro medio da 367′ a 400-412′, turni da 42 a meno di 38. Misurato:

| | previsto | ottenuto |
|---|---|---|
| nastro medio | 400-412′ | **376′** (+9, il 20% dell'effetto atteso) |
| turni | < 38 | **43** (peggio di AL) |
| vetture | invariate (19) | **24** |
| costo guida | in calo | **+411 €** per lo stesso lavoro |

Le regole rigide hanno tenuto (auto 5 con zero conflitti, incustodito 15′, 1 sola violazione BDS, tetti non rilassati), ma il piano e' peggiore di AL sotto ogni altro aspetto.

**L'errore.** Le due soglie di costo del turno erano derivate ENTRAMBE dalla media della banda:

    target_mid = (min + max) / 2
    sottoutilizzo sotto  target_mid - 30
    straordinario sopra  target_mid + 12

Alzando il tetto da 402 a 435 la media e' passata da 396 a 412,5, e **il pavimento e' salito con lei da 366 a 382,5**. Cosi' ogni turno fra 366 e 382 minuti — perfettamente regolare — ha cominciato a pagare sottoutilizzo. Ho reso il piano piu' caro senza renderlo piu' denso.

**La correzione.** Le due soglie sono ora indipendenti e ancorate ai due estremi, non alla media:

- sottoutilizzo sotto `target_work_min - UNDERTIME_TOLERANCE` = 390 − 24 = **366**, dov'era prima;
- straordinario sopra `target_work_max` = **435**, il tetto legale: sotto quella soglia e' lavoro ordinario al 100%.

La media della banda resta usata solo come **bersaglio di forma** (dove un turno sta bene), che e' una cosa diversa dal dire quando si sconfina. Un test verifica che muovere un estremo non trascini l'altro.

**Cosa resta vero della diagnosi.** Che il solver si posava sul pavimento della banda e' un fatto misurato (367′ in AL, 367′ in AM col massimo dei pesi). Che bastasse alzare il tetto per riempire i turni, no: gli `unreachableDetails` di AN dicono che i pezzi non si uniscono per **stacco**, cioe' per come sono fatti i blocchi, non per quanto costano. La densita' e' un problema di struttura del turno macchina, non di prezzo.

**AL resta il piano di riferimento**: 19 vetture, 42 turni, tutte le regole rispettate tranne il tetto dei pollicini. Scenario `d2d6ea52-d27e-46ed-b143-01e2cbbdeed1`.

## Gli stacchi: la coppia usava una costante al posto del trasferimento vero

Dopo il giro AN la pista si e' spostata dal prezzo alla struttura, ed e' li' che si e' trovata una cosa concreta. In `_feasible_pair` — la funzione che decide se due pezzi possono stare nello stesso turno — l'overhead ai due bordi esterni era una **costante fissa**:

    nastro = (s2.end_min - s1.start_min)
             + pre_turno_for(DEPOT_TRANSFER_CENTRAL) + DEPOT_TRANSFER_CENTRAL * 2

cioe' sempre 25 minuti, comunque fossero fatti i pezzi. Ma il valore vero il motore lo conosce gia': `seg_transfer_out` e `seg_transfer_back` (`crew_scheduler_v4.py:1140-1155`) dicono che se il pezzo esce dal deposito guidando il bus, o ci rientra guidandolo, **il trasferimento e' zero**.

Effetto sull'arco massimo che un intero puo' coprire (tetto 435 minuti):

| bordi esterni della coppia | overhead | arco max |
|---|---|---|
| costante fissa (come prima) | 25′ | 410′ |
| **entrambi in deposito** | **12′** | **423′** |
| uno in deposito, uno a nodo centrale | 22′ | 413′ |
| nodo centrale su entrambi | 25′ | 410′ (invariato) |
| **nodo periferico su entrambi** | **35′** | **400′** |

La correzione va in **entrambe le direzioni**: libera 13 minuti dove i pezzi si appoggiano al deposito, e ne toglie 10 dove stanno su capolinea periferici, dove la costante era troppo generosa. Non e' un regalo al solver, e' il numero giusto.

**Nessuna previsione sull'esito del piano, questa volta.** Dopo il giro AN — dove avevo annunciato 400-412 minuti di nastro medio e ne sono arrivati 376 — la lezione e' che l'effetto di una correzione sul piano non si deduce dal meccanismo. Quello che si puo' dire con certezza e' solo cosa cambia meccanicamente: le coppie che si appoggiano al deposito ora hanno 13 minuti in piu' di respiro, quelle periferiche 10 in meno.

## Il giro AO, e perche' qui ci si ferma

| giro | vetture | turni | nastro medio | violazioni BDS | costo guida | punteggio |
|---|---|---|---|---|---|---|
| **AL** | **19** | 42 | 367′ | 2 | 15.089,61 | 29.793,29 |
| AM | 20 | 43 | 367′ | 1 | 15.252,46 | — |
| AN | 24 | 43 | 376′ | 1 | 15.500,01 | 30.622,66 |
| **AO** | 22 | 42 | **379′** | **0** | **14.818,77** | **29.475,47** |
| piano umano | 21 | 38 | 385,8′ | — | — | — |

AO e' il piano piu' pulito che il motore abbia prodotto: **zero violazioni BDS** (mai successo prima), tetti percentuali rispettati senza rilassamento, autovetture 5 con zero conflitti e nessun turno senza auto, incustodito 15′, nastro medio 379′ — il piu' vicino ai 385,8′ dell'operatore. Ha anche il **punteggio migliore** di tutta la serie e il costo guida piu' basso.

**Ma non batte AL sul criterio dell'operatore**, che sono le vetture: 22 contro 19, e sopra le 21 del piano umano. E i turni restano 42.

**Sei giri consecutivi (AG, AH, AI, AL, AM, AN, AO) non hanno migliorato AL sulle vetture.** Le correzioni fatte nel frattempo sono tutte difendibili una per una — erano difetti veri, dimostrati eseguendo il codice — ma la ricerca del piano migliore per tentativi successivi ha smesso di produrre. Continuare a girare le manopole senza una tesi nuova non e' un metodo: e' rumore pagato a mezz'ora per giro.

**Dove siamo davvero:**

- il piano da usare oggi resta **AL** (`d2d6ea52-d27e-46ed-b143-01e2cbbdeed1`): 19 vetture contro le 21 dell'operatore, tutte le regole rigide rispettate;
- se conta di piu' la pulizia normativa che il numero di vetture, **AO** (`4202f9b3-15a6-4253-8c76-0a81ac1586be`) e' l'alternativa: zero violazioni, ma 22 vetture;
- restano aperti gli stessi due punti di sempre: i turni guida (42 contro 38) e il tetto dei pollicini.

## Il mattone e' il GIRO, non la corsa (regole date dall'operatore, 9 settembre)

Fermata la ricerca per tentativi, l'operatore ha indicato la strada vera: il CP-SAT non arrivera' mai al risultato migliore se lavora sempre con gli stessi mattoni — vanno spostate delle corse. E ha dato i vincoli che governano lo spostamento:

1. **Le coincidenze fra linee**: 2/6 ↔ 21/33 alla **Madonnetta**, 3 ↔ 21/33 a **Posatora**, 44 / 43 / 1/4 a **Tavernelle**; piu' quelle dei treni e dei cluster principali.
2. **Andata e ritorno sono legati.** La sosta al capolinea periferico e' un cuscinetto stretto per assorbire i ritardi: se si slitta avanti l'andata bisogna slittare avanti anche il ritorno, e slittare il solo ritorno allunga la sosta.
3. **La cadenza nel festivo non vincola**: con una corsa all'ora, spostarne una di 15 minuti non fa danno.

**Il primo era un difetto, non una funzione mancante.** La sonda con `scope: "trip"` spostava UNA corsa sola — l'ultima del primo pezzo o la prima del secondo — e quindi rompeva la coppia andata-ritorno esattamente come l'operatore dice di non fare. L'altro modo che aveva, `scope: "line"`, sposta tutte le corse della linea per l'intera giornata: non rompe le coppie ma e' un randello.

E i giri il motore li conosceva gia': `compute_natural_turnarounds` (`vehicle_scheduler_cpsat.py:661`) accoppia ogni arrivo a un capolinea periferico con la prima corsa della stessa linea in direzione opposta entro 30 minuti — nell'ultimo giro **153 coppie su 167 arrivi periferici**. La sonda semplicemente non le guardava.

Corretto: `build_round_trip_pairs` replica quella regola sui dati della sonda, `expand_to_round_trips` fa slittare andata e ritorno **dello stesso delta** (la sosta al capolinea resta identica al minuto, per costruzione) e `flex_of_round_trip` prende la flessibilita' **piu' stretta delle due** corse. Un'andata senza ritorno accoppiato resta muovibile da sola: li' la sosta non c'e'.

**Il punto 1, le coincidenze fra linee, non e' stato dichiarato: e' stato reso RICONOSCIBILE.** L'attesa massima di un passeggero in coincidenza e' 5 minuti (dato dall'operatore). Quindi: se a un nodo l'arrivo della linea A e' seguito dalla partenza della linea B entro 5 minuti, e questo succede almeno 3 volte nella giornata, quella e' una coincidenza — non un incontro casuale — e nessuno spostamento deve romperla.

Riconoscerle invece di dichiararle vale due volte: non c'e' un elenco da inseguire a ogni cambio d'orario, e la regola funziona anche su una rete che non e' quella per cui e' stata scritta. Le tre che l'operatore ha nominato — 2/6 ↔ 21/33 alla Madonnetta, 3 ↔ 21/33 a Posatora, 44/43/1/4 a Tavernelle — sono nell'orario, quindi il motore le trova da solo.

Il riconoscimento guarda solo **capolinea contro capolinea** (chi arriva termina li', chi parte comincia li'), non il transito: e' cio' che tiene fuori il traffico di passaggio dei nodi centrali. La verifica avviene PRIMA del re-solve: scartare li' costa nulla, scoprirlo dopo costa un minuto di solver per un candidato che l'operatore rifiuterebbe comunque. E il giro spostato rigidamente non rompe niente per costruzione: se le due corse slittano dello stesso delta, l'attesa non cambia.

Il rendiconto della sonda ora riporta le coincidenze riconosciute e quanti candidati sono stati scartati per non romperle.

## Dove sta lo spreco, misurato sul giro AO

I 31 turni interi hanno, sotto il tetto di 7h15, **53,6 ore di capienza libera: 7,4 turni pieni di spazio vuoto**. I due supplementi da soli sono 276 minuti di nastro per **6 corse in tutto**.

La sonda di oggi non puo' toccarli, per tre limiti tutti verificabili nel codice:

1. guarda **solo i turni biripresa** (`find_crew_probe_candidates` scarta chi non e' semiunico o spezzato): nel giro AO sono 11 su 42, e i 31 interi dove sta la capienza non li vede mai;
2. prova **una mossa sola** — stringere lo stacco di una biripresa per farne un intero — e non chiede mai «se sposto questa corsa, un altro turno riesce ad assorbirla?»;
3. tetto di **30 minuti** per corsa: nel giro AN gli spostamenti necessari erano 77, 115, 133, 151, 182, 195, 276 minuti, tutti scartati prima di essere provati.

La flessibilita' non manca: il motore riporta `flexTrips: 365`, cioe' tutte le corse ne hanno.

**La sonda del turno povero** e' il pezzo che segue: parte dai turni con piu' margine, e per ogni loro corsa chiede quale spostamento permetterebbe a un turno vicino di assorbirla. Se tutte le corse di un turno trovano casa, quel turno si cancella — ed e' un turno intero risparmiato, non un ritocco. E' il quarto passo del metodo dell'operatore, quello che il motore oggi non fa.

## Il giro AP: i mattoni si muovono, e sotto c'era un difetto piu' grosso

**I due meccanismi nuovi funzionano**, e si vedono nel rendiconto della sonda:

- *giro rigido*: fra i candidati provati ce n'e' uno che sposta la linea 3 variante **3A di +10′** (13:50) e la **3R di +10′** (14:17) — andata e ritorno, stesso delta, insieme. Prima ne avrebbe mossa una sola;
- *coincidenze*: un candidato scartato con la motivazione «rompe una coincidenza: **7 → 2/6, attesa −13′**», cioe' la 2/6 sarebbe partita tredici minuti prima che arrivasse la 7. Scartato **prima** del re-solve. E non e' una delle tre nominate dall'operatore: e' una dei cluster principali, trovata da sola;
- lo spostamento accettato (C.S. +15′) e' una corsa singola, ed e' corretto: la Circolare parte e torna a Piazza Cavour, non ha un capolinea periferico dove la sosta conti.

**Il piano pero' peggiora AL**: 26 vetture, 43 turni, 3 violazioni BDS. Ottavo giro senza migliorare il riferimento.

### Ma i round dicono perche'

| round | vetture | turni | violazioni BDS | punteggio |
|---|---|---|---|---|
| 2 | **20** | 43 | **0** | 30.142,67 |
| 6 | 26 | 43 | 3 | **29.931,57** ← scelto |

Il motore ha **scartato un piano da 20 vetture e zero violazioni** per uno da 26 vetture e tre violazioni, per 211 € di punteggio. Il conto: le tre violazioni gli costano **300 €** (`VIOLATION_SHADOW_EUR = 100` l'una), le sei vetture in piu' gliene fanno **risparmiare 526**.

Non e' che il solver non trovi il piano buono: **lo trova e poi lo butta.**

E' un errore di principio, non di taratura. Il tetto delle autovetture l'operatore lo ha definito «inviolabile», la normativa sui turni e' legge: prezzarle le rendeva **acquistabili**. Un piano che rompe una regola non e' un piano peggiore — non e' un piano.

**Corretto: la selezione fra round e' ora lessicografica** (`_round_rank`): prima chi rompe meno regole, poi il punteggio. Vale anche per l'early-stop e per lo scenario della sonda, che prima diventava il migliore «per costruzione» e ora resta consultabile senza vincere se ha introdotto una violazione.

### Il declassamento, ridimensionato

Il sospetto che il modello premiasse le vetture piccole e' **confermato ma marginale**. Declassare da 12 a 10 metri fa risparmiare 0,20 €/km, e la penalita' in morbida (0,05 €/min) equivale a circa 0,165 €/km: declassare rende, ma solo del ~20%. In punta la penalita' e' cinque volte il risparmio e regge.

Solo che l'operatore ha detto «intorno al 28% ci siamo», e i giri stanno al 30-34%: siamo **poco sopra la sua tolleranza**, non fuori strada. Il problema vero non e' la percentuale complessiva ma **i pollicini**, 4-5 contro un massimo di 3 — e quello e' un tetto rigido, come le autovetture, quindi va imposto e non prezzato. Serve il parametro `flotta`, che il cruscotto MCP ancora non espone.

I due campi della sonda (`coincidences`, `rejectedForCoincidence`) non uscivano dall'api-server: esposti, stesso problema di `totalDepotChanges`.

## Il giro AQ e' morto per un mio errore

Il giro si e' interrotto al round 1 con `IndexError: list index out of range`. Nella correzione della selezione lessicografica avevo spostato il calcolo del confronto **sopra** il controllo sulla lunghezza della lista:

    _prev, _cur = _round_rank(rounds_kpi[-2]), _round_rank(rounds_kpi[-1])
    if len(rounds_kpi) >= 2 and (...):

Il codice originale aveva il controllo dentro la stessa `if`, che in Python cortocircuita: `len(...) >= 2` veniva valutato per primo e proteggeva l'accesso. Hoistando il calcolo ho tolto quella protezione, e al primo round `rounds_kpi[-2]` non esiste.

Nessun test lo copriva perche' la logica era **inline dentro `main()`**, dove un test non arriva. Ora e' estratta in `_round_without_gain`, e due test la coprono: il primo round che non deve esplodere, e l'ordine (una violazione in meno e' un miglioramento anche se il punteggio peggiora).

E' il secondo errore della serie dello stesso tipo — dopo la banda del turno pieno, dove alzare il tetto aveva alzato anche il pavimento. Entrambi nascono dal toccare un'espressione senza rieseguire il pezzo che la contiene.

## Il giro AQ2: il miglior piano VALIDO della serie

| giro | vetture | turni | violazioni | auto (picco/tetto) |
|---|---|---|---|---|
| AL | 19 | 42 | **2** | 5/5 |
| AO | 22 | 42 | 0 | 5/5 |
| AP | 26 | 43 | **3** | 5/5 |
| **AQ2** | **21** | 43 | **0** | **4/5** |

Scenario `366e03ad-7f1e-4a3e-bfa7-c853397fffd3`. **Zero violazioni BDS**, zero supplementi, tetti percentuali rispettati senza rilassamento, autovetture con margine (picco 4 su 5, zero conflitti, nessun turno scoperto), vettura incustodita 15′. 31 interi, 6 semiunici, 6 spezzati; nastro medio 374′; 29 cambi in linea e 5 in deposito.

E' il **miglior piano a zero violazioni** finora: batte AO (22 vetture) sulle vetture a parita' di pulizia. AL resta piu' basso sulle vetture (19) ma ha 2 violazioni: col principio nuovo non e' un piano migliore, e' un piano non valido.

**Onesta' sulla verifica.** La selezione lessicografica **non e' stata messa alla prova**: il round scelto (il 4) aveva insieme zero violazioni E il punteggio migliore, quindi avrebbe vinto anche con la regola vecchia. La correzione non ha rotto niente e il risultato e' buono, ma il caso che avrebbe dimostrato la differenza — un round sporco con punteggio migliore — qui non si e' presentato.

## Le coincidenze riconosciute non sono quelle attese, ed e' un'informazione

Quattro relazioni, tutte con 10-12 occorrenze — sistematiche, non rumore:

| nodo | da | a | occorrenze |
|---|---|---|---|
| OSPEDALE REGIONALE | 31 | 30 | 12 |
| PIAZZA CAVOUR | 7 | 2/6 | 12 |
| PIAZZA U.BASSI | 31 | 42 | 12 |
| PIAZZA U.BASSI | 31 | 24 | 10 |

La calibratura e' giusta: quattro, non decine. Ma **nessuna delle tre nominate dall'operatore** (2/6 ↔ 21/33 alla Madonnetta, 3 ↔ 21/33 a Posatora, 44/43/1/4 a Tavernelle) e' fra queste.

~~Guardando i dati del progetto se ne capisce il perche': la 21/33 fa Posatora ↔ Montesicuro e non tocca affatto la Madonnetta.~~ **Sbagliato, e l'operatore l'ha corretto**: la 21/33 la Madonnetta la tocca eccome, ma **in transito**, e leggendo solo la prima e l'ultima fermata di ogni corsa quel passaggio era invisibile. Vedi la sezione seguente: i passaggi intermedi lo dicono chiaramente.

## Il vincolo morde troppo, e si vede

**14 candidati scartati su 15**, e la sonda non ha accettato niente. Le motivazioni sono tutte legittime — attese che scendono a −13′ e −8′ (il mezzo parte prima che arrivi chi deve salirci) o salgono a 18-20′ (coincidenza persa) — ma l'effetto e' che la sonda e' di fatto ferma.

La causa e' strutturale: **le corse al confine dei pezzi di turno sono proprio quelle che portano le coincidenze**, perche' i cambi avvengono ai nodi dove le linee si incontrano. La strategia della sonda e il vincolo si scontrano per costruzione.

**Il pezzo successivo e' la propagazione**: quando uno spostamento romperebbe una coincidenza, provare a spostare **anche la corsa in coincidenza** dello stesso delta, invece di scartare. E' lo stesso principio del giro rigido — muovere insieme le cose che sono legate — applicato al legame fra linee invece che fra andata e ritorno.


## Il quadro festivo alla mano: dove le coincidenze ci sono e dove no

Verifica sui dati veri del progetto (`ti_line_timetable` con i passaggi intermedi, quadro festivo del 20/09).

**Posatora.** L'operatore ha ragione: e' capolinea di partenza *e* di arrivo per tutte e due le linee. La 21/33 parte da POSATORA CAPOLINEA (08:02, 12:32, 17:02, 19:32) e ci torna (09:28, 13:57, 18:27, 20:57) — l'headsign «Piazza Ugo Bassi» del ritorno e' solo l'etichetta della variante, la domenica il servizio finisce a Posatora. Quindi il motore guardava nel posto giusto. **Non trova niente perche' li' la coincidenza, in questo orario, non c'e':**

| relazione | attese nella giornata |
|---|---|
| la 3 arriva → la 21/33 parte | 12′, 20′, 20′, 20′ |
| la 21/33 arriva → la 3 parte | 19′, 20′, 20′, 20′ |

La 3 ha cadenza 30′ e la 21/33 cade sistematicamente a meta' dell'intervallo. Soglia dell'operatore: 5 minuti.

**Madonnetta.** Qui il difetto era reale. La 2/6 ha il capolinea (variante `2/6A`, 26 corse); la 21/33 ci **transita** tre minuti dopo essere partita da Posatora. Le attese sono **5 minuti esatti su tutte e quattro le corse** (2/6 arriva 08:00 → 21/33 transita 08:05; 12:30→12:35; 17:00→17:05; 19:30→19:35). Non e' un caso: e' una coincidenza costruita a mano dal pianificatore, e il motore non la vedeva. Il pericolo non era perdere un'occasione, era **romperla senza accorgersene**.

**E le due sono in conflitto.** Spostando rigidamente il giro della 21/33 di +15′ si creano 7 coincidenze a Posatora ma si distruggono le 4 della Madonnetta; a δ = 0 si hanno solo quelle della Madonnetta. Nessun δ le tiene insieme: per guadagnare a Posatora bisognerebbe muovere anche la linea 3. E' la conferma sul campo di cio' che l'operatore chiede al sistema — finche' si muove un mattone solo si vince da una parte e si perde dall'altra.

## Cosa e' stato messo nel motore

1. **I transiti contano.** `loadTerminalTransits` porta nel payload della sonda i passaggi di ogni corsa **sui capolinea altrui** (solo quelli: gli altri transiti sono il corridoio che due linee percorrono insieme, decine di incontri e nessuna coincidenza). `detect_coincidences` li usa in tutti e due i versi, con una regola contro il rumore: **almeno un lato dev'essere un capolinea**. Gli orari che realizzano la coincidenza viaggiano con la coppia, cosi' il conto dell'attesa e' giusto sia al capolinea sia in transito.
2. **La propagazione.** `propagate_for_coincidences`: quando uno spostamento romperebbe una coincidenza, invece di scartarlo si prova a portarsi dietro la corsa in coincidenza dello stesso δ — e ogni corsa trascinata si porta dietro il suo giro. La catena si ferma davanti a tre muri: una corsa che non regge quel δ, una corsa a cui la catena chiederebbe due δ diversi, e il tetto di 12 corse coinvolte. In quei casi si scarta come prima: le regole non si comprano.

Nel rendiconto della sonda c'e' ora `propagatedForCoincidence` accanto a `rejectedForCoincidence`: quanti candidati si sono portati dietro il vicino invece di morire.

## Il giro AR: le coincidenze si vedono, il piano no

Scenario `7a46cc61-18fd-4ade-b2bf-4356e1bd9397`, stessi parametri di AQ2, 45 minuti.

**Le coincidenze riconosciute passano da 4 a 11.** Ci sono le due che l'operatore aveva nominato, e nessuna delle due si vedeva prima:

| nodo | da → a | occorrenze | perche' era invisibile |
|---|---|---|---|
| MADONNETTA | 2/6 → 21/33 | 4 | la 21/33 **transita**, non si ferma |
| MADONNETTA | 21/33 → 2/6 | 3 | idem (**da verificare**, vedi sotto) |
| POSATORA | 31 → 3 | 12 | la **31 transita** a Posatora |
| POSATORA | 3 → 31 | 11 | idem |
| PIAZZA CAVOUR | 11 → 2/6, 11 → 1/4, 2/6 → 11 | 4, 3, 3 | la 11 transita |

A Posatora la coincidenza **c'e'**, ma non e' quella cercata: la fa la **31**, non la 21/33. La lettura di ieri (attese di 12-20 minuti fra 3 e 21/33) resta vera per quella coppia, ma il nodo non era vuoto — era la linea sbagliata.

**Un numero da verificare.** Il verso MADONNETTA 21/33 → 2/6 (×3) non torna col conto a mano: il 21/33 transita alla Madonnetta al ritorno alle 09:25, 13:54, 18:24, 20:54 e la 2/6R parte ai minuti :04 e :34, quindi le attese sarebbero 39, 10, 10, 10 — tutte oltre i 5 minuti. O i dati materializzati differiscono dal quadro letto con `ti_line_timetable`, o c'e' un rumore nel riconoscimento. Il verso opposto (2/6 → 21/33, ×4) corrisponde invece al minuto.

**La propagazione ha lavorato**: 6 candidati scartati per coincidenza, **2 salvati** portandosi dietro il vicino (`propagatedForCoincidence`). In AQ2 erano 14 scartati su 15 e nessuno salvato. Ma i 2 salvati sono poi stati bocciati dal punteggio: la sonda ha accettato **zero** spostamenti anche stavolta.

**Il piano e' peggiore di AQ2, e ~~e' varianza del solver~~ NO: erano parametri diversi.**

| giro | rounds | probes | crewTimeLimit | vetture | turni | violazioni |
|---|---|---|---|---|---|---|
| AQ2 | **5** | 6 | **240** | 21 | 43 | 0 |
| AR | 3 | 10 | 600 | 29 | 43 | 2 |
| AS | 3 | 10 | 600 | 30 | 41 | 2 |

Avevo scritto che la differenza fra 21 e 29 vetture era varianza del solver. **Non lo e'**: ho lanciato AR con i parametri «di riferimento» annotati in testa a questo documento invece che con quelli effettivi di AQ2, e non li ho verificati prima di concludere. AQ2 girava con **5 round** (ecco perche' il round scelto era «il 4»), 6 sonde e 240 secondi di CSP.

La prova sta nel giro AS, ripetizione esatta di AR: i round si somigliano al punto che il primo e' identico (25 vetture, 43 turni, 4 violazioni in tutti e due), il secondo da' 29 e 30 vetture con 2 violazioni in tutti e due, e in tutti e due vince il round 2. **La varianza del motore e' piccola: e' riproducibile.** Il confronto AQ2 ↔ AR non lo era.

**La selezione lessicografica e' stata messa alla prova per la prima volta.** In AQ2 il round vincente aveva insieme zero violazioni e il punteggio migliore, quindi la regola non serviva. Qui no:

| round | vetture | violazioni | punteggio |
|---|---|---|---|
| 1 | 25 | 4 | 29.769 |
| **2 (scelto)** | **29** | **2** | 30.305 |
| 3 | 24 | 5 | 30.475 |

Ha scelto il round 2, con **il punteggio peggiore** del round 1 ma meta' delle violazioni. Col metro vecchio avrebbe vinto il round 1, con 4 violazioni. La regola funziona.

## Il giro AT: il confronto giusto, e un difetto piu' grosso di quello che cercavo

Scenario `9cb0f5f7-e0b4-4bff-8ccd-defe41c454f6`, parametri VERI di AQ2 (5 round, 6 sonde, CSP 240s) col codice nuovo. 28 minuti.

| round | vetture | turni | suppl | violazioni | punteggio |
|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 5 | 29.820 |
| 2 | 30 | 45 | 2 | 5 | 31.770 |
| 3 | **22** | 43 | **0** | 2 | 29.742 |
| **4 (scelto)** | **30** | 43 | **8** | **1** | 30.296 |
| 5 | **21** | 44 | 1 | **1** | 30.662 |

Il codice nuovo **non ha rotto niente**: con cinque round il motore trova di nuovo i piani a 21-22 vetture che AQ2 aveva trovato (round 3 e 5). Le undici coincidenze sono le stesse identiche di AR e AS — il riconoscimento e' stabile fra i giri.

**Ma la scelta fra i round e' sbagliata, e si vede a occhio nudo.** I round 4 e 5 hanno tutti e due **una** violazione, quindi la regola lessicografica passa al punteggio e vince il 4 per 366 €. Solo che il round 4 ha **30 vetture e 8 supplementi**, il round 5 ne ha **21 e 1**. Nove autobus in piu' e sette supplementi in piu', comprati per 366 €.

La causa e' nel punteggio, ed e' doppia:

1. **Il mezzo in piu' non costa quasi niente.** `vehicleCostEur` e' un costo di esercizio (km e ore): fra 30 vetture e 21 ci sono **110 €** di differenza (6.534 contro 6.423). Ma una vettura in piu' e' un autobus in piu' da possedere, assicurare e tenere in officina — un costo di capitale che nel punteggio non compare.
2. **Il supplemento pesa come un turno pieno.** `DUTY_SHADOW_EUR` vale 200 € per qualunque turno; nel CSP invece l'operatore mette `minSupplementi: 10`, cioe' il massimo. Quello che il solver dei turni evita, la selezione fra round se lo ricompra.

Messe tutte e due (`VEHICLE_SHADOW_EUR = 80`, `SUPPLEMENT_SHADOW_EUR = 100` che si somma all'ombra del turno; override da `vcsp.vehicleShadowEur` / `vcsp.supplementShadowEur`). Sui numeri veri del giro AT il round 5 passa a 32.442 e il round 4 a 33.496: **vince il piano da 21 vetture** con un margine di mille euro invece di perdere per 366.

Gli 80 € sono il costo di POSSESSO di un autobus per un giorno — ammortamento di un 12 metri su quindici anni piu' assicurazione, bollo e manutenzione fissa — non i km. **Da confermare con l'operatore**: se il valore aziendale e' diverso si cambia una costante, e la direzione della scelta non cambia finche' resta sopra i ~40 € (sotto quella soglia i 366 € del punteggio tornano a comandare).

**La sonda in AT.** Due candidati, tutti e due `head+` sulla 1/4 con il giro rigido al lavoro (andata e ritorno insieme, δ 2 e 4 minuti); nessuno toccava una coincidenza (`rejectedForCoincidence: 0`), nessuno accettato — uno bocciato dal VSP, l'altro dal punteggio. La sonda guidata dai turni non ha prodotto **nessun** candidato: le sette bi-riprese sono tutte irraggiungibili, con δ da 24 a 190 minuti o col nastro gia' pieno.

## Gli strumenti nuovi (9 settembre)

Fino a oggi per sapere qualcosa del quadro bisognava lanciare un giro da 45 minuti e leggere il rendiconto della sonda: ogni domanda costava un giro, e la risposta arrivava a piano gia' fatto. Da qui il «girare attorno» che l'operatore ha fatto notare. Questi strumenti rispondono in secondi e PRIMA di girare.

| strumento | dove | cosa risponde |
|---|---|---|
| `ti_coincidences` | argos + endpoint TI | quali coincidenze fa l'orario (capolinea **e transiti**), quali perde per poco, e la traslazione di linea che le prende — col conto di quelle che rompe |
| `ti_vcsp_compare` | argos (solo connettore) | due giri fianco a fianco sui cinque criteri, **con l'avviso se i parametri non coincidono** |
| sonda «coincidenza» | `vcsp_probe.py` | candidati che nascono dal SERVIZIO (sposta la linea intera) e non dal piano |

**La regola nuova all'accettazione**: a parita' di punteggio decide il servizio. Una coincidenza in euro non compare da nessuna parte, quindi un candidato che ne crea e non costa di piu' veniva rifiutato per pareggio. Non ha un prezzo — non compra un peggioramento — ma rompe la parita'.

**Numeri scelti da Argos, da confermare con l'operatore:**

- `VEHICLE_SHADOW_EUR = 80` — un autobus in servizio per un giorno (ammortamento di un 12 metri su quindici anni piu' assicurazione, bollo, manutenzione fissa). Sotto i ~40 € la scelta fra i round si ribalta.
- `SUPPLEMENT_SHADOW_EUR = 100` — si somma all'ombra del turno.
- `COINCIDENCE_MIN_WAIT = 2` (solo in `coincidence_analysis`) — l'attesa minima perche' il cambio sia fattibile. Il vincolo del VCSP accetta ancora da zero in su: cambiarlo cambierebbe le coincidenze da difendere, e non e' una decisione dell'agente.

**Prima prova sui dati veri** (festivo, ristretto a 3, 2/6 e 21/33): la **3** anticipata di 12′ crea due relazioni — venticinque corse in coincidenza — senza romperne nessuna; la **2/6** spostata di 3′ ne crea due; la **21/33** di −3′ una. Sull'intera rete (17 linee) non e' ancora stata letta.

## La trappola del merge a meta', due volte in due giorni

La PR #470 e' stata mergiata al commit `573101b`, lasciando fuori la mappa delle coincidenze e la sonda che la usa — mentre `ti_coincidences` era gia' in produzione su argos e chiamava un endpoint inesistente. Rifatti sopra `main` nella #471. Era gia' successo con la #460 il giorno prima.

**Regola**: dopo ogni merge, verificare con `git merge-base --is-ancestor <ultimo commit> origin/main` che ci sia dentro tutto, non solo che il branch sia allineato.

## Il giro AU: la sonda muove per la prima volta, e il dubbio della Madonnetta era mio

Scenario `29f79738-e8d6-483e-a2f5-74dc66e11013`, parametri veri di AQ2 (5 round, 6 sonde, CSP 240s) col codice nuovo. 42 minuti.

| round | vetture | turni | suppl | violazioni | punteggio |
|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 4 | 31.769 |
| 3 | 21 | 43 | 0 | 2 | 31.997 |
| 4 | 24 | 44 | 1 | 2 | 32.402 |
| 5 | 22 | 43 | 3 | 9 | 33.019 |
| **6 — LA SONDA (scelto)** | **21** | **43** | **0** | **1** | **31.932** |

**Il round vincente e' quello della sonda.** Ha preso il round 3 (21 vetture, 2 violazioni), ha spostato **una corsa** — la 30R delle 21:46 alle 21:31 — e ha tolto una violazione BDS. E' il **primo spostamento accettato di tutta la serie**: da AL in poi la sonda non aveva mai mosso niente.

E le ombre nuove si vedono nel confronto a parita' di parametri:

| giro | vetture | turni | suppl | violazioni |
|---|---|---|---|---|
| AT (prima delle ombre) | 30 | 43 | **8** | 1 |
| **AU (dopo)** | **21** | 43 | **0** | 1 |

Nove autobus e otto supplementi in meno, come il test prometteva.

### Il dubbio della Madonnetta: nessun difetto, l'errore era mio

Il campione degli orari — messo apposta per questo — l'ha chiuso in un colpo:

```
MADONNETTA  2/6 → 21/33   arrivo 12:30 → transito 12:34   attesa 4'
MADONNETTA  21/33 → 2/6   transito 12:34 → partenza 12:34  attesa 0'
```

Avevo sbagliato due volte. Primo: avevo assunto che il 21/33 transitasse alla Madonnetta a «partenza + 3» per tutte le corse, verificandolo su una sola — il profilo varia, e alle 12:32 il transito e' alle **12:34**, non alle 12:35. Secondo: cercavo il verso 21/33 → 2/6 negli arrivi del RITORNO (09:28, 13:57...), mentre lo realizza l'**andata** che transita alle 12:34, 17:04, 19:34, contro le partenze della 2/6R ai minuti :04 e :34.

### Ma ha scoperto una cosa vera: si difendono coincidenze da zero minuti

Quelle tre coppie hanno **attesa 0**: il 21/33 passa alle 12:34 e la 2/6 parte alle 12:34, nello stesso minuto. Nessun passeggero fa quel cambio, eppure il vincolo lo difende e per proteggerlo scarta gli spostamenti.

Nel campione delle undici relazioni e' **l'unica** sotto i due minuti; le altre stanno fra 2 e 5. **Deciso dall'operatore: la soglia vale ora anche nel vincolo** (`COINCIDENCE_MIN_WAIT = 2` in `vcsp_probe`, da cui `coincidence_analysis` la importa — analisi e motore devono riconoscere le stesse coincidenze, o l'una proporrebbe cio' che l'altro rifiuta). Un cambio sotto i due minuti non si difende piu', e uno spostamento che porta l'attesa sotto la soglia adesso ROMPE la coincidenza invece di sembrare innocuo.

### La mappa ha lavorato

La sonda ha generato **sei candidati «coincidenza»** — traslazioni di linea nate dal quadro e non dal piano, la cosa che prima non sapeva fare. Tutti e sei bloccati dal vincolo, e ora si sa perche': `flessibilitaInsufficiente` 8 volte, `catenaTroppoLunga` 6. I freni sono quelli: la flessibilita' dichiarata sulle corse da trascinare e il tetto di dodici corse per catena.

## Il giro AV: la soglia fa il suo lavoro, l'early-stop taglia il giro

Scenario `d1151448-f83d-4a6a-80c4-a90fc69cbdb8`, stessi parametri di AU. 19 minuti.

**La soglia ha fatto esattamente cio' che doveva.** Le coincidenze riconosciute passano da 11 a **10**: e' sparita solo `MADONNETTA 21/33 → 2/6`, quella con attesa zero. Le altre dieci sono intatte, e il rendiconto porta ora `minWaitMin: 2` accanto a `maxWaitMin: 5`.

**E per la prima volta due traslazioni di linea sono arrivate al re-solve**, invece di morire nel guard:

| candidato | corse spostate | esito |
|---|---|---|
| C.S. δ +14′ | **12** (tutta la linea, 09:04→20:04) | bocciato dal VSP |
| 21/33 δ −2′ | **8** (andata e ritorno) | bocciato dal punteggio (+330 €) |

E' la catena completa che funziona: la mappa trova l'occasione, la sonda la prova col solver in mano, il costo decide. Nessuna delle due conveniva — ma ora si sa, invece di non chiederselo.

**Il piano finale pero' e' peggiore di AU** (25 vetture e 4 violazioni contro 21 e 1), **e non per colpa della soglia**: il giro si e' fermato a **3 round su 5** per early-stop, e ha scelto il migliore fra quei tre. In AU i round buoni erano il terzo (21 vetture, 2 violazioni) e il sesto della sonda; qui il terzo aveva 6 violazioni e il giro e' finito li'.

| giro | round eseguiti | best | vetture | violazioni |
|---|---|---|---|---|
| AU | 6 (5 + sonda) | 6 | 21 | 1 |
| AV | **3** (early-stop) | 1 | 25 | 4 |

**Due giri con un numero di round diverso non sono confrontabili** — la lezione di ieri, applicata a me stesso. Il rendiconto porta ora `earlyStop` con round raggiunto, round chiesti e pazienza: prima bisognava dedurlo dal confronto fra `roundsExecuted` e i round chiesti.

**La domanda aperta e' la pazienza dell'early-stop** (`EARLY_STOP_PATIENCE = 2`). I round del VCSP oscillano per costruzione — i costi-ombra spostano il problema a ogni giro — quindi due peggioramenti di fila non vogliono dire convergenza: in AU il quarto e il quinto round sono stati peggiori del terzo, ma il giro e' arrivato in fondo perche' un reset era caduto in mezzo. Alzare la pazienza a 3 e' una manopola da tarare con i dati, non da indovinare: serve un giro con la stessa base e pazienza diversa.

## Il prossimo intervento (superato dal precedente)

**Il prezzo dei km a vuoto nel VSP.** Vedi la catena qui sopra: la mossa del deposito e' gia' implementata e gratuita, ma non viene mai usata perche' il VSP evita i passaggi in deposito. Vanno prezzati al NETTO del corrispettivo (2,60 €/km incassati contro 0,75-1,20 di costo), tenendo come costo vero il tempo del conducente (27 €/ora), che e' l'unica cosa che si spende davvero. Attenzione a non ribaltare l'incentivo: se i km a vuoto diventano profitto il solver ne inventerebbe, e il freno deve restare il tempo pagato.

Togliendo questa causa si possono togliere anche le due medicine messe nella notte del 7-8 settembre, che rendono l'auto cara invece di renderla inutile:

- la maggiorazione di scarsita' `company_car_scarcity_eur` (20 €, PR #454);
- l'escalation delle penalita' sui giunti (×2,5 fino a ×8, PR #453).

## In sospeso

- Ruotare la chiave di scrittura MCP (`MCP_WRITE_KEY`) a fine giornata: mai incollarla in chat.
- Decidere sulle tre proposte del quadro (3R 20:47, 30A 21:12, 3R 08:17) e sullo spostamento di 15′ proposto dalla sonda del giro Y.
- Leggere l'audit festivo completo con `ti_round_trip_audit` (dalla salute: 16 anomalie su 362 corse prima delle correzioni).
