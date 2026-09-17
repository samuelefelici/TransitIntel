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
- **Niente sorveglianza dei giri.** Un giro dura 30-40 minuti; ogni controllo periodico (timer, polling) rilegge tutta la conversazione e costa quanto un turno intero. Regola dell'operatore (14 settembre): «l'AI deve essere di supporto e controllo, unione di tutto; la vera ottimizzazione la fa l'algoritmo». Quindi: il giro si lancia (dalla fucina o su richiesta) e il turno si chiude; il rendiconto si legge quando l'operatore dice che e' finito, prima con `section=kpi` e `ti_vcsp_compare`, la sezione `probe` solo se serve.

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

## La ricontrollata del 14 settembre

Quattro giorni fermi; nessuno ha toccato il pianificatore (solo Mizar/SIRI su `main`). Ripresa con una verifica di tutto cio' che era stato scritto nei due giorni precedenti e mai messo alla prova, e coi due strumenti nuovi finalmente esposti dal connettore.

**`ti_coincidences` leggeva il feed sbagliato.** Prima lettura sull'intera rete: `corse: 753` invece di 365, con la 1/3, la 2, l'8 e la 22 (zero corse festive nel progetto) e perfino RAF, C, Y, RE1 e Falconara, che nel progetto non esistono; id delle corse `689_CodUdp:…` del feed aziendale, non gli uuid del progetto. L'endpoint risolveva il feed con `getLatestFeedId` e basta, mentre il giro usa i due canali del progetto (UDP `scheduling_projects.feed_id`, poi `ps_projects.materialized_feed_id`). Ora `resolveProjectFeedForRead` fa la stessa risoluzione **senza effetti collaterali** — niente progetti di scheduling creati, niente ri-materializzazione da uno strumento di lettura — e la risposta porta in testa il feed usato e un avviso se e' piu' vecchio dell'ultima modifica in Planning. Tutte le «opportunita'» di quella prima lettura sono da buttare.

**Seconda lettura, dopo il merge: ancora il feed aziendale.** La risposta nuova diceva «senza psProjectId» — ma l'id c'era. La risoluzione trovava zero righe perche' cercava il progetto di scheduling per `planning_studio_project_id`, colonna aggiunta dopo e vuota sui progetti nati prima, mentre il giro lo trova **attraverso l'unita' di validita'** (`validity_unit_id` → `ps_validity_units.project_id`); e gli errori delle query erano ingoiati, cosi' il messaggio dava la colpa alla cosa sbagliata. Ora cerca in tutti e due i modi, ogni via fallita lascia una riga in `tentativi`, e **col progetto dato e nessun feed trovato risponde 404** invece di ripiegare in silenzio sul feed aziendale: una mappa vera di un'altra rete e' peggio di nessuna mappa.

**E superava i 40k del canale**, troncato a meta' JSON. Il connettore affetta: `section='sintesi'` (default) sta nel canale, `esistenti`/`mancate`/`opportunita` portano una lista intera alla volta.

**L'override delle ombre non aveva un test.** Pyflakes: i `global` erano dichiarati e mai assegnati — l'override con `globals()[nome]` funzionava, ma la dichiarazione era morta e nessun test provava che `vehicleShadowEur` da configurazione arrivi davvero a `_round_kpi`. E' la strada con cui l'operatore mette il SUO valore del mezzo: se non funziona, gli 80 € restano una stima dell'agente per sempre. Estratto in `apply_shadow_overrides`, con test.

**`ti_vcsp_compare` funziona sui dati veri** (AV contro AU, parametri identici) e ha fatto vedere due cose che il registro non aveva: in AU le autovetture sono **al tetto** (picco 5 su 5, in AV 4) e la sagoma ha superamenti pesanti — linea 91: 20 corse su 24 col mezzo piu' piccolo (83%, tetto 10%), linea 3: 27 su 54. La regola dice «un gradino solo e il meno possibile»: l'83% non e' «il meno possibile». Fronte aperto.

**Il codice della #473 (`earlyStop`) non e' mai stato eseguito da un giro**: verificato staticamente (scope dentro `main()`, pyflakes pulito). Il primo giro che lo esegue e' il prossimo.

## La mappa delle coincidenze sull'intera rete (14 settembre)

Prima lettura sul feed GIUSTO (`feedSource: udp`, 365 corse, sincronizzato dal lancio di AW). Il giro AW (`207604c7`) e' morto per il riavvio del server — un deploy di TransitIntel durante il giro, come da regola — e comunque era partito **senza** `earlyStopPatience`: il catalogo MCP di questa sessione e' ancora quello vecchio e lo schema di `ti_vcsp_run` non ha la manopola. Errore mio: non l'ho controllato prima di lanciare.

**Dieci coincidenze esistenti** (le stesse di AV), **36 mancate per poco**, **10 traslazioni di linea** con saldo positivo:

| linea | corse | flex | δ | crea | rompe | dentro la flex |
|---|---|---|---|---|---|---|
| **3** | 54 | 10′ | −14′ | **6** (3→2/6 ×24, 2/6→3 ×22, 3→1/4 ×20, 3→C.S. ×12 …) | 2 (31→3 Posatora ×12, 3→31 ×11) | no |
| 1/4 | 42 | 10′ | +13′ | 4 (3→1/4 ×20, 2/6→1/4 ×18, 1/4→7 ×11, 7→1/4 ×10) | 1 (11→1/4 ×3) | no |
| **7** | 12 | 15′ | −11′ | 3 (7→C.S. ×11, 7→1/4 ×10, 2/6→7 ×9) | **0** | **si'** |
| **C.S.** | 12 | 15′ | +14′ | 3 (3→C.S. ×12, 2/6→C.S. ×12, 7→C.S. ×11) | **0** | **si'** |
| 2/6 | 52 | 10′ | −8′ | 3 (1/4→2/6 ×19, C.S.→2/6 ×12, 21/33→2/6 ×3) | 1 (7→2/6 ×12) | si' |
| 42 | 26 | 15′ | +9′ | 2 (42→30 ×12, 24→42 ×10) | 1 (31→42 ×12) | si' |
| 21/33 | 8 | 15′ | −2′ | 1 (21/33→2/6 Madonnetta ×3) | 0 | si' |
| 44 / 24 / 30 | | 15′ | −16′ / −24′ / +24′ | 2 / 3 / 3 | 0 / 1 / 1 | no |

**Il fatto grosso e' Piazza Cavour.** Le due linee piu' grandi del festivo, la **3** (54 corse) e la **2/6** (52), si mancano **sistematicamente**: 49 incontri in un verso e 44 nell'altro, con attese fra 16 e 29 minuti, mai una coincidenza. Con la 1/4 lo stesso (21+20 incontri a 19-25′). E' il nodo dove la rete perde piu' valore, e la mappa lo quantifica: la 3 anticipata di 14′ creerebbe sei relazioni (una settantina di corse in coincidenza) — ma e' fuori dalla flessibilita' dichiarata (10′) e romperebbe Posatora (31↔3, 23 corse), a meno di non trascinare anche la 31.

**Due mosse gratis, dentro la flessibilita', che non rompono niente**: la **7 a −11′** e la **C.S. a +14′**, tre relazioni ciascuna. La C.S. +14 e' esattamente il candidato che la sonda ha provato in AV e che il VSP ha bocciato: mappa e sonda concordano sull'occasione, il solver dice che costa vetture. E' il punto in cui il criterio del servizio e quello del costo si guardano in faccia: ora almeno si vedono tutti e due.

**Perche' la sonda non arriva a questi candidati**: in AV le sei sonde sono state consumate dai candidati guidati dai turni e dalle fusioni di blocchi, che vengono prima in coda; ai candidati di linea ne sono arrivate due. Lanciato **AX** (`1f51ec44`) con **dieci sonde**, stessi altri parametri di AU/AV, perche' la coda arrivi fino ai candidati di linea (7 −11, 2/6 −8, 42 +9, oltre a C.S. +14 e 21/33 −2). Pazienza ancora 2: la manopola aspetta il catalogo.

## Cavour prima di Posatora: la decisione dell'operatore e cosa ne discende

«Piazza Cavour e' la piazza principale del capoluogo di provincia, Posatora e' un colle del comune.» La mossa grossa — la 3 anticipata di 14′ — si persegue; Posatora si tiene solo se la 31 si lascia trascinare.

**Flessibilita' alzata a 15′ su 3, 2/6 e 1/4** (`ti_set_flex`, col si' esplicito; erano a 10′). Verificato rileggendo la mappa: `flexDichiarataMin: 15` sulle tre, e la 3 a −14 e' ora `dentroLaFlessibilita: true`. Nessuna corsa si e' spostata: la flessibilita' dice solo entro quale finestra la sonda puo' PROPORRE.

**La regola della macchina, resa esplicita.** Condizione posta dall'operatore insieme al si': «quando arriva al capolinea esterno riparta sempre dopo l'arrivo, per dare la continuazione alla macchina». Il giro rigido la garantiva solo quando andata e ritorno erano riconosciuti come coppia (sosta entro 30′); `round_trip_order_broken` la garantisce SEMPRE — un ritorno che partirebbe prima dell'arrivo della sua andata non si propone a nessun prezzo, ne' come candidato ne' dopo la propagazione (`rejectedForRoundTrip` nel rendiconto). Un ritorno senza la sua macchina il VSP l'avrebbe coperto con un bus a vuoto senza dirlo. L'orientamento della coppia si decide dall'orario originale: e' il ritorno chi parte dopo l'arrivo dell'altro — la mappa delle coppie e' simmetrica e la prima versione, nel verso rovesciato, confrontava l'arrivo del ritorno con la partenza dell'andata dello stesso giro.

**La propagazione trascina la linea intera** quando il candidato e' una linea (`line_mode`): il tetto in corse (12) faceva morire subito qualunque trascinamento di linea — la sola 3 ha 54 corse — e in AV e' successo ogni volta. Ora il mattone trascinato e' la linea intera del partner, cadenza intatta, il tetto si conta in linee (3), e si fa un trascinamento per passo ricalcolando cosa e' ancora rotto: le rotture calcolate prima potevano riguardare corse appena sistemate, e leggerle come conflitto era falso.

## Il giro AX: zero violazioni, e la sonda ha mosso una linea intera

AX (`1f51ec44`, scenario `f97e116d`, 1947 s): dieci sonde, il resto come AU. **Round 6 (la sonda) vincente: 23 vetture, 43 turni (37 interi + 6 semiunici), 0 supplementi, 0 violazioni**, auto al picco 3 su 5, incustodito max 15′, km a vuoto 196,9 (AU: 246,6), 21 550 €. E' il primo piano della serie senza violazioni e con l'auto sotto il tetto; contro AU (21 vetture, 1 violazione, auto 5/5) costa due vetture in piu' — e il confronto vale con riserva, perche' AU girava con sei sonde (`ti_vcsp_compare` lo segnala).

| round | vetture | turni | suppl. | violazioni | costo € | punteggio € |
|---|---|---|---|---|---|---|
| 1 | 24 | 44 | 1 | 4 | 20 859 | 32 079 |
| 2 | 25 | 43 | 0 | 1 | 21 371 | 32 071 |
| 3 | 26 | 43 | 0 | 6 | 21 362 | 32 642 |
| 4 | 24 | 43 | 0 | 0 | 21 579 | 32 099 |
| 5 | 26 | **37** | 0 | **11** | 20 250 | 30 830 |
| **6 (sonda)** | **23** | 43 | 0 | **0** | 21 550 | **32 006** |

**La prima traslazione di linea accettata.** Otto corse spostate, tutte della 21/33, tutte di −2′ (andata e ritorno, dalle 08:02 alle 20:04): la sonda «coincidenza» ha preso la linea intera, come la mappa proponeva (21/33→2/6 alla Madonnetta ×3, dentro la flex di 15′). Il VSP e' passato da 24 a 23 vetture, il punteggio da 32 099 a 32 006 €, disturbo 16 €, una coincidenza creata e nessuna rotta. E' il meccanismo che la ricontrollata cercava: il mattone e' la linea, la cadenza resta intatta, e il solver trova il posto per una vettura in meno.

**I candidati di linea grossi non sono passati, e i motivi sono tutti noti** (`rejectedForCoincidence: 9`, `propagatedForCoincidence: 0`):

- **C.S. +14′** (12 corse): arriva al solver e viene bocciata dal punteggio (32 099 → 32 977 €, +877, disturbo 168). La mappa la vede gratis sul servizio; il CSP dice che costa turni. Mappa e solver concordano sull'occasione, non sul prezzo.
- **7 −11′**: romperebbe tre coincidenze 7→2/6 a Cavour (attesa da 2 a 13′) e la propagazione muore per `flessibilitaInsufficiente` — tentata quattro volte, in quattro round, con lo stesso esito. La 2/6 era a 10′ di flex e la propagazione trascinava corse, non la linea.
- **2/6 −8′** (tre volte) e **42 +9′**: `catenaTroppoLunga`, il tetto di 12 corse. Con line_mode il tetto si conta in linee.
- Un `crew-both` da 60′ e un `tail-` sulla 91 (−13′) bocciati come sempre.

**Correzione (rilettura del codice):** i candidati bocciati dal filtro (coincidenze, macchina) NON consumano sonde — il filtro costa zero e gira prima del solver; le quattro ripetizioni della 7 −11 sono le quattro passate del ciclo, registrate ogni volta. Il fatto vero e' un altro: **su dieci sonde chieste ne sono state usate tre**, perche' la coda si e' svuotata — zero candidati dai turni, uno dai blocchi, e dei quattro di linea (tetto della lista) tre morti nel filtro. La sonda non ha esaurito il budget: ha esaurito le idee, e il rendiconto non lo diceva.

**Il round 5 e' il segnale piu' interessante e il piu' pericoloso**: 37 turni (sei in meno), 20 250 € (−1 300), ma 11 violazioni BDS e 26 vetture. La selezione lessicografica (violazioni prima del punteggio) lo scarta, com'e' giusto — ma dice che con sei turni in meno il costo cala di 1 300 € al giorno. Vanno lette le undici violazioni: se sono tutte «intero senza sosta ≥ 15′ al capolinea», e' il punto in cui la sosta al capolinea periferico (il cuscinetto del giro rigido) puo' fare la differenza.

**Sagoma**: 129 corse declassate (35%), 60 in punta; superamenti su 30 (17% in punta), 31 (17%, 36% in punta), 42 (23%). Peggio di AU sulla 3 (39 declassate contro 29), meglio sulla 30 (2 contro 10). Fronte aperto, invariato.

AX girava **senza** line_mode e senza il guardiano della macchina, e con la flex vecchia (10′ su 3, 2/6 e 1/4): le tre cose sono arrivate dopo (#523 e `ti_set_flex`). Il giro AY e' il primo con tutte e tre, e con davanti la 3 a −14 con la 31 al seguito.

## La sonda impara: memoria dei rifiuti, alternative, lezioni fra i giri (14 settembre)

Obiettivo dato dall'operatore al lancio di AY: «un sistema che impara dagli errori, che migliora ogni volta e che sappia lavorare completamente in simbiosi tra scheduling e programmazione: devono lavorare insieme come una squadra». Il primo pezzo e' la sonda, perche' e' il punto in cui il piano (i turni) parla all'orario (il programma) e viceversa.

**Cosa c'era.** La sonda non aveva memoria di niente. Dentro il giro rivalutava e riscriveva lo stesso rifiuto a ogni passata del ciclo (AX: la 7 a −11 quattro volte); fra un giro e l'altro ripartiva da zero, e l'unica memoria era questo registro, scritto a mano. E quando la coda si svuotava non lo diceva: in AX tre sonde su dieci, e il rendiconto mostrava «probesRun: 3» senza spiegare perche'.

**Cosa c'e' ora** (`vcsp_probe.py`, `vcsp_orchestrator.py`, rotta dell'agente, connettore):

- **Una firma stabile per ogni candidato** (`linea:7:-11`, `tail-:a1b2c3d4-13`): e' la chiave della memoria, uguale dentro il giro e fra un giro e l'altro. Una linea intera si riconosce da linea e delta, non dagli id delle corse.
- **Il rifiuto del filtro si registra una volta**, coi `tentativi` accanto; i contatori (`rejectedForCoincidence`, `propagationFailures`, `rejectedForRoundTrip`) contano candidati distinti, non passate. Il filtro continua a girare a ogni passata — dopo un'accettazione lo stato cambia e un candidato morto puo' passare — ma non inganna piu' sul costo: zero sonde.
- **Il motivo del rifiuto indica la mossa dopo.** La lista dei candidati di linea porta, dopo la mossa migliore di ogni linea, le sue ALTERNATIVE: gli altri delta con saldo positivo dentro la flessibilita' (`alternativaDi` nel rendiconto), tetto 12 invece di 4. Se la 7 a −11 muore perche' la 2/6 non regge il trascinamento, si prova il delta dopo, non si abbandona la linea.
- **La coda esaurita si dichiara**: `codaEsaurita` e `sondeNonUsate` nel rendiconto e nel log («3 sonde su 10 (coda esaurita)»).
- **Lezioni in uscita** (`lezioni`: una voce per firma con esito, motivo, tentativi, effetto sul punteggio e vetture prima/dopo) **e in entrata**: il server allega al giro le lezioni degli ultimi cinque giri completati sullo stesso progetto e la stessa data (`loadProbeLessons`, dal registro persistente; `params.memoria` dice quante e da quanti giri). La sonda le usa per ORDINARE la coda — chi era stato accettato si riprova per primo, chi il solver aveva bocciato va in fondo, chi era morto nel filtro si ricontrolla perche' costa zero — **mai per vietare**: il piano cambia da un giro all'altro, e un candidato bocciato ieri puo' passare oggi. `memoria: false` in `ti_vcsp_run` spegne tutto per un giro da zero.
- **Baco trovato per strada, e riparato**: la pazienza dell'early-stop (`earlyStopPatience`) arrivava dal connettore e moriva nella rotta dell'agente, che non la passava al motore. L'esperimento sulla pazienza sarebbe girato con 2 e nessuno se ne sarebbe accorto. Ora passa, finisce nei parametri del giro e `ti_vcsp_compare` la confronta.

**Cosa NON fa ancora, per onesta'.** La memoria e' della sonda, non dei round (il VSP/CSP riparte da zero ogni giro). Le lezioni non portano le condizioni in cui sono state imparate: una lezione presa a flex 10 vale anche a flex 15, dove potrebbe essere superata — per questo ordina e non vieta. E non c'e' ancora un ritorno dall'operatore (accettato o rifiutato in Cerbero) verso la sonda: quella e' la lezione che vale di piu', ed e' il passo dopo.

14 test nuovi (`test_sonda_memoria.py`): 270 verdi.

## Il giro AY: due scoperte piu' grosse del risultato

AY (`8743fc46`, scenario `496e6667`, 2309 s): stessi parametri di AX, ma con la flex a 15′ su 3, 2/6 e 1/4, la propagazione per linea e il guardiano della macchina (#523). Girava ancora SENZA la memoria della sonda (#524, non mergiata durante il giro).

| round | vetture | turni | suppl. | violazioni | costo € | punteggio € |
|---|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 5 | 20 734 | 31 834 |
| 2 | **28** | 43 | 0 | 1 | 21 403 | 32 343 |
| 3 | 25 | 45 | 2 | 7 | 21 674 | 33 574 |
| 4 | 27 | 45 | 2 | 1 | 22 073 | 33 533 |
| 5 | 27 | 44 | 1 | 4 | 21 730 | 33 190 |
| **6 (sonda)** | **22** | 43 | 3 | 1 | 21 331 | **32 136** |

Esito: 22 vetture, 43 turni (35 interi + 5 semiunici + 3 supplementi), auto 4/5, km a vuoto 207, 21 331 €. Contro AX (23 v, 0 suppl, 0 viol): una vettura in meno, tre supplementi in piu'. Il cruscotto dice 0 violazioni, la tabella dei round ne dice 1 sul round 6: un'incoerenza da chiarire (in sospeso).

**Prima scoperta: la sonda ha «guadagnato» sei vetture spostando tre corse, e non e' possibile.** Il miglior round prima della sonda era il 2, con 28 vetture (i round senza violazioni non c'erano: 5, 1, 7, 1, 4). La sonda ha spostato tre corse di −15′ (2/6A 11:35, 2/6R 12:04, 7 11:13, candidato guidato dal turno A008, stacco 84′) e il re-solve ha dato **22 vetture**: sei in meno. Tre corse non valgono sei vetture. La differenza sta nel solver: il re-solve della sonda gira con 60 s e riduzione iterativa a 45 s, i round con 420 s e 180 s, e con le stesse penalita' d'arco il solve corto ha battuto quello lungo di sei vetture. I round oscillano 25-28 (AX: 24-26, AU: 21-29) con lo STESSO input: il rumore del solver e' piu' grande di qualunque mossa d'orario, e la sonda lo legge come merito della mossa. L'assunto scritto nel codice — «budget ridotto: un falso rifiuto e' possibile, un falso via libera no» — e' falso quando il solver e' cosi' rumoroso.

Cosa ne discende, e va fatto subito: **il controllo**. Prima di misurare i candidati, la sonda deve rifare il solve del best round SENZA spostamenti, con la stessa configurazione dei candidati. Il valore vero di un candidato e' (candidato − controllo), non (candidato − round). E se il controllo batte il best round — qui: 22 contro 28, senza toccare una corsa — quello e' un piano legittimo e diventa il nuovo riferimento (un round in piu', senza disturbo). Le tre corse spostate in AY, con ogni probabilita', non valgono niente: 45 € di disturbo per un guadagno che era del solver.

**Seconda scoperta: il grafo delle coincidenze del festivo e' fatto di due grappoli, e ogni mossa di linea sbatte contro il tetto.** Con line_mode la 3 a −14 e' arrivata al filtro: rompe Posatora (31→3, attesa −11: la 3 partirebbe undici minuti PRIMA che la 31 arrivi), la propagazione trascina la 31, ma la 31 e' un perno — 30 all'Ospedale, 42 e 24 a U.Bassi — e trascinarla ne trascina altre tre: **cinque linee, tetto a tre, `catenaTroppoLunga`** (22 volte, su tutti i candidati di linea: 1/4 +13 passa dalla 11 alla 2/6, la 7 −11 dalla 2/6 alla 21/33 e alla 11). Il festivo ha due grappoli: {3, 31, 30, 42, 24} attorno alla 31 e {2/6, 7, 11, 21/33, 1/4} attorno alla 2/6. «La 3 a −14» significa in realta' «il grappolo della 31 a −14 rispetto al grappolo della 2/6»: cinque linee, cadenza intatta, tutte le coincidenze interne conservate, e le relazioni fra i due grappoli — Cavour compresa — ridisegnate. La mappa oggi valuta solo la linea singola; il mattone dopo la linea e' il **grappolo**, e la mappa deve saperlo pesare (create e rotte fra i grappoli) prima che la sonda lo provi.

**Il controllo e' fatto** (stesso branch della memoria, #524): prima dei candidati la sonda rifa' il solve del best round senza spostamenti, con la configurazione dei candidati; se ha meno vetture (o costo minore a pari vetture) passa dal CSP, e diventa il riferimento solo se non porta violazioni in piu' e abbassa il punteggio. Da li' in poi ogni candidato si misura contro il controllo. Se il controllo vince e nessun candidato passa, il round della sonda esce lo stesso, senza spostamenti: e' il piano migliore trovato, e va offerto. Nel rendiconto: `controllo` con vetture, costo, punteggio e violazioni round/controllo e `riferimento`. `probeControl: false` (`controllo: false` dal connettore) lo spegne. Cinque test.

**La coda**: 6 candidati, 5 sonde su 10 — di nuovo esaurita (stavolta con quattro candidati dai turni, la prima volta). La memoria (#524) avrebbe messo in coda le alternative; il grappolo aggiungera' i candidati che contano.

**Sagoma**: 101 declassate (28%, meglio di AX: 129), ma la 3 a 35/54 (65%, 13 in punta) e la 91 a 20/24 (83%): il fronte resta aperto e la 3 e' la linea piu' grossa del festivo.

## Il giro AZ: il controllo funziona, la memoria parte da zero, la sonda comprava violazioni

AZ (`33351541`, scenario `93b7b349`, 2842 s): primo giro con controllo e memoria (#524), parametri di AY.

| round | vetture | turni | suppl. | violazioni | costo € | punteggio € |
|---|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 4 | 20 737 | 31 737 |
| 2 | 31 | 45 | 2 | 2 | 22 399 | 34 279 |
| 3 | 26 | 44 | 1 | 6 | 21 415 | 32 995 |
| **4** | **25** | 45 | 2 | **1** | 22 150 | 33 450 |
| 5 | 26 | 44 | 1 | 8 | 21 596 | 33 376 |
| 6 (sonda) | 24 | 40 | 0 | 3 | 20 721 | 31 291 |

Esito: round 4, 25 vetture, 45 turni, 2 supplementi, 1 violazione, 22 150 €. Peggio di AY (22/43/3/0) e di AX (23/43/0/0): i round oscillano fra 25 e 31 e nessuno e' a zero violazioni.

**Il controllo ha fatto il suo lavoro.** 25 vetture contro 25, costo vetture 6 481 contro 6 488, punteggio 33 493 contro 33 450: non batte il round, il round resta il riferimento. Stavolta il solver non ha regalato niente, e adesso lo si sa.

**La memoria ha letto zero lezioni**, ed e' giusto cosi': AX e AY erano girati col codice vecchio e non hanno `lezioni` nel rendiconto. AZ e' il primo giro che le scrive (23 voci); BA sara' il primo a leggerle.

**La coda non si e' esaurita**: 5 candidati in partenza, 10 sonde su 10, grazie alle alternative. La C.S. a −15 e' l'alternativa del +14, che il VSP ha bocciato come in AX.

**Tre accettazioni in fila, e la terza ha buttato via le prime due:**

1. `split`: 1/4R 18:40 +15′ e 41A 18:24 −5′ → 25→24 vetture, 45→43 turni, **1→0 violazioni**, punteggio −910 €. **Il miglior piano del giro: 24 vetture, zero violazioni, 21 700 €.**
2. crew-early per il turno A014 (stacco 89′): due corse a −15′ che la propagazione ha allargato a dieci (30, 31, 42, 3 e 24, andata e ritorno: il grappolo della 31, a livello di corsa) → 43→41 turni, 0→1 violazioni, −1 091 €.
3. C.S. intera a −15′: tre relazioni create, 41→40 turni, **1→3 violazioni**, −157 €, disturbo cumulato 350 €.

La sonda accettava sul punteggio, dove una violazione vale 100 € d'ombra e un turno 200: **comprava violazioni**. La selezione fra round mette le violazioni prima del punteggio, ha scartato il round della sonda (3 contro 1), e il piano del passo 1 — l'unico a zero violazioni di tutto il giro — non e' stato offerto a nessuno.

**Corretto**: la sonda non compra violazioni. Un candidato che ne porta in piu' non passa a nessun prezzo (motivo `violazioni`, `violazioniInPiu` nel rendiconto; la memoria lo rimanda in coda come ogni bocciatura del solver). Con la regola, in AZ i passi 2 e 3 sarebbero stati bocciati e il piano a 24 vetture e zero violazioni sarebbe uscito come round della sonda, e come migliore del giro. Stesso metro del controllo: le regole non si comprano.

**I grappoli, di nuovo**: 13 candidati di linea morti per `catenaTroppoLunga` — 3 a −13/−14/−15, 1/4 a +13/+14, 7 a −11/−12/−13, 2/6 a −8, 42 a +9/+10/+11, 21/33 a +8. Le alternative di una linea non aggirano il grappolo: il mattone dopo e' il grappolo, confermato.

**Sagoma**: 140 declassate (38%), la 3 al 69%, la 91 all'83%. Peggio di AY.

## Il giro BA: memoria e controllo lavorano, la sonda non trova niente, e il problema grosso e' il solver

BA (`dedf811b`, scenario `90fd91d6`, 1917 s): primo giro con le lezioni di AZ in memoria e con la regola «la sonda non compra violazioni» (#525). Parametri di AY.

| round | vetture | turni | suppl. | violazioni | costo € | punteggio € |
|---|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 4 | 20 769 | 31 769 |
| 2 | 25 | 43 | 3 | 1 | 21 438 | 32 438 |
| 3 | 27 | 43 | 0 | 1 | 21 342 | 32 202 |
| **4** | **21** | 43 | 3 | **1** | 21 067 | **31 747** |
| 5 | **33** | 47 | 0 | 3 | 22 860 | 35 200 |

Esito: round 4, **21 vetture** (il minimo della serie, pari ad AU), 43 turni, 3 supplementi, 1 violazione («stacco tra segmenti 2 min < 5», un tipo nuovo), 21 067 €. Sagoma 101 declassate (28%), la 3 al 44% e la 91 al 58%: meglio di AZ.

**La memoria ha letto** 23 lezioni da un giro (AZ): un candidato ripreso in testa (la C.S. a −15, accettata in AZ) e due rimandati in coda (la C.S. a +14 e la 21/33 a −2, bocciate dal solver in AZ). **Il controllo**: 21 vetture contro 21, stesso costo, il round resta il riferimento. Tutti e due hanno fatto esattamente quello per cui sono nati.

**La sonda non ha accettato nulla**: 4 candidati, 4 sonde, coda esaurita con 6 sonde inutilizzate. La C.S. a −15, che in AZ era passata su un piano peggiore, qui contro 21 vetture e' stata bocciata dal VSP; idem un crew-both da sei corse e la 21/33 a −2; la C.S. a +14 bocciata dal CSP (+93 €). Dieci candidati di linea morti nel grappolo, come sempre. E' un esito onesto: su un piano gia' a 21 vetture non c'e' una mossa d'orario da poche corse che ne tolga un'altra. La regola sulle violazioni non e' entrata in gioco (nessun candidato e' arrivato fin li').

**Il problema grosso, adesso, e' scritto nella tabella dei round: da 21 a 33 vetture con lo STESSO input.** Il round 5 ne ha trovate 33, il round 4 ne aveva trovate 21 tre minuti prima. Il ciclo VSP↔CSP con le penalita' d'arco non converge: ogni round e' un solve da capo, e le penalita' del CSP lo spostano dove capita. Il miglior giro della serie e' il migliore perche' un round ha avuto fortuna, non perche' il ciclo ha imparato. Questo non e' un lavoro per la sonda ne' per l'AI: e' l'algoritmo. Le strade, in ordine di semplicita': (1) partenza a caldo — ogni round riparte dai blocchi del round migliore invece che da zero, cosi' le penalita' correggono un piano buono anziche' rifarne uno; (2) piu' semi per round tenendo il migliore; (3) penalita' d'arco meno brusche. Prima di qualunque altra cosa va misurato quanto e' rumore e quanto e' penalita': due giri identici a `probes 0` e `rounds 1` lo dicono con un solo parametro.

**Il grappolo** resta il mattone dopo per le coincidenze: dieci candidati di linea morti contro il tetto anche in BA.

## Perche' i round non miglioravano: quattro cause, non una (15 settembre)

Dal giro BA: 25, 25, 27, 21, 33 vetture sullo stesso orario. AZ: 25, 31, 26, 25, 26. AY: 25, 28, 25, 27, 27. Quattro lettori sul motore e tre progetti indipendenti, giudicati in contraddittorio, hanno trovato **quattro cause distinte**, tutte nel modo in cui il feedback passa da un round all'altro. Nessuna era quella che pensavo.

**Il dato che ha riorientato tutto, e non e' costato un giro**: il round 1 dei tre giri ha dato **25, 25, 25** vetture. Il round 1 e' l'unico senza penalita' d'arco, per costruzione. Quindi **a bersaglio fermo il motore e' gia' stabile al livello del conteggio vetture**: l'oscillazione non e' anzitutto rumore del solver, e' il feedback.

### 1. La moneta era truccata

Il costo con cui si confrontano i round arriva da `metrics.costEur` del VSP, che e' `costBreakdown.aggregated.total` e **include `vcsp_penalty`**: le penalita' d'arco realizzate dal piano. Sono soldi che l'orchestratore inventa per spingere il solver, e cambiano a ogni round — il round 1 non ne ha nessuna. I round finivano in classifica su scale diverse, e chi riceveva piu' segnale appariva piu' caro senza aver speso un centesimo in piu'. Ora si sottraggono (`_vcsp_penalty_of`), e il rendiconto porta `shadowPenaltyEur` per round: quanto mordeva il feedback.

**Conseguenza da tenere a mente:** i giri di prima hanno il costo LORDO, quelli di adesso NETTO. Non sono confrontabili sul costo, e `ti_vcsp_compare` lo segnala da solo perche' i parametri del ciclo sono nuovi; il confronto mostra anche `shadowPenaltyEur`, che nei giri vecchi e' vuoto.

### 2. Il feedback nasceva dall'ultimo arrivato

`extract_arc_penalties` girava sul piano dell'ultimo round, qualunque fosse — anche il peggiore della serie — e quel piano dettava le penalita' di tutto il resto del giro. Ora l'ancora e' il **campione** (`penaltyAnchor`, default `best`).

### 3. Le penalita' si cancellavano: il generatore del ciclo

`arc_penalties` veniva **riassegnato**, non aggiornato. Un arco penalizzato al round r, se il round r+1 lo evitava, al round r+2 **tornava gratis** e il piano ci ricascava. E' il generatore classico del ciclo limite, e si vede a occhio nella serie di BA. Ora le penalita' nuove si mescolano a quelle in vigore (`penaltyStep`, default 0.5; a 1 e' la sostituzione secca di prima) e si dimenticano sotto l'euro.

### 4. Non c'era il canale per ripartire dal piano migliore

Il warm start esisteva gia' — dentro il singolo VSP, che fa un portafoglio di scenari con `model.add_hint` — ma **fra un round e l'altro no**: `vsp_in = dict(vsp_payload)` piu' la sola chiave `arcPenalties`, e il greedy rifaceva la baseline da capo. Ora `warmStartChains` porta i blocchi del round migliore, `chains_from_trip_ids` li traduce e li **ripara** (corse ignote, doppie, agganci caduti, corse scoperte: il ritorno e' sempre una soluzione ammissibile, qualunque cosa arrivi), e il portafoglio li usa come primo warm start — li' i tagli anti-ripetizione sono ancora vuoti, quindi il suggerimento non contraddice niente — e come baseline se battono il greedy.

### 5. Il moltiplicatore misurato su un piano e applicato a un altro

Questa l'ha trovata la revisione avversariale del mio stesso lavoro, e l'avevo introdotta io con l'ancora. L'escalation dei giunti si misurava sulla legalita' dell'**ultimo round** e moltiplicava le penalita' del **campione**. Il guaio non e' l'incoerenza in se': e' che **`round_is_legal` e' vera esattamente quando le penalita' sui giunti sono vuote**. Le due condizioni sono la stessa cosa scritta due volte — cambi senza auto, o bus lasciati soli oltre il limite. Quindi con un campione legale il moltiplicatore moltiplicava il vuoto, per qualunque valore raggiungesse: il log stampava «cambi fuori regola ×2,5», il rendiconto mostrava il numero, e non agiva su niente. Ed e' l'unico canale che punta il dito su quelle due regole rigide: nel costo-ombra per blocco pesano zero.

Ora la legalita' si giudica sull'**ancora**, cioe' sullo stesso piano da cui nascono le penalita'. E si ferma da sola: un campione legale non puo' piu' essere spodestato da uno illegale, perche' la selezione mette le violazioni prima del punteggio — quindi l'escalation smette di crescere appena un piano legale prende la testa. Quattro test fissano l'equivalenza, che prima non era scritta da nessuna parte.

### Cosa NON e' stato toccato, di proposito

- **L'escalation non scende mai**, nemmeno quando il piano torna in regola. Farla scendere introdurrebbe un'oscillazione nuova al posto di quella che si sta togliendo. Va deciso con un giro, non a occhio.
- **Il determinismo del solver** (`randomize_search=True`, 8-16 worker, tempo di parete): comprarlo costa un dodicesimo dello spazio esplorato, e il dato dei round 1 dice che non e' li' il problema principale. Semmai si misura in laboratorio con un worker solo, mai in produzione.
- **Un difetto preesistente trovato per strada**: `forbidden_arc_sets` accumula l'insieme d'archi di OGNI scenario, campione compreso, e lo scenario dopo riceve `ws = best_chains` — cioe' si suggerisce al solver una soluzione che un suo stesso taglio vieta. Va guardato a parte: tocca ogni giro VSP, anche fuori dal VCSP.

### La via di fuga

`penaltyStep: 1`, `penaltyAnchor: "last"`, `seedFromBest: false` riportano il ciclo esattamente a com'era, **senza un deploy**: sono tre valori nella richiesta del giro.

### Come e' stato controllato, senza spendere un giro

Quattro lettori sul motore, tre progetti indipendenti e tre giudici in contraddittorio per capire la causa; poi cinque revisori sul mio stesso diff, ognuno con una lente diversa (correttezza, convergenza, compatibilita', numeri, test), e ogni rilievo passato da tre confutatori indipendenti che partivano dal presupposto che fosse sbagliato. Il rilievo sull'escalation e' l'unico passato all'unanimita' da tutti e tre, ed era vero. Quarantadue test nuovi fra i tre file, 308 in tutto, compreso il ciclo intero guidato con solver finti: fissa l'ordine (il seme viene dal campione dei round precedenti, il feedback arriva dopo) e la via di fuga.

### Il termometro

Il rendiconto porta, per ogni round: quanti archi sono in vigore, quanto pesano in tutto, **di quanto si sono spostati dal round precedente** e su quale piano sono stati calcolati. Se lo spostamento non cala, il VSP sta inseguendo un bersaglio che salta e nessun round puo' migliorare il precedente. E' il numero che dice se il giro ha funzionato, e prima non c'era.

## Il giro BB: il miglior piano della serie, e il controllo che lo dimostra

BB (`ed715ed8`, scenario `6459cbd2`, 2951 s): primo giro col ciclo ricucito. Stessi parametri di BA.

**Esito: 21 vetture, 43 turni (37 interi + 6 semiunici), ZERO supplementi, ZERO violazioni**, auto al picco 5 su 5, incustodito 15, km a vuoto 206, costo netto 20 939 €.

E' il miglior piano di tutta la serie, ed e' il primo che sta insieme su tutto: AU aveva 21 vetture ma una violazione; AX zero violazioni ma 23 vetture; AY 22 vetture e tre supplementi; BA 21 vetture con una violazione e tre supplementi. BB **domina AU** (stessi numeri, una violazione in meno) e **domina BA** (tre supplementi e una violazione in meno). Unico peggioramento: le auto sono al tetto (5 su 5) invece di 4, e la sagoma torna a 141 declassate (39%) contro le 101 di BA.

| round | vetture | turni | suppl. | violazioni | costo netto € | ombra € |
|---|---|---|---|---|---|---|
| 1 | 25 | 43 | 0 | 4 | 20 717 | 0 |
| 2 | 24 | 45 | 2 | 5 | 21 247 | 119 |
| 3 | 26 | 46 | 3 | 2 | 21 494 | 169 |
| 4 | **19** | 43 | 3 | **11** | 20 850 | 208 |
| 5 | 22 | 43 | 3 | 3 | 20 840 | 196 |
| **6 (sonda)** | **21** | 43 | **0** | **0** | 20 939 | 185 |

### Il controllo ha fatto la cosa per cui e' nato

Il primo candidato della sonda ha portato il piano da **26 a 21 vetture** spostando **cinque corse di 12 minuti** (11, 2/6 andata e ritorno, 1/4 andata e ritorno, tutte fra le 16 e le 17). In AY una cosa cosi' l'avevo letta come rumore del solver, e avevo ragione: tre corse non valevano sei vetture. Qui il controllo dice il contrario, e lo dice con un numero: **re-solve dello stesso input senza spostamenti, 26 vetture** — le stesse del round, che girava con sette volte il tempo. Quindi le cinque vetture vengono dalle cinque corse, non dal solver. E' il primo guadagno della sonda che sappiamo spiegare.

Gli altri due candidati accettati hanno lavorato sulle regole, non sulle vetture: `crew-late` (9 corse a +15′ su 24, 31, 30, 42 e 3, la mattina) ha tolto un turno e una violazione; `crew-both` (7 corse a ±15′) ha tolto **l'ultima violazione**. In tutto 21 corse spostate, 300 minuti, 300 € di disturbo.

### Il termometro dice che l'ancora e lo smorzamento funzionano

| dopo round | ancora | archi dal piano | archi in vigore | massa € | spostamento € | escalation |
|---|---|---|---|---|---|---|
| 1 | 1 | 177 | 83 | 205,67 | 205,67 | 1 |
| 2 | 1 | 177 | 83 | 308,72 | **103,05** | 1 |
| 3 | 3 | 200 | 142 | 374,62 | 310,66 | 2,5 |
| 4 | 3 | 200 | 98 | 471,39 | 278,97 | 6,25 |

Fra il round 1 e il round 2 **l'ancora non si e' mossa** (il round 2 era peggiore: cinque violazioni contro quattro) e lo spostamento si e' **esattamente dimezzato**, 205,67 → 103,05. E' la convergenza geometrica che il passo 0,5 deve produrre: stesso bersaglio, la penalita' in vigore ci si avvicina di meta' a ogni round. Il meccanismo si vede funzionare nei numeri.

Al round 3 l'ancora e' passata al round 3 (due violazioni contro quattro: la selezione mette le violazioni prima di tutto) e il bersaglio si e' spostato di nuovo. **Non e' un difetto: e' il comportamento giusto.** Il campione e' migliorato, quindi il segnale deve cambiare. L'escalation e' salita a 2,5 e poi a 6,25 perche' il campione aveva cambi fuori regola — e con la correzione del moltiplicatore quella pressione ora agisce sui giunti del campione, non nel vuoto. Il piano finale ha zero violazioni e zero giunti fuori limite.

### Cosa NON e' cambiato, e va detto

**I round oscillano ancora**: 25, 24, 26, 19, 22. La forbice si e' stretta (7 vetture contro le 12 di BA, e nessun round catastrofico come il 33) ma i round non migliorano l'uno sull'altro in modo monotono. La partenza a caldo da' loro un punto di partenza buono, non li obbliga a restarci: l'obiettivo cambia a ogni round, quindi «meglio» cambia significato.

**Il round 4 ha trovato 19 vetture**, il minimo mai visto, con undici violazioni. Non e' utilizzabile, ma dice che 19 e' raggiungibile. E siccome il campione si sceglie prima sulle violazioni, quella struttura non e' mai diventata seme: **le soluzioni con meno vetture vengono trovate e buttate**. E' il fronte piu' promettente che resta aperto.

**Il muro del grappolo e' intatto**: 11 rifiuti, tutti `catenaTroppoLunga`, sulle stesse linee di sempre (3 a −13/−14/−15, 1/4 a +8/+13, 7 a −4/−11/−12/−13, 2/6 a −8, 42 a +9). La propagazione pero' lavora molto di piu': 26 candidati allargati con successo, contro 6 in AZ e 2 in BA.

**La memoria** ha letto 25 lezioni da due giri (AZ e BA) e ha rimandato in coda tre candidati che il solver aveva gia' bocciato. Nessuno ripreso in testa: in BA la sonda non aveva accettato niente, quindi non c'erano successi da riprovare.

### Un difetto del rendiconto, trovato leggendo BB

Il confronto fra giri mostrava `penaltyStep` e `penaltyAnchor` **vuoti** anche se erano in vigore (0,5 e «campione», visibili nel termometro): chi lancia un giro coi valori di default non li scrive nella richiesta, e i parametri del giro venivano dalla richiesta. Due giri con un ciclo diverso sarebbero sembrati identici — esattamente cio' che il confronto serve a impedire. Ora il motore dichiara nel rendiconto le manopole **effettivamente in vigore** (`ciclo`) e i parametri del giro le registrano da li'.

## Le diciannove vetture non erano un tesoro: il conto, e cosa ne discende (15 settembre)

Leggendo BB avevo scritto che le soluzioni con meno vetture «si trovano e si buttano», e proposto un secondo seme per non perderle. **Ho fatto il conto prima di costruirlo, ed era sbagliato.**

Round 4 di BB (19 vetture, 11 violazioni) contro round 6 (21 vetture, zero violazioni), stesso giro e stesso orario:

| | round 4 | round 6 | differenza |
|---|---|---|---|
| vetture | 19 | 21 | **−2** |
| costo parco | 5 635,11 € | 5 874,91 € | **−239,80 €** |
| costo guida | 15 214,74 € | 15 064,53 € | **+150,21 €** |
| totale | 20 849,85 € | 20 939,44 € | **−89,59 €** |
| violazioni | 11 | 0 | +11 |

Le due vetture in meno valgono 240 € sul parco, **ma ne restituiscono 150 sul lato guida**: il saldo vero e' 90 € al giorno, pagati con undici violazioni e tre supplementi. Non e' un tesoro buttato via, e' un cattivo affare che la selezione lessicografica ha scartato per il motivo giusto. **Il secondo seme non si fa.**

### Il conto che riordina le priorita'

- La **guida e' il 71,9%** del costo di BB (15 065 € su 20 939).
- La **vettura marginale** costa circa **120 € al giorno** (dalla coppia round 4 / round 6, stesso giro: l'unico confronto pulito che abbiamo).
- Il **turno medio** costa **350 € al giorno**.
- Quindi **un turno vale quasi tre vetture**.

Per undici giri ho letto i giri mettendo le vetture in cima, e le vetture sono la voce piccola. AX round 5 lo diceva gia': 37 turni invece di 43, 1 300 € in meno, con tre vetture IN PIU'. Il numero che conta e' quello, e finora l'ho trattato come una curiosita'.

E c'e' una ragione strutturale per cui le due cose tirano in direzioni opposte: **impacchettare le corse su meno vetture crea blocchi che il CSP non sa tagliare in turni legali**. E' la tensione del VCSP, e ora e' misurata sullo stesso giro invece che supposta.

### Il tetto dei semiunici morde a ogni giro

BB: 6 semiunici su 6 ammessi. AX: 6 su 6. AY: 5 su 5. **Il tetto e' sempre saturo.** E' una regola dell'operatore, non un difetto — ma e' il vincolo che decide quanti turni servono, e vale piu' di tutto quello su cui ho lavorato finora. Se quel tetto puo' salire, e di quanto, lo sa solo l'azienda.

## La relazione la fa il software, e ora e' completa (15 settembre)

Richiesta dell'operatore: «il resoconto deve essere fatto dal software, non da te» e «il report deve essere completo in Cerbero, compreso di tutte le analisi fatte». Giusto: un resoconto scritto a mano non e' riproducibile e invecchia il giorno dopo.

### Due difetti dei costi, corretti

**Il tempo pagato era contato due volte.** In `compute_duty_cost_v4` (e nella versione storica in `cost_model.py`) il costo del turno addebitava guida, attese, pre-turno e trasferimenti COME COMPONENTI, e poi ri-addebitava il lavoro convenzionale come retribuzione base — che di quelle quattro voci e' la somma. Prova su un turno da 7h15 con 6h40 di guida: componenti 195,75 €, retribuzione 195,75 €, totale 391,50 €, cioe' **54,00 €/ora contro i 27,00 dichiarati, esattamente il doppio**. Ora la retribuzione base copre solo il residuo (le soste fra riprese pesate, che nessuna componente addebita) e l'aliquota effettiva torna esatta. Due test la inchiodano.

Conseguenza da tenere a mente: **tutte le cifre assolute del lato guida dei giri precedenti sono circa il doppio del vero.** I confronti fra piani restano validi — la deformazione era uguale per tutti — ma il peso relativo cambia: la guida non e' il 72% del costo, e' circa il 56%, e un turno vale circa una vettura e mezza, non tre.

**Il costo vetture della relazione era al lordo.** La moneta onesta era arrivata al confronto fra round ma non al documento: la relazione leggeva `metrics.costEur` dello scenario, che comprende le penalita' d'arco. Sul giro BB erano 185,35 € di denaro inventato spacciato per spesa. Ora il documento le toglie e le dichiara in una riga del capitolo costi.

### Quattro analisi che il documento non raccontava

La relazione aveva nove capitoli e si fermava al risultato: diceva quante vetture e quanti turni, non **come** erano stati decisi ne' **che servizio** producevano. Ora sono undici:

- **5.9 Regola della sagoma** — che mezzo ha preso ogni blocco, corse declassate per linea, superamenti dei tetti, catene spezzate per rispettare la sagoma.
- **7. Il ciclo integrato** — i giri del ciclo con vetture, turni, violazioni, costo e la colonna «di cui ombra»; il **termometro** del feedback (massa delle penalita', spostamento dal giro prima, ancora, pressione sui cambi); la **sonda** con il controllo, la memoria, gli spostamenti accettati e i motivi dei rifiuti tradotti in italiano corrente invece che in gergo.
- **8. Coincidenze fra linee** — le relazioni che l'orario realizza davvero con gli orari di esempio, quelle mancate per poco, e per ogni linea la traslazione che ne guadagnerebbe di piu' col conto di quelle che romperebbe.

Per l'ultima ho estratto `coincidenceMapFor` dalla rotta delle coincidenze, cosi' la relazione la calcola da se' sullo stesso feed e sulla stessa data del piano. Se non ci riesce il documento esce lo stesso dicendo perche', e due test coprono il caso con le analisi e quello senza.

## Il prossimo intervento (superato dal precedente)

**Il prezzo dei km a vuoto nel VSP.** Vedi la catena qui sopra: la mossa del deposito e' gia' implementata e gratuita, ma non viene mai usata perche' il VSP evita i passaggi in deposito. Vanno prezzati al NETTO del corrispettivo (2,60 €/km incassati contro 0,75-1,20 di costo), tenendo come costo vero il tempo del conducente (27 €/ora), che e' l'unica cosa che si spende davvero. Attenzione a non ribaltare l'incentivo: se i km a vuoto diventano profitto il solver ne inventerebbe, e il freno deve restare il tempo pagato.

Togliendo questa causa si possono togliere anche le due medicine messe nella notte del 7-8 settembre, che rendono l'auto cara invece di renderla inutile:

- la maggiorazione di scarsita' `company_car_scarcity_eur` (20 €, PR #454);
- l'escalation delle penalita' sui giunti (×2,5 fino a ×8, PR #453).

## La prima relazione col capitolo 7 e' morta a meta', e perche'

Mergiata la #531, ho lanciato `ti_report` sul giro BB e la generazione si e' fermata con

```
TypeError: unsupported format string passed to dict.__format__
```

alla riga del termometro del ciclo. La causa e' semplice e istruttiva: **il dossier
della relazione e il cruscotto ricevono lo stesso dato in due forme diverse.** Il motore
scrive il feedback cosi'

```python
diag["afterRound"] = r
diag["ancora"] = {"round": ancora_r, "modo": penalty_anchor, "cambiInRegola": ancora_legale}
diag["distanzaDalPrecedenteEur"] = _penalty_distance(precedenti, arc_penalties)
```

e la rotta del cruscotto lo **appiattisce** prima di mostrarlo (`dopoRound`, `ancora` come
numero, `spostamentoEur`). Io avevo scritto il capitolo 7 leggendo la forma appiattita —
quella che si vede a schermo — mentre il dossier porta quella grezza. Il test passava
perche' avevo costruito il campione sulla forma sbagliata: **un test scritto sullo stesso
malinteso del codice non protegge da niente.**

Cercando la stessa famiglia ho trovato il secondo caso prima che esplodesse: l'analisi
delle coincidenze scrive l'attesa come oggetto (`attesaMin`: min, max, mediana) e il
capitolo 8 la cercava in tre campi piatti inesistenti. Non avrebbe ucciso il documento,
avrebbe solo svuotato le due colonne «Attesa» — un guasto peggiore, perche' silenzioso.

Tre rimedi, in ordine di forza:

1. **Due lettori che accettano entrambe le forme**, `_fb_termometro` e `_attesa`, con i
   campioni dei test riscritti sulla forma VERA del dossier piu' un test che verifica che
   le due forme diano gli stessi numeri.
2. **I formattatori non uccidono piu' la relazione**: `fmt_n` e `fmt_eur` passano da
   `_numero()`, che davanti a un oggetto, una lista o un booleano restituisce una cella
   vuota invece di sollevare. Una cella vuota e' un difetto da correggere; un documento
   che non esiste e' un'altra cosa.
3. **Ogni capitolo e' isolato**: `build()` monta i dodici capitoli attraverso `_capitolo()`,
   che cattura l'eccezione, scrive nel documento che quel capitolo non e' stato prodotto e
   perche', e lascia la traccia completa nei log. La relazione esce sempre.

Fuori strada ma trovato per via: `test_to_dict_keys` in `test_cost_model.py` era rosso
gia' su `main` — elencava le chiavi del costo turno e non conosceva `bds5Cost`, aggiunta
dopo. Corretto.

Nel passaggio ho anche portato nel dossier le **manopole del ciclo** (`ciclo`: passo,
ancora, seme, pazienza, controllo), che prima non ci arrivavano: il capitolo 7 ora apre
dichiarando le regole d'ingaggio del giro invece di lasciarle intendere dai numeri.

Lezione da tenere: **quando un dato passa da due strade diverse, il test va scritto sulla
strada che il codice percorre davvero, non su quella che si ha sotto gli occhi.**

## I tetti erano morbidi in due punti, e i due difetti si coprivano a vicenda

L'operatore ha guardato i turni del giro BB e ha detto che gli sembravano corti.
La verifica ha detto altro, e per strada ha trovato un difetto peggiore.

**Prima la verifica.** Lavoro medio 325' su 435: saturazione 74 %, monte lavoro
233 ore, che al tetto pieno starebbero in 32 turni contro i 43 del piano. Sembrano
undici turni di spreco. Ho provato a ricucirli: di **1 806 coppie una sola** e'
componibile (A006+A103, semiunico da 423'). Delle altre, 1 544 si sovrappongono nel
tempo — non sono buchi da riempire, sono lo stesso pezzo di giornata coperto da
persone diverse — e le restanti sfondano i tetti.

Il minimo vero non e' 32 ma **41**, e si legge vettura per vettura: ogni blocco e'
continuo, U001 dura 986' e vuole ⌈986/435⌉ = 3 conducenti, U006 ne dura 464 e ne
vuole 2 anche se ne basterebbe 1,07. **L'arrotondamento delle code costa 9,2 turni**,
ed e' li' che sono finiti gli undici che sembravano spreco. Il piano e' a due turni
dal minimo strutturale. Per scendere sotto servono piu' cambi in linea, e le auto
aziendali sono a 5/5 con 46 movimenti tutti fra le 12:24 e le 16:04.

**Poi il difetto.** A001 aveva 441' di lavoro contro un tetto di 435, e il giro
dichiarava zero violazioni. Due cause che si nascondevano a vicenda:

1. la scelta dei tagli **scontava** lo sforamento dal punteggio,
   `score -= max(0, worst - max_nastro) * 2`: un taglio che sforava di 6 minuti
   pagava 12 punti e vinceva lo stesso;
2. la validazione ammetteva una **franchigia** di 15' sugli interi e 5' sugli altri,
   cosi' il pezzo fuori norma che ne usciva risultava regolare. Il classificatore
   aveva lo stesso ripescaggio, messo apposta per non divergere dalla validazione.

Il gestore ha poi dettato le norme senza ambiguita': intero 435/435, semiunico
555/480 con interruzione di almeno 1h15 non retribuita, spezzato 630/450 con almeno
3 ore. **Nastri e lavoro non devono mai sforare.**

Sei interventi:

- `_nastri_dei_pezzi()`: un lettore unico del nastro di ogni pezzo, bordi compresi.
  Finche' la scelta dei tagli e il controllo finale facevano due conti diversi, un
  pezzo poteva passare la selezione e poi risultare fuori norma.
- `rango_dei_tagli()`: il nastro viene **prima** del punteggio, in tre tempi —
  dentro batte fuori, fra i fuori vince il meno fuori, a parita' il punteggio.
  Nessun punteggio compra piu' un minuto di nastro.
- `_best_three_cuts(..., max_nastro)`: **scarta** le terne fuori norma invece di
  penalizzarle, e ora scatta anche per il nastro. Prima scattava solo quando il
  tetto di guida per ripresa era acceso, e nell'urbano e' spento: non e' mai
  entrata in funzione su questa rete.
- Validazione: nessuna franchigia su nastro e lavoro.
- Classificatore: fuori tetto vuol dire **invalido**, niente ripescaggio. I due
  ora coincidono perche' nessuno dei due perdona, non perche' perdonano uguale.
- La **sosta di 15'** dentro l'intero passa da violazione ad avvertimento, e smette
  di essere una condizione di esistenza: un intero composto in regola per nastro e
  lavoro veniva scartato solo perche' non trovava dove mettere il quarto d'ora. La
  guida continuativa resta coperta dal RD 131, verificato a parte e inviolabile.

Lezione gemella di quella del dossier: **un test scritto sullo stesso malinteso del
codice non protegge da niente.** Il ripescaggio del classificatore esisteva per far
coincidere due controlli che divergevano; nessuno si era chiesto se il numero giusto
fosse quello morbido.

Da verificare col prossimo giro: i turni fuori norma che prima erano nascosti
emergeranno come violazioni finche' i tagli non si adeguano, e il rilassamento della
sosta apre combinazioni che prima erano vietate. Se il conto regge, il piano
dovrebbe restare intorno ai 41-43 turni ma con zero sforamenti veri.

## Giro BC: stesso piano, ma legale davvero

Primo giro coi tetti rigidi, parametri identici a BB perche' la sola differenza
misurata fossero quelli. Scenario `6fc385cc-2899-4b99-a80e-7e2d393b6227`.

|                                | BB          | BC          |
|--------------------------------|-------------|-------------|
| vetture                        | 21          | 21          |
| turni (interi/semi/spezzati)   | 43 (37/6/0) | 43 (37/6/0) |
| violazioni DICHIARATE          | 0           | 0           |
| **turni fuori norma VERI**     | **1**       | **0**       |
| nastro massimo di un intero    | 441' (A001) | 427' (A013) |
| auto aziendali simultanee      | 5 / 5       | **4 / 5**   |
| cambi in linea                 | 24          | 27          |
| cambi in deposito              | 6           | 3           |
| costo vetture                  | 5 874,91 €  | 5 617,66 €  |
| km a vuoto                     | 206         | 208,8       |
| corse declassate               | 141 (38,6%) | 105 (28,8%) |

Il costo guida NON e' confrontabile: BB ha girato prima del deploy che correggeva
il doppio conteggio, e portava dentro il tempo pagato due volte.

**Il taglio che e' cambiato.** Su U001 il primo pezzo andava da 05:50 a 13:11, cioe'
441 minuti contro un tetto di 435. In BC lo stesso blocco e' tagliato a 11:11: tre
pezzi da 321, 328 e 263 minuti. Il ranking rigido ha spostato il taglio di due ore
per farlo rientrare, ed e' l'unica cosa che poteva farlo — la penalita' da 2 punti
al minuto non bastava.

**Verificati tutti e 43 i turni contro i tetti**, uno per uno: nessuno sfora nastro,
lavoro o finestra di interruzione. Il massimo e' A013 a 427 su 435. I sei semiunici
stanno larghi: nastro massimo 496 su 555, lavoro massimo 356 su 480.

**L'auto che si e' liberata.** Era il vincolo che avevo indicato come l'unico saturo:
5 su 5 in BB, con 46 movimenti concentrati fra le 12:24 e le 16:04. In BC i movimenti
salgono a 52 ma il picco simultaneo scende a 4. Non l'ho cercato: viene dalla sosta
rilassata, che permette interi composti con stacchi brevi (A013 a 52', A106 a 33',
A014 a 15') dove prima serviva un semiunico o un turno in piu'.

**Quello che NON e' migliorato.** I turni restano 43, due sopra il minimo strutturale
di 41. Il conto della verifica regge: non era li' che c'era il margine.

**Quello che e' peggiorato, e va guardato.** I declassamenti calano nel totale ma si
concentrano: la 2/6 ha 24 corse su 52 con un mezzo piu' piccolo (46% contro un tetto
del 10%) e la **91 ne ha 18 su 24, il 75%**, con tutte e dieci le corse di punta
declassate. In BB i superamenti erano sulla 30 (19%) e sulla 42 (31%). E' un
peggioramento di qualita' del servizio su due linee, non un dettaglio: il piano
mette mezzi piu' piccoli su tre quarti della 91.

**La sonda** ha accettato 2 spostamenti (30 minuti) contro i 21 (300 minuti) di BB.
Con meno turni fuori norma da riparare, ha meno da comprare.
## Il capitolo della rete, rivisto con l'operatore

Rileggendo una relazione vera l'operatore ha indicato quattro cose. Le prime
quattro sono fatte; le altre due richiedono dati che ci sono ma vanno collegati.

**Il titolo.** «1. Sintesi per la direzione» diventa «1. Sintesi». Il capitolo
resta, il nome si accorcia.

**I nodi di interscambio erano sbagliati, non solo brutti.** Il dossier prendeva
`crew.clusters`, cioe' i cluster di TUTTA la rete aziendale. Su un piano di sole
linee urbane di Ancona la relazione elencava **73 nodi** fra cui Stazione Jesi,
Osimo Stazione, Chiaravalle Capolinea e Castelferretti — che nessuna di queste
linee tocca — e lo stesso posto tornava otto volte («Arco Clementino» ×8) o in
grafie diverse («Madonetta»/«Madonnetta», «Stazione Fs»/«Stazione F.S.»/«Stazione
FS»/«Stazione Ancna», «Piazza Ugo bassi»/«Pzz. U. Bassi»/«Ugo bassi»).

Ora il dossier tiene solo i cluster con almeno una fermata delle linee del piano,
e due cluster che raggruppano le stesse fermate diventano uno solo (a parita' si
tiene il nome scritto per intero). Il filtro e' sulle fermate, non sul nome: e'
per quello che regge anche dove la grafia diverge.

**I nodi si vedono.** `cluster_map()` disegna ogni nodo come un'area colorata —
il guscio convesso delle sue fermate — con dentro i punti delle fermate che
raggruppa, piu' la tabella di quali sono. Un nodo di interscambio non e' una
fermata: e' il gruppo di banchine fra cui un conducente passa a piedi per
cambiare vettura, e finche' era una parola in un elenco non si capiva.

**Ogni percorso ha la sua mappa.** Il disegno della rete tiene una variante per
linea o diventa illeggibile; il dossier ora porta anche `percorsi`, cioe' TUTTE
le varianti con verso, fermate e tracciato, e il capitolo 2.4 ne disegna una per
una. Per non gonfiare il documento i tracciati passano da `alleggerisci()`, che
tiene 160 vertici su migliaia mantenendo primo, ultimo e forma.

Capitolo 2 ora: 2.1 le linee, 2.2 i nodi, 2.3 il disegno della rete, 2.4 i
percorsi uno per uno.

### Quello che manca, e i dati che ci sono gia'

L'operatore ha chiesto anche la copertura pedonale per fermata con le isocrone,
la popolazione per sezione censuaria ISTAT, e che la relazione tenga conto del
traffico, di come si muove la popolazione e dei POI. Ho verificato: **i dati ci
sono tutti**.

- `census_sections` — codice ISTAT, centroide, **popolazione**, area, densita' e
  **geometria GeoJSON** della sezione;
- `points_of_interest` — provati sul campo: 49 POI veri entro 400 m da Piazza
  Cavour, da mapbox/tilequery;
- `istat_commuting_od` — la matrice dei pendolari del Censimento, comune→comune,
  per motivo (lavoro/studio), mezzo e fascia oraria: e' «come si muove la
  popolazione», ma a livello comunale, non di fermata;
- `traffic_snapshots` — velocita', velocita' libera e livello di congestione per
  segmento, con l'ora del rilievo;
- `isochrones.ts` — isocrone pedonali vere con cache su DB e ricaduta sul raggio
  in linea d'aria quando manca la chiave del provider.

Il nodo da sciogliere e' la forma, non il dato: **le fermate sono 595**. Una
mappa di isocrona per fermata vuol dire 595 mappe, che nessuno legge e che
gonfiano il documento oltre ogni misura. La forma sensata e' l'isocrona disegnata
per linea (tutte le fermate di quella linea sulla stessa mappa) piu' una riga per
fermata con la popolazione raggiunta a 5, 10 e 15 minuti a piedi.

## «Non si vede la mappa»: sfondo, colori veri, cerchi

Seconda tornata di correzioni sul capitolo della rete. L'operatore ha detto tre
cose, e due cominciavano con la stessa: **non si vede**.

**Il problema era il fondo.** Le mappe erano disegni vettoriali su un rettangolo
di colore piatto: un tracciato che attraversa il nulla non dice dove passa.
Sotto ogni mappa ora c'e' una **immagine cartografica vera** (Mapbox statico,
stile chiaro, con un velo del 26% sopra perche' i tracciati restino leggibili).

Il punto delicato non e' scaricare l'immagine, e' **allinearla**. Le mappe a
tasselli sono in Mercatore, il disegno era in equirettangolare: sovrapposti, i
tracciati scivolano rispetto alle strade. Ho sostituito la proiezione con
`proiettore()`, che lavora in Mercatore e restituisce ANCHE il riquadro da
chiedere allo sfondo, gia' allargato nelle proporzioni del disegno — perche'
Mapbox, se il riquadro ha proporzioni diverse dall'immagine, lo allarga per conto
suo e l'allineamento salta comunque. Un test verifica che il centro del riquadro
cada al centro del disegno.

Senza chiave o senza rete `sfondo_mappa()` restituisce stringa vuota e le mappe
tornano com'erano: **il documento non deve dipendere da un servizio esterno.**

**I colori sono quelli veri.** `ps_routes.color` porta la tinta con cui l'azienda
pubblica la linea: ora le mappe usano quella, non una presa dalla tavolozza. Il
bianco viene scartato (su fondo chiaro sparisce) e senza colore si ricade sulla
tavolozza come prima. Ogni tracciato ha un alone bianco sotto, che lo stacca
dalla mappa.

**I nodi sono cerchi, con i nomi dentro.** Erano gusci convessi senza etichette:
un nodo da due fermate diventava un segmento e non si capiva cosa contenesse. Ora
ogni nodo e' un cerchio colorato che racchiude le sue fermate, ciascuna col
proprio nome scritto accanto, e il nome del nodo sopra. Le etichette hanno un
alone chiaro, o sopra una mappa non si leggono.

**La copertura pedonale c'e', percorso per percorso.** Su ogni mappa di percorso
sono disegnate le isocrone a 10 minuti a piedi delle sue fermate — strade vere,
non raggio in linea d'aria — sotto il tracciato. Le isocrone costano una chiamata
a fermata: la cache su DB le rende gratuite dalla seconda relazione, e nel
frattempo c'e' un tetto di 140 richieste nuove per relazione, dichiarato nel
documento invece che nascosto. Senza provider il capitolo lo dice e va avanti.

### Resta da fare

I **pendolari**: l'operatore ha confermato che il livello comunale va bene, «chi
entra in Ancona e chi esce». Il dato e' in `istat_commuting_od` con motivo, mezzo
e fascia oraria; il comune del piano si ricava dai primi sei caratteri del codice
ISTAT delle sezioni censuarie vicine alle fermate. Mancano anche la popolazione
per fermata, il traffico e i POI nel capitolo.

## «Non ci siamo»: due difetti che lo sfondo non risolveva

L'operatore ha mandato due schermate della relazione. Erano generate dal deploy
che conteneva il primo giro di correzioni (nodi filtrati, una mappa per percorso)
ma NON il secondo (sfondo, colori veri, cerchi), quindi in parte mostravano
difetti gia' corretti e in attesa di merge. In parte no: due problemi restavano,
e lo sfondo da solo non li avrebbe tolti.

**La mappa d'insieme dei nodi non puo' mostrare le fermate.** Sette nodi sparsi
su venti chilometri: ciascuno e' un cerchio di dieci pixel, e i nomi delle sue
fermate — scritti accanto a punti che distano due pixel — si coprono a vicenda.
Nella schermata si vedeva «Via Bocconi (2)» disegnato come due aureole separate e
«Stazione F.S. (3)» come un trattino di sei pixel.

La risposta non e' disegnare meglio la stessa mappa, e' **separare le domande**:

- `cluster_map` risponde a «dove stanno i nodi»: sfondo, un cerchio per nodo con
  raggio minimo visibile, solo il nome del nodo;
- `nodo_map` risponde a «che cosa contiene questo nodo»: una mappa per ciascuno,
  zoomata sulle sue fermate, ognuna col proprio nome, alternando destra e
  sinistra perche' due banchine vicine non si coprano.

Le mappe di dettaglio stanno affiancate in una griglia che si adatta alla
larghezza. Il riquadro non scende sotto i **350 metri di lato**: sotto, lo sfondo
diventa un dettaglio di marciapiede senza riferimenti riconoscibili.

**Trentadue fermate non possono avere trentadue nomi.** La soglia che avevo messo
(nomi fino a 22 fermate) era comunque troppo alta, e sopra la soglia le fermate
restavano puntini anonimi. Ora sopra le dieci fermate il percorso le **numera**
lungo il tracciato — un cerchietto bianco col numero — e sotto la mappa c'e'
l'elenco ordinato. Il nome di ogni fermata resta leggibile, solo non e' piu'
scritto sopra il disegno.

Lezione: quando una figura deve rispondere a due domande a scale diverse, non e'
il disegno a essere sbagliato, sono due figure.

## Sotto ogni percorso: la gente e i poli, non l'elenco delle fermate

«Per ogni linea, sotto non mi serve l'elenco delle fermate, ma mi serve quanta
popolazione potrebbe acchiappare e tutti i POI serviti, per categoria.»

Ha ragione, e la ragione e' semplice: **l'elenco delle fermate non dice niente
che la mappa non mostri gia'**. Quello che la mappa non puo' dire e' quanta gente
quel percorso ha a portata di piedi e che cosa le porta vicino — cioe' il motivo
per cui la linea esiste.

`coperturaDeiPercorsi()` conta **dentro le isocrone gia' calcolate**, non entro un
raggio in linea d'aria: per ogni percorso, le sezioni censuarie il cui centroide
cade nell'area raggiungibile a piedi dalle sue fermate, e i POI che ci stanno
dentro, raggruppati per categoria. Una sezione o un POI contano **una volta sola**
per percorso, anche quando piu' fermate li raggiungono entrambe.

Il conto e' su decine di percorsi per centinaia di sezioni e migliaia di POI, e il
test punto-in-poligono non e' gratis: prima si scarta col rettangolo che contiene
l'isocrona (`riquadroDi`), che costa quattro confronti, e solo chi passa quel
filtro paga il test vero.

Sotto ogni mappa ora ci sono due riquadri — popolazione raggiunta con quante
sezioni, poli serviti con quante categorie — e la tabella dei POI per categoria.

Tolta la numerazione delle fermate introdotta poco prima: senza l'elenco sotto la
mappa un numero sul puntino non dice piu' niente, e il codice morto non si lascia
in giro. I nomi restano nel tooltip, e sono scritti sulla mappa quando le fermate
sono dieci o meno.

## Il territorio: chi si muove, e quanto sono trafficate le strade

Ultimo pezzo del capitolo della rete: **2.5 Il territorio e come si muove**.

**I pendolari.** `istat_commuting_od` e' la matrice del Censimento: per ogni
coppia comune-origine → comune-destinazione, quante persone si spostano, per
quale motivo, con quale mezzo, in quale fascia oraria. La relazione ora dice chi
entra ad Ancona, da dove, come e a che ora; chi esce; e quanti si spostano dentro
il comune.

Il comune del piano non e' configurato da nessuna parte: si ricava dai dati. Le
prime sei cifre del codice ISTAT di una sezione censuaria sono il comune, quindi
si prende il comune piu' rappresentato fra le sezioni sotto le fermate.

I codici del Censimento (`car_driver`, `before_715`, `bus_urban`) sono tradotti in
italiano corrente, e c'e' un test che verifica che quelli grezzi **non** compaiano
nel documento.

La cosa che conta di piu' e' scritta nel capitolo, non lasciata intendere: il dato
e' a livello **comunale**, dice chi si sposta fra comuni e non chi sale a una
fermata. E' il **bacino potenziale, non la domanda servita** — la differenza fra
una relazione onesta e una che millanta.

**Il traffico.** `traffic_snapshots` porta velocita' reale, velocita' a strada
libera e congestione per segmento, con l'ora del rilievo. Il capitolo mostra la
velocita' ora per ora (reale contro strada libera) e i dodici segmenti peggiori.
Serve a dire perche' i tempi di percorrenza del quadro orario sono quelli: la
congestione non e' un dettaglio di contorno, e' cio' che decide quanto dura una
corsa e quindi quante vetture servono.

Entrambi sono in `analisi.territorio` e ognuno ha il suo try/catch: se il dato
manca, il capitolo non compare e il resto della relazione esce lo stesso.

## Quattro ritocchi, e le coincidenze diventano un documento

**Mezza rete mancava.** Il disegno della rete prendeva solo `direction === 0`:
mostrava le andate e non i ritorni, e i rami che esistono in un verso solo
sparivano del tutto. Ora ci sono tutte le varianti; la legenda deduplica per
(nome, colore), altrimenti ogni linea compariva due volte.

**«10' a piedi» ripetuto in ogni legenda.** Il minutaggio della copertura
pedonale si dice una volta nel cappello del capitolo — «vale per tutte le mappe
che seguono» — e sparisce dalle legende. Resta nel tooltip dell'area.

**Le categorie dei POI si vedono.** Un elenco di numeri non fa capire che una
categoria pesa quanto tutte le altre messe insieme; le barre orizzontali si'. La
tabella resta, dentro il riquadro richiudibile della figura.

### Le coincidenze, in tre dimensioni e a libretto

Dopo l'elenco delle linee la cosa che conta sono le coincidenze, e finora la
relazione ne dava solo il conteggio. Due aggiunte.

**Il libretto orario (8.4).** Per ogni relazione riconosciuta, i passaggi uno per
uno: la corsa che arriva, quella che riparte, i minuti di attesa. Serviva
cambiare `coincidence_analysis.py`, che teneva tre campioni e buttava il resto:
ora c'e' `passaggi` con fino a 60 passaggi e i minuti in chiaro, perche' un
diagramma possa collocarli nella giornata senza ri-analizzare le stringhe. E'
il documento che un capo movimento legge davvero: «tre volte al giorno» non
basta al banco, servono gli orari.

**Il diagramma in assonometria.** Il piano e' la citta' vista dall'alto, l'asse
verticale e' l'ora del giorno. Sopra ogni nodo si alza una colonna e ogni
incontro fra due linee e' un anello all'altezza della sua ora, colorato per linea
in arrivo. Si legge in un colpo solo **dove** la rete si connette e **quando**:
una colonna fitta in alto e vuota in basso e' un nodo che funziona di sera e non
la mattina; un nodo senza anelli e' un nodo che nessuno usa per cambiare.

Le posizioni dei nodi si ricavano dalle fermate del piano per nome. Se non si
ritrovano, il disegno non esce e il libretto resta: **il libretto non dipende
dalla geografia**, e c'e' un test che lo verifica.

## Il diagramma che non si vedeva, e i simboli delle categorie

**«Non vedo nessun diagramma sulle coincidenze».** Il codice era mergiato, quindi
o la relazione era anteriore al deploy, o qualcosa lo faceva sparire in silenzio.
Cercando il secondo caso l'ho trovato.

Il diagramma prende gli orari da `passaggi`, il campo nuovo, e ricade su `sample`
quando manca. Ma **`sample` non ha i minuti**: porta solo la stringa `"08:12"`.
Il codice leggeva `pg.get("arrivoMin")`, trovava `None`, faceva `continue` — e
con tutti i passaggi scartati non restava nessun incontro, quindi nessun disegno,
**senza una riga che lo dicesse**. Una relazione prodotta prima del campo nuovo
non poteva avere il diagramma, e non si capiva perche'.

Due rimedi:

- `_minuti_da_ora()` legge i minuti da un numero **o** da una stringa `"HH:MM"`,
  cosi' anche il vecchio campione produce il disegno;
- quando il diagramma davvero non si puo' fare, il capitolo **lo dichiara col
  motivo** («nessuna delle fermate-nodo si ritrova fra quelle del piano», oppure
  «i passaggi non portano l'ora dell'incontro»), e se solo alcuni nodi mancano li
  elenca sotto la figura. Un vuoto in mezzo a un capitolo non si distingue da un
  difetto: dichiararlo e' la differenza fra un documento diagnosticabile e uno da
  indovinare.

**I simboli delle categorie.** Le categorie dei POI arrivano dai dati, sono
decine e in inglese: `famiglia_poi()` le raggruppa in otto famiglie riconoscibili
(sanita', istruzione, commercio, ristorazione, trasporti, servizi pubblici,
cultura e svago, lavoro e servizi) e cio' che non si riconosce finisce in
«altro», che e' un'informazione anche quella.

Ogni famiglia ha **forma e colore**: croce, triangolo, quadrato, cerchio, rombo,
esagono, stella, quadrato ruotato. Le forme sono distinte apposta, perche' la
relazione si stampa e in bianco e nero il colore da solo non basta.

## «Non si vede»: smettere di indovinare

L'operatore ha mandato il link di una relazione e tre parole. Ho provato la
richiesta a Mapbox da qui per riprodurre: il proxy di questo ambiente la blocca
con un 403, quindi **non posso riprodurre il caso**. Invece di tirare a indovinare
ho reso il sistema capace di dirlo da solo, e ho corretto i tre difetti che si
vedono leggendo il codice.

**Lo sfondo taceva.** `sfondo_mappa()` restituiva una stringa vuota sia quando la
chiave manca, sia quando la rete fallisce, sia quando Mapbox rifiuta: il
documento mostrava un rettangolo grigio identico in tutti i casi, e l'unico modo
di sapere quale fosse era leggere i log del server. Ora restituisce `(uri,
motivo)` e il motivo finisce **nella nota sotto la figura**: «Sfondo cartografico
non disponibile (nessuna chiave Mapbox configurata sul server)». Una mappa senza
strade e un errore di rete non si assomigliano piu'.

**La chiave aveva due nomi.** Il codice del server legge `MAPBOX_ACCESS_TOKEN`,
`DEPLOY.md` documenta `MAPBOX_TOKEN`. Accettarli entrambi costa una riga e toglie
di mezzo un'intera classe di «non si vede».

**Il documento pesava troppo.** Decine di mappe con lo sfondo a piena risoluzione
fanno un HTML da parecchi megabyte: il browser arranca o rinuncia. Ora l'immagine
si chiede a **meta' risoluzione** e la si lascia scalare all'SVG — un quarto del
peso, differenza quasi invisibile — con un tetto di 60 sfondi per relazione. Il
velo sopra l'immagine e' sceso dal 26% al 18%, perche' schiariva troppo.

**`href` da solo non basta.** L'immagine ora porta anche `xlink:href`: i browser
usano il primo, ma chi converte in PDF spesso si ferma a SVG 1.1 e vede solo il
secondo. Senza, la mappa spariva proprio nella stampa.

Resta da capire che cosa l'operatore non vedeva davvero: la prossima relazione lo
dira' da sola.

L'operatore ha poi chiarito: **le mappe si vedono benissimo, manca solo il
diagramma delle coincidenze.** Quindi lo sfondo funziona e i tre difetti qui
sopra erano reali ma non erano *quel* problema.

## Il diagramma dipendeva dalla geografia, e non doveva

Il disegno cercava le coordinate di ogni nodo fra le fermate del piano, e se non
le trovava **spariva del tutto**. Ma la geografia serve solo a DISPORRE le
colonne: l'informazione vera — quali linee si incontrano, dove e quando — c'e'
comunque. Far dipendere l'esistenza del disegno da un dettaglio della sua forma
era l'errore.

Ora i nodi di cui non si conosce la posizione **si dispongono in cerchio**, e la
nota sotto la figura lo dichiara: «nel disegno sono disposti in cerchio, gli
orari e le linee restano quelli veri». Il diagramma esce sempre.

Resta un solo caso in cui non si puo' fare: quando nei dati non c'e' l'ora degli
incontri. Li' il capitolo lo scrive.

Il test `test_il_diagramma_esce_con_qualunque_forma_degli_orari` prova tutte e
tre le forme che gli orari possono avere nel dossier (passaggi col minuto,
passaggi con la sola stringa, vecchio `sample`), perche' **una relazione non si
spiega all'operatore con «dipende da come e' stato salvato il dossier»**.

Il matching dei nomi chiede ora almeno quattro caratteri prima di accettare un
prefisso: con nomi cortissimi una fermata qualsiasi poteva rubare il nodo.


## Il diagramma sbagliato: disegnavo le coincidenze, non le corse

L'operatore ha mandato tre immagini di riferimento accanto alla mia. La
differenza non era di stile.

**Nel riferimento** ogni corsa e' una **traiettoria** che si muove sul territorio
mentre l'orologio avanza: decine di curve parallele che salgono, ciascuna del
colore della sua linea, con l'ombra del percorso sul pavimento. Si vede il
servizio scorrere.

**Nel mio** c'erano colonne verticali con degli anelli infilati: **solo i punti di
incontro**. E' come raccontare un viaggio elencando le coincidenze e tacendo il
percorso.

L'errore non era il disegno, erano **i dati che gli davo**. Il dossier non portava
gli orari delle corse, quindi l'unica cosa disegnabile erano gli incontri.

`corseNelTempo()` estrae ora, per ogni corsa, dove passa e a che ora — da
`ps_trips` + `ps_stop_times` + `ps_stops`. Si tengono al massimo 420 corse, e di
ciascuna un punto ogni due fermate: a quella scala due fermate vicine cadono
sullo stesso pixel. Quando le corse sono piu' del tetto **si diradano nel tempo
invece di tagliare la coda**, o il disegno coprirebbe solo il mattino.

`spazio_tempo()` le disegna: pavimento in assonometria col territorio, altezza
per l'ora, i piani delle ore a dare profondita', ogni corsa una curva col colore
della sua linea e la sua ombra sul pavimento. Le coincidenze riconosciute sono
cerchi bianchi sulle traiettorie. Fondo scuro, come nel riferimento: e' l'unica
figura della relazione che lo usa, e regge il confronto.

Il disegno vecchio resta come **ricaduta**: se un dossier non ha le corse, meglio
i soli punti d'incontro che niente, e il documento dichiara che sono quelli.

Lezione: quando una figura non assomiglia a quello che deve mostrare, prima di
ritoccare gli angoli conviene chiedersi **se le si stanno dando i dati giusti**.

## Due linee alla volta

Il diagramma spazio-tempo con tutte e diciassette le linee insieme e' un
groviglio: le curve si coprono e non si distingue piu' niente. Nelle immagini di
riferimento, infatti, i colori sono **due**.

Ora c'e' **un diagramma per ogni coppia di linee che si incontra**, con le sole
corse di quelle due e i loro incontri. Le coppie si contano come relazioni non
ordinate — 3→1/4 e 1/4→3 sono la stessa relazione vista nei due versi — e si
disegnano le dieci con piu' incontri.

Le linee nel titolo si ordinano col **numero, non con l'alfabeto**: altrimenti
usciva «24 e 3» e «1/4» finiva prima di tutto. `ordine_di_linea()` prende il
primo numero che compare nel nome e a parita' ordina per nome intero, cosi'
l'ordine e' quello di un quadro orario.

## Un documento che si consegna

Quattro richieste dell'operatore, tutte sullo stesso tema: la relazione non e'
una schermata, e' una cosa che esce dall'azienda.

**Fondo chiaro anche per il diagramma spazio-tempo.** L'avevo fatto scuro come le
immagini di riferimento, ma quelle erano schermate di un applicativo: dentro un
documento una figura nera stona e si stampa male. Ora il fondo e' quello di tutte
le altre, le traiettorie hanno un alone bianco per staccarsi e le coincidenze
sono cerchi bianchi bordati di inchiostro invece che bianchi su nero.

**Le coincidenze si leggono per NODO.** L'operatore le ha elencate cosi': «1/4 e
44 in Piazza Cavour e Tavernelle», «2/6 con 21/33 al Pinocchio», «3 con 21/33 a
Posatora». Sempre il posto, poi le linee — perche' il nodo e' dove uno cambia e
le linee sono quello che ci trova. Il nuovo **8.1 «Dove si cambia, e fra quali
linee»** e' organizzato in quel modo: per ogni nodo, le linee che vi si
incontrano, quante volte al giorno e con che attesa, piu' le barre dei nodi per
numero di incontri. Il capitolo si rinumera: 8.1 nodi, 8.2 relazioni, 8.3 mancate
per poco, 8.5 traslazioni, 8.6 libretto orario.

**Un turno per foglio.** Gli allegati sono fatti per essere staccati e
consegnati: ogni turno macchina e ogni turno guida sta in un `section.foglio` che
a schermo e' un riquadro e in stampa **comincia a pagina nuova e non si spezza
mai a meta'**.

**La pagina e' brandizzata.** La copertina era un titolo e una riga di metadati;
ora e' un frontespizio: marchio con l'azienda a sinistra e il prodotto a destra,
titolo, occhiello, e una griglia di voci — progetto, unita' di validita', giorno
di servizio, giorno-tipo, scenario, chi l'ha redatta, quando — piu' l'indice.
In stampa la copertina occupa la sua pagina e i margini sono quelli di un
documento (16/14/18 mm).

## Il foglio turno e' uno solo

L'operatore: «i turni li devi formattare come la funzione fucina -> turni guida
-> esporta -> Fogli turno (uno per pagina)». Non era una richiesta di stile: la
relazione produceva **un secondo documento** per la stessa cosa. Chi guida
riceve il foglio della Fucina; chi legge la relazione ne vedeva un'altra
versione, con una tabella al posto della scheda. Due documenti per lo stesso
turno sono un documento di troppo.

Gli allegati ora sono **gli stessi fogli**, rifatti in Python leggendo
`DriverShiftSheetExport.ts` riga per riga:

- **intestazione**: matricola grande, deposito, tipo del turno, giorno-tipo; a
  destra NASTRO, PRESENTAZIONE, CORSE;
- **banda del programma** con lo scenario e «in vigore dal», data all'italiana;
- **corpo**: le corse come schede — linea nel bollino verde, TM e tipo di mezzo
  sotto, orari grandi ai due capi, durata sulla freccia, punti orari sotto —
  con `SOSTA n'` fra una corsa e l'altra e `INTERRUZIONE hh:mm – hh:mm` fra un
  pezzo e l'altro; pre-turno, trasferimenti, fuorilinea e cambi vettura come
  righe;
- **piede**: COMPETENZE / NASTRO / LAVORO / INTERRUZIONE, e le note con i
  richiami (le violazioni BDS entrano qui, col richiamo `!`).

I turni macchina prendono la stessa intestazione e lo stesso piede, ma il corpo
resta una tabella: una vettura fa venticinque corse, e venticinque schede non
stanno su un foglio.

**Mancavano i dati, non il disegno** (di nuovo). Il foglio vero porta i passaggi
ai punti orari, che il dossier non aveva: `passaggiDelleCorse()` in
`process-report.ts` li legge per le sole corse dei turni guida, tiene i
`timepoint` quando ci sono e ne conserva al massimo otto per corsa, perche' il
dossier finisce in archivio. Senza, il foglio esce lo stesso con partenza e
arrivo — come fa l'originale quando il caricatore non risponde.

Un dettaglio che si vede solo stampando: gli orari del foglio sono a **due
cifre** (`_hhmm`, 07:58 e non 7:58), altrimenti le colonne non si incolonnano.

## Le coincidenze: il disegno era sbagliato in partenza

L'operatore: «sulle coincidenze non sono affatto soddisfatto, in fase di
esportazione della relazione fai decidere le linee che vuoi vedere le
coincidenze e cambia metodo di visualizzazione, non si capisce niente».

Il diagramma assonometrico era arrivato in fondo a una serie di correzioni —
fondo scuro, poi chiaro; tutte le linee, poi due alla volta — e nessuna aveva
toccato il difetto vero: **faceva vedere la geografia, che si sa gia', e
nascondeva la domanda**. Un capo movimento non chiede «dove si incontrano le
linee», chiede **a che ora** e **quanto si aspetta**. Nessuna proiezione
assonometrica risponde a quelle due domande, per bene che la si disegni.

Al suo posto due disegni piani, uno per domanda:

- **8.2 Quando si puo' cambiare** — una riga per relazione, una colonna per ora
  del giorno, la casella tanto piu' scura quante sono le coincidenze di
  quell'ora. Il buco di meta' pomeriggio si vede a occhio, e il totale da solo
  non lo distingue da una relazione distribuita su tutta la giornata.
- **8.3 Quanto e' buono ogni cambio** — un disegno per relazione, affiancati: in
  orizzontale l'ora, in verticale i minuti di attesa, la fascia chiara e' la
  finestra utile letta dal dossier. Un punto sopra la fascia e' un'attesa
  lunga, uno sotto e' un cambio da prendere di corsa.

Via `spazio_tempo`, `coincidenze_3d` e `_asse_assonometrico`; via anche
`corseNelTempo` e il campo `network.corse` nel dossier, che esistevano **solo**
per alimentare quel disegno e pesavano in archivio 420 corse per relazione.

**La scelta delle linee.** Il capitolo con diciassette linee dentro non si
legge, e chi esporta sa gia' quali relazioni gli interessano. Un dialogo prima
di generare (`ReportOptionsDialog`, montato nei due punti da cui la relazione
nasce: area turni macchina e step VCSP), il campo `coincidenzeLinee` nella
POST e nel tool `ti_report`. La regola e' una sola ed e' scritta anche nel
documento: due o piu' linee scelte, le relazioni con **tutti e due** i capi
dentro; una sola, tutte le sue; nessuna, tutta la rete.

Il taglio e' **del documento, non del dato**: `lineeScelte` viaggia nel dossier
accanto alla mappa delle coincidenze, che resta intera in archivio. Una
relazione ristretta si puo' rigenerare larga; un dossier tagliato no.

## «Non hai generato nessun grafico delle coincidenze»

E aveva ragione. I due disegni nuovi leggevano `passaggi`, e sui dati veri quel
campo **non arriva mai**: `esistenti` non lo produce `coincidence_analysis.py`,
lo produce `vcsp_probe.detect_coincidences`, che emette tre campioni (`sample`)
con l'ora in stringa. Il capitolo perdeva **tutti e tre** i pezzi — 8.2, 8.3 e
il libretto 8.7 — e non lo diceva.

**E' la terza volta che sbaglio nello stesso modo**, e stavolta va scritto
chiaro perche' non succeda una quarta:

> Quando una figura non esce, il primo sospetto non e' il disegno: sono i dati.
> E quando scrivo il campione di prova **guardando il mio codice** invece che
> l'uscita del produttore vero, il test passa e il difetto arriva in
> produzione. Era gia' successo col termometro del ciclo (`ancora` oggetto vs
> numero) e col diagramma spazio-tempo (`arrivoMin` assente). Il rimedio non e'
> «stare piu' attento»: e' che il test parta da `detect_coincidences(corse)`,
> non da un dizionario scritto a mano.

Cosa e' stato fatto, dopo quattro accertamenti in parallelo ciascuno confutato
da un revisore avverso (due verdetti su quattro sono stati ribaltati dalla
confutazione, e avevano ragione i confutatori):

1. **`detect_coincidences` emette il libretto.** `passaggi` con l'ora di ogni
   incontro, cap `PASSAGGI_MAX = 60`, **campionato a passo costante** e non
   troncato in testa — troncare fermava il libretto a meta' pomeriggio per una
   relazione che arriva a sera. Senza `fromTrip`/`toTrip`: nessun documento li
   stampa e due uuid per riga raddoppiavano il peso.
2. **`attesaMin` oggetto, con l'attesa VERA.** `maxWaitMin`/`minWaitMin` sono
   **le soglie della ricerca**, uguali per ogni relazione: la colonna «Attesa»
   del capitolo 8.4 diceva «2–5′» su ogni riga come se fosse una misura.
3. **Il libretto non entra nel canale della sonda** (`vcsp_probe.py`): quella
   sezione finisce nella vista compatta del giro, che l'MCP tronca a 40k e che
   viene archiviata a ogni giro — ed era gia' arrivata troncata una volta.
4. **Niente piu' silenzio.** `passaggi_di()` normalizza le due forme in una
   sola (minuti sempre numerici) e ricade sui campioni; `_niente_disegno()`
   dichiara nel documento perche' una figura manca. Il test che sanciva il
   silenzio come corretto e' stato **tolto**: era la regola sbagliata.
5. **8.7 non contraddice piu' 8.4**: col libretto troncato diceva «60 passaggi
   al giorno» mentre la tabella sopra diceva «84 volte al giorno».
6. **Il canale MCP** (`argos`): `_a_misura` toglie `passaggi` come `analyze()`
   toglie `pairs`, lasciando i campioni e il conteggio. Questo era un difetto
   **preesistente**: sulla rete vera `section='mancate'` restituiva 8 voci su 36
   e la nota diceva solo «mostrate 8 su 36». Ora 36/36 e 10/10.
7. **Il guardiano non guardava**: `smoke_coincidences_section.py` costruiva gli
   `esistenti` col solo `sample`, quindi restava verde mentre la rete vera si
   accorciava. Ora il fixture porta il libretto.

## Nell'elenco delle linee c'erano i fuorilinea

L'operatore, aprendo il dialogo della relazione: «ci sono voci che non servono.
Toglile». Erano «Uscita Ancona (1.2 km)», «Rientro Ancona (1.1 km)», «Vuoto
(2.1 km)»: il mio estrattore prendeva `routeName` da TUTTE le corse del turno
macchina, e il motore da' un nome anche ai fuorilinea. Di una coincidenza fra
due fuorilinea non esiste il concetto.

Peggio: `ordineDiLinea` estrae il primo numero del nome, quindi «Rientro Ancona
(1.1 km)» finiva ordinato accanto alla 1/4 e le linee vere sparivano sotto il
bordo dell'elenco.

La regola sta ora in **un posto solo** — `lineeDelPiano()` in
`ReportOptionsDialog.tsx` — perche' i punti da cui la relazione nasce sono due e
il terzo che qualcuno aggiungera' non deve ripetere l'errore. Due segnali, tutti
e due autorevoli: il `type` dichiarato dal motore (`deadhead` e `depot` non sono
corse) e il `routeId`, che sulle voci sintetiche e' sempre vuoto — cosi'
l'elenco regge anche sugli scenari salvati prima che il `type` esistesse.

Le etichette nascono in `vehicle_scheduler_cpsat.py:3313` e `:3327` (uscita e
rientro deposito) e `:3052` (vuoto fra due corse), piu' «Rientro deposito» in
`service-program.ts:909`.

## La regola del filtro era una mannaia, e i colori non avevano legenda

Due rilievi dell'operatore sulla relazione generata: «non vedo tutte le
coincidenze selezionate» e «usa colori con legende per renderlo piu'
comprensibile».

**Il filtro.** La regola «tutti e due i capi dentro la scelta» l'avevo scelta io
ragionando sul caso astratto, e sulla rete vera e' una mannaia. Delle dieci
relazioni del festivo di Ancona, spuntando 1/4, 2/6, 3, 21/33, 44 e 43 ne
restava **UNA** — la Madonnetta 2/6→21/33 — perche' le altre nove hanno un capo
sulla 11, sulla 31 o sulla 7, che l'operatore non aveva spuntato. Ma chi spunta
la 2/6 chiede «le coincidenze della 2/6», e la 2/6 con la 11 **e'** una
coincidenza della 2/6. Ora basta che una linea scelta tocchi la relazione:
1 su 10 → **7 su 10**.

Il banner del capitolo dice la regola in chiaro («si tiene ogni relazione che
tocca una di queste linee, anche quando l'altro capo e' una linea non scelta»)
e nomina le linee scelte che non compaiono in **nessuna** relazione: sparire dal
capitolo e non fare coincidenze si assomigliano troppo, e senza scriverlo
l'operatore non puo' distinguerli — ne' puo' accorgersi di un nome che non
combacia.

Lezione, la stessa di sempre in una forma nuova: **una regola scelta sul caso
astratto va misurata sul caso vero prima di spedirla**. «Tutti e due i capi» e'
difendibile in astratto; su dieci relazioni vere taglia il 90%.

**I colori.** La griglia era una scala di azzurri senza legenda: un azzurro piu'
scuro non significa niente finche' qualcuno non lo dice. Ora codifica due cose
dichiarate tutte e due: la **tinta e' il nodo** (una per nodo, assegnate per
peso decrescente) e l'**intensita' e' quante coincidenze** ci sono in quell'ora.
I disegni di 8.3 usano la **stessa tinta per lo stesso nodo**, cosi' si ritrova
la relazione fra le due figure, e portano la legenda dei tre colori dei punti
— dentro la finestra, attesa lunga, cambio stretto — una volta sola sotto il
primo, non dodici volte.

## SOLO fra le linee scelte, e una legenda che non menta

Due correzioni sopra le due di prima, e tutte e due sono colpa mia.

**Il filtro: avevo letto male.** Al rilievo «non vedo tutte le coincidenze
selezionate» avevo risposto allargando la regola a «basta che una linea scelta
tocchi la relazione». Sbagliato: l'operatore ha poi dettato la regola in
chiaro — «devo vedere coincidenze SOLO tra linee che seleziono». Spuntando 3,
2/6 e 21/33 vedeva anche la 2/6 con la 11, la 3 con la 31 e la 2/6 con la 7.
Si torna a **tutti e due i capi dentro la scelta** (con una linea sola si
tengono le sue, altrimenti il quadro sarebbe sempre vuoto).

Ma la regola da sola non basta, perche' il primo rilievo nasceva da li': con tre
linee scelte resta UNA relazione e non si capisce se il quadro non ne fa altre o
se il filtro le ha tolte. Ora il capitolo scrive **quale linea non spuntata
tiene fuori quante relazioni** («31 (2), 11 (2), 7 (1) — se ti servono,
aggiungile ed esporta di nuovo»). Il dubbio diventa una decisione.

**La legenda mentiva, ed era un difetto vero.** Il colore «cambio dentro la
finestra» lo prendevo dalla tinta del NODO, ma la legenda si stampa una volta
sola sotto il primo disegno: diceva arancione mentre i punti di Posatora erano
blu e quelli della Madonnetta verdi. Due sistemi di colore sovrapposti e uno
solo spiegato.

Ora i punti hanno un **colore fisso** che vuol dire sempre la stessa cosa in
tutti i disegni; la tinta del nodo resta ma sul **titolo**, come fascetta, dove
non compete con niente. Stesso difetto nella griglia: la scala dell'intensita'
era mostrata con pastiglie NERE accanto a caselle arancioni e blu. Ora la scala
si mostra nel colore di un nodo vero, dichiarando che vale per ogni tinta.

Regola generale, da non dimenticare: **un colore in legenda deve voler dire
sempre la stessa cosa in tutte le figure della pagina.** Se varia per figura,
la legenda va sotto ogni figura o non ci va affatto.

## «Ho selezionato 3 linee e ne vedo solo 2»

Il filtro non era rotto: sul festivo di Ancona le uniche coincidenze della **3**
sono con la **31**, che l'operatore non aveva spuntato. Con la regola «tutti e
due i capi dentro la scelta» la 3 non entra da nessuna parte, e il capitolo non
lo diceva.

Difetto mio, e preciso: il controllo delle «linee che non compaiono» lo facevo
sull'elenco **prima** del filtro. La 3 compare in POSATORA 31→3, quindi non
veniva mai segnalata come assente — pur essendo sparita dal documento.

Ora in cima al capitolo c'e' un quadro **riga per riga per ogni linea scelta**:
quante relazioni entrano, quante restano fuori, e il motivo con la mossa da
fare («le sue coincidenze sono solo con 31: spunta anche quella e riesporta»).
Piu' la frase che risponde alla domanda che uno si fa davvero: «delle 3 linee
scelte ne compaiono 2».

Lezione: **«il filtro funziona» e «si capisce cosa ha fatto» sono due cose
diverse, e la seconda e' quella che conta.** Tre giri persi su questa
funzione — allargata, ristretta, rispiegata — sono finiti tutti sullo stesso
punto: il documento non diceva perche' mancava qualcosa. Ogni volta che un
filtro toglie roba, deve dire che cosa ha tolto e come riaverla.

## Duplica corsa nel grafico (orario grafico, Planner Studio)

Richiesta dall'operatore mentre lavorava sul grafico: cliccando una corsa,
nella barra degli strumenti serve il tasto **Duplica**.

La cosa da capire prima di scrivere una riga e' che **il grafico lavora in
locale**: spostamento, eliminazione e anche il Ctrl+C/Ctrl+V che gia' c'era
sono modifiche pendenti, confermate con «Salva modifiche» e disfatte con
Ctrl+Z. Un duplica che scrivesse subito sul server sarebbe l'unica cosa della
pagina a non passare di li'. Quindi il pulsante crea una **copia locale**, che
alla conferma eredita validita' e categorie dall'originale perche' il
salvataggio manda `baseTripId`.

**Dove mette la copia**: a meta' strada fra la corsa duplicata e la successiva
dello stesso percorso. E' la mossa vera quando si duplica — infittire fra due
corse — e non finisce mai sopra una corsa che c'e' gia'. Verificato sulle
partenze vere della linea 3: a cadenza 30′ la copia cade sempre a +15. Senza
una corsa dopo, +60, come fa gia' Ctrl+V quando non sa dove puntare.

**Difetto preesistente trovato per strada**: duplicando una copia, `baseTripId`
puntava a un id locale (`copy-…`) che sul server non esiste. Col pulsante
diventa facile da innescare, perche' dopo il duplica la copia resta
selezionata e il secondo clic duplica lei. `corsaVeraDi()` risale la catena
fino alla corsa reale, e la correzione vale anche per Ctrl+V, che aveva lo
stesso buco da prima.

## Eliminare le corse nel grafico, e un salvataggio che si perdeva tutto

L'operatore: «devo avere la possibilita' di eliminare anche delle corse». Il
tasto **🗑 Elimina** nella barra c'era gia' — ma cercando il motivo per cui non
gli bastava e' saltato fuori un guasto vero nel salvataggio.

**Il guasto.** `saveAllOps` faceva
`for (const id of deletedTripIds) await deletePsTrip(projectId, id)` su TUTTI
gli id, comprese le copie locali. Duplico una corsa, ci ripenso, la elimino,
salvo: il server riceve `deletePsTrip("copy-1789…")`, risponde «non trovata»,
l'eccezione finisce nel catch e **non si salva piu' niente** — nemmeno gli
spostamenti buoni fatti prima. Tre clic per perdere il lavoro, e col pulsante
Duplica appena aggiunto era banale arrivarci.

Ora si cancellano solo le corse che sul server esistono davvero: una copia
locale scartata non va cancellata, basta non crearla (il filtro che gia' c'era
al punto 2). Anche il conteggio nel messaggio finale diceva il numero
sbagliato.

**Il resto.** `eliminaCorsa()` estratta, cosi' pulsante e tastiera fanno la
stessa cosa; **Canc** elimina la corsa selezionata, perche' in un editor
grafico e' li' che uno lo cerca e quella barra porta ormai una decina di cose;
il messaggio distingue la corsa vera («Salva modifiche per confermare
l'eliminazione») dalla copia mai salvata («Copia scartata: non era ancora stata
salvata»), perche' mandare qualcuno a cercare sul server una corsa che non
c'e' mai stata e' una bugia.

## «Dimmi tu dove cazzo vedi il tasto elimina»

Aveva ragione, e la risposta e' che il tasto stava in un posto irraggiungibile.

**La selezione voleva il DOPPIO CLIC.** Un clic singolo su una corsa iniziava
il trascinamento e, se non si trascinava, non faceva niente di visibile. Tutti
i comandi della corsa — duplica, elimina, orario di partenza, orario del nodo —
vivono nella barra fluttuante che compare **solo** con una corsa selezionata.
Quindi: clicco, non succede niente, il tasto non esiste. Il promemoria in fondo
allo schermo diceva «doppio clic = seleziona» in grigio su nero, otto pixel.

Due correzioni:

1. **Il clic seleziona.** Nel `onPointerUp`, quando il trascinamento finisce con
   spostamento zero, la corsa si seleziona. Il trascinamento continua a
   funzionare, e il doppio clic resta perche' in piu' seleziona il nodo.
2. **Pannello «Corsa» nella barra STRUMENTI**, per primo, sopra Validita'.
   Quella barra e' il posto dove uno guarda: ora ci sono Duplica, Copia piu'
   volte ed Elimina, e quando non c'e' niente di selezionato il pannello dice
   come selezionare invece di stare vuoto. Per le corse di un altro percorso
   (sovrapposizioni) spiega che si modificano aprendo il loro percorso, invece
   di mostrare pulsanti che non farebbero niente.

Anche il promemoria della barra di stato ora dice il vero: «clic corsa =
seleziona · drag corsa = trasla · doppio clic sul pallino = transito · Canc =
elimina».

**Lezione**: un comando che esiste solo dentro un pannello che compare a una
condizione non ovvia, per chi lo usa **non esiste**. Prima di aggiungere un
pulsante conviene chiedersi se quello che c'e' gia' e' raggiungibile.

## Il tasto destro, che e' dove uno lo cerca

«NON C'E'! metti che clicco con il destro e compare il tasto elimina e
duplica.» Aveva ragione due volte: la prima perche' i comandi stavano dietro
una selezione che nessuno sapeva di dover fare, la seconda perche' la mia
risposta — «adesso il clic seleziona, e c'e' un pannello nella barra» — era
ancora una cosa da imparare invece di una cosa che funziona e basta.

Ora il **tasto destro su una corsa** apre il menu li' dove si clicca: Duplica,
Copia piu' volte, Elimina. Nessuno stato da indovinare, nessuna barra da
trovare. Il clic destro seleziona anche la corsa, cosi' dopo si puo'
proseguire con gli altri comandi.

Dettagli che sarebbero diventati il prossimo «non funziona»:

- il listener che chiude il menu e' in **risalita, non in cattura**: in cattura
  scatterebbe PRIMA del clic sul pulsante, chiuderebbe il menu e il comando non
  partirebbe mai — un menu che si chiude senza fare niente;
- il menu si **riposiziona** per restare dentro il riquadro: aperto sul bordo
  destro o in fondo, meta' finirebbe fuori e i comandi sarebbero di nuovo
  irraggiungibili;
- il tasto destro non fa partire il trascinamento (`e.button !== 0` era gia'
  li'), e l'area di presa e' la fascia invisibile da 8 px che esisteva gia' per
  l'hover: non serve centrare il tratto;
- sullo **sfondo** il menu del browser resta quello di sempre: si intercetta
  solo il clic su una corsa;
- su una corsa di un altro percorso il menu lo dice invece di mostrare comandi
  che non farebbero niente.

## In sospeso

- **Rigenerare le relazioni gia' salvate**: quelle prodotte prima di oggi portano il costo guida doppio e il costo vetture al lordo.
- **Chiedere all'operatore se il tetto dei semiunici puo' salire**: e' saturo in ogni giro (6/6 in BB e AX, 5/5 in AY) ed e' il vincolo che decide il numero di turni, cioe' il 72% del costo.
- **L'escalation dei giunti non scende mai**, nemmeno quando il piano torna in regola. Da decidere con un giro.
- **Il taglio che vieta il proprio suggerimento**: `forbidden_arc_sets` contiene anche l'insieme d'archi del campione, che poi viene suggerito come warm start agli scenari di intensificazione. Preesistente, tocca ogni giro VSP.
- **Il grappolo come mattone** (da AY): la mappa valuta la traslazione di un grappolo di linee legate da coincidenze (31: 3, 30, 42, 24; 2/6: 7, 11, 21/33, 1/4) e la sonda lo prova come candidato unico.
- AY: cruscotto 0 violazioni, tabella round 1 sul round 6 — capire quale dei due mente.
- La sonda in AX ha usato tre sonde su dieci perche' la coda dei candidati si e' svuotata (lista di linea a quattro, tre morti nel filtro): la coda non deve svuotarsi finche' c'e' budget, e il motivo del rifiuto deve indicare la mossa successiva (delta alternativo della stessa linea).
- Leggere le undici violazioni del round 5 di AX (37 turni): se sono soste al capolinea, e' il cuscinetto del giro rigido a decidere.
- Esperimento sulla pazienza dell'early-stop (`earlyStopPatience: 3`) appena il catalogo MCP espone la manopola.
- Ruotare la chiave di scrittura MCP (`MCP_WRITE_KEY`) a fine giornata: mai incollarla in chat.
- Decidere sulle tre proposte del quadro (3R 20:47, 30A 21:12, 3R 08:17) e sullo spostamento di 15′ proposto dalla sonda del giro Y.
- Leggere l'audit festivo completo con `ti_round_trip_audit` (dalla salute: 16 anomalie su 362 corse prima delle correzioni).
